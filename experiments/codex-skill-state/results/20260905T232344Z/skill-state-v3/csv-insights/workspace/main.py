#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def fail(message: str) -> NoReturn:
    raise CsvInsightsError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            fail(f"malformed filter {expression!r}: expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if not column:
            fail(f"malformed filter {expression!r}: column name must not be empty")
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                fail("input CSV is empty; a header row is required")

            if not header:
                fail("header row must contain at least one column")
            empty_positions = [str(index) for index, name in enumerate(header, start=1) if name == ""]
            if empty_positions:
                fail(f"header names must be non-empty (column {', '.join(empty_positions)})")

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in header:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                fail("header names must be unique; duplicate: " + ", ".join(repr(x) for x in duplicates))

            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    fail(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append(row)
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        line = getattr(locals().get("reader"), "line_num", None)
        location = f" near physical line {line}" if line else ""
        fail(f"malformed CSV{location}: {exc}")
    except UnicodeError as exc:
        fail(f"input is not valid UTF-8: {exc}")
    except OSError as exc:
        fail(f"cannot read {path}: {exc}")


def validate_columns(
    header: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> None:
    known = set(header)
    referenced = [column for column, _ in filters]
    referenced.extend(column for column in (group_by, sum_column, avg_column) if column is not None)
    for column in referenced:
        if column not in known:
            fail(f"unknown column: {column!r}")


def decimal_value(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        fail(f"row {record_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        fail(f"row {record_number}, column {column!r}: invalid numeric value {value!r}")
    if not number.is_finite():
        fail(f"row {record_number}, column {column!r}: invalid numeric value {value!r}")
    return number


def decimal_precision(values: Sequence[Decimal]) -> int:
    """Return a context precision generous enough for exact finite addition."""
    if not values:
        return 28
    integer_digits = max(max(value.adjusted() + 1, 1) for value in values if value != 0) if any(values) else 1
    fractional_digits = max(max(-value.as_tuple().exponent, 0) for value in values)
    carry_digits = len(str(len(values)))
    return max(28, integer_digits + fractional_digits + carry_digits + 2)


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def filtered_rows(
    header: Sequence[str], rows: Sequence[list[str]], filters: Sequence[tuple[str, str]]
) -> list[list[str]]:
    indexes = [(header.index(column), expected) for column, expected in filters]
    return [row for row in rows if all(row[index] == expected for index, expected in indexes)]


def aggregate(
    header: Sequence[str],
    rows: Sequence[list[str]],
    group_by: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_by)
    numeric_columns = [column for column in (sum_column, avg_column) if column is not None]
    parsed: dict[str, list[tuple[Decimal, ...]]] = {}

    for record_number, row in enumerate(rows, start=2):
        values = tuple(decimal_value(row[header.index(column)], record_number, column) for column in numeric_columns)
        parsed.setdefault(row[group_index], []).append(values)

    output_header = [group_by]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    sum_position = numeric_columns.index(sum_column) if sum_column is not None else None
    avg_position = numeric_columns.index(avg_column) if avg_column is not None else None
    for group in sorted(parsed):
        group_values = parsed[group]
        result = [group]
        all_numbers = [number for item in group_values for number in item]
        with localcontext() as context:
            context.prec = decimal_precision(all_numbers)
            if sum_position is not None:
                total = sum((item[sum_position] for item in group_values), Decimal(0))
                result.append(format_decimal(total))
            if avg_position is not None:
                total = sum((item[avg_position] for item in group_values), Decimal(0))
                result.append(format_decimal(total / Decimal(len(group_values))))
        output_rows.append(result)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    objects = [OrderedDict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")

    try:
        filters = parse_filters(args.where)
        header, rows = read_csv(Path(args.input))
        validate_columns(header, filters, args.group_by, args.sum_column, args.avg_column)
        selected = filtered_rows(header, rows, filters)
        if args.group_by:
            output_header, output_rows = aggregate(
                header, selected, args.group_by, args.sum_column, args.avg_column
            )
        else:
            output_header, output_rows = header, selected
        if args.output == "json":
            emit_json(output_header, output_rows, sys.stdout)
        else:
            emit_csv(output_header, output_rows, sys.stdout)
        return 0
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())

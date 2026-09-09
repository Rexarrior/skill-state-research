#!/usr/bin/env python3
"""Filter and aggregate CSV files from the command line."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-4180-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def validate_headers(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
    if empty_positions:
        joined = ", ".join(empty_positions)
        raise CsvInsightsError(f"header names must be non-empty (column {joined})")

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header names must be unique (duplicate: {names})")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column must be non-empty"
            )
        filters.append((column, value))
    return filters


def require_columns(header: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty") from None

            validate_headers(header)
            rows: list[tuple[int, list[str]]] = []
            for logical_row, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {logical_row} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((logical_row, row))
            return header, rows
    except CsvInsightsError:
        raise
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from exc


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_text(number: Decimal) -> str:
    if number == 0:
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def exact_total(numbers: Sequence[Decimal]) -> Decimal:
    """Add finite decimals without the default context rounding large totals."""
    if not numbers:
        return Decimal(0)

    minimum_exponent = min(number.as_tuple().exponent for number in numbers)
    maximum_adjusted = max(number.adjusted() for number in numbers)
    carry_digits = len(str(len(numbers)))
    precision = max(28, maximum_adjusted - minimum_exponent + carry_digits + 1)
    with localcontext() as context:
        context.prec = precision
        return sum(numbers, Decimal(0))


def filtered_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), value) for column, value in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == value for index, value in indexes)
    ]


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    sum_index = header.index(sum_column) if sum_column is not None else None
    avg_index = header.index(avg_column) if avg_column is not None else None
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = row[group_index]
        values = groups.setdefault(group, {"sum": [], "avg": []})
        if sum_column is not None and sum_index is not None:
            values["sum"].append(
                parse_decimal(row[sum_index], row_number, sum_column)
            )
        if avg_column is not None and avg_index is not None:
            values["avg"].append(
                parse_decimal(row[avg_index], row_number, avg_column)
            )

    output_header = [group_column]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        values = groups[group]
        output_row = [group]
        if sum_column is not None:
            output_row.append(decimal_text(exact_total(values["sum"])))
        if avg_column is not None:
            numbers = values["avg"]
            total = exact_total(numbers)
            sum_precision = max(28, len(total.as_tuple().digits) + 28)
            with localcontext() as context:
                context.prec = sum_precision
                average = total / len(numbers)
            output_row.append(decimal_text(average))
        output_rows.append(output_row)
    return output_header, output_rows


def write_output(header: Sequence[str], rows: Sequence[Sequence[str]], output: str) -> None:
    if output == "csv":
        writer = csv.writer(sys.stdout, lineterminator="\r\n")
        writer.writerow(header)
        writer.writerows(rows)
        return

    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")

    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    selected = filtered_rows(header, numbered_rows, filters)

    if args.group_by:
        output_header, output_rows = aggregate(
            header, selected, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = header
        output_rows = [row for _, row in selected]
    write_output(output_header, output_rows, args.output)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

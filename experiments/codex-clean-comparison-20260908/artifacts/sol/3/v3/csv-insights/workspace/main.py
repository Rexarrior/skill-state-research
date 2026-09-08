#!/usr/bin/env python3
"""CSV Insights: dependency-free filtering and decimal aggregation."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    """Argument parser whose errors remain concise and consistently formatted."""

    def error(self, message: str) -> NoReturn:
        raise CsvInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate CSV data.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def parse_filters(values: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in values:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(fieldnames: list[str] | None) -> list[str]:
    if fieldnames is None:
        raise CsvInsightsError("input CSV is empty; a header row is required")

    empty_positions = [str(index + 1) for index, name in enumerate(fieldnames) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty "
            f"(empty header at column {', '.join(empty_positions)})"
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in fieldnames:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique "
            f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
        )
    return fieldnames


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    header_set = set(headers)
    for column in columns:
        if column not in header_set:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_rows(stream: TextIO) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        reader = csv.reader(stream, strict=True)
        try:
            headers = validate_headers(next(reader, None))
        except StopIteration:  # Defensive: next(..., None) does not normally raise.
            headers = validate_headers(None)

        rows: list[tuple[int, dict[str, str]]] = []
        for record_number, values in enumerate(reader, start=2):
            if len(values) != len(headers):
                raise CsvInsightsError(
                    f"row {record_number} has {len(values)} fields; "
                    f"expected {len(headers)}"
                )
            rows.append((record_number, dict(zip(headers, values))))
        return headers, rows
    except csv.Error as exc:
        line = getattr(reader, "line_num", 0)
        location = f" near physical line {line}" if line else ""
        raise CsvInsightsError(f"malformed CSV{location}: {exc}") from exc


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    """Return a finite Decimal without exponent notation or redundant zeroes."""
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        parsed = {
            column: decimal_value(row[column], row_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(group_by and row[group_by], {column: [] for column in numeric_columns})
        for column, number in parsed.items():
            group[column].append(number)

    output_headers = [group_by]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)

    results: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result = {group_by: group_value}
        for column in sum_columns:
            result[f"sum_{column}"] = format_decimal(sum(values[column], Decimal(0)))
        for column in avg_columns:
            total = sum(values[column], Decimal(0))
            result[f"avg_{column}"] = format_decimal(total / len(values[column]))
        results.append(result)
    return output_headers, results


def write_output(
    headers: Sequence[str], rows: Sequence[dict[str, str]], output: str, stream: TextIO
) -> None:
    if output == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)

    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    path = Path(args.input)
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            headers, numbered_rows = read_rows(stream)
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {args.input!r}: {exc}") from exc

    referenced = [column for column, _ in filters]
    if args.group_by is not None:
        referenced.append(args.group_by)
    referenced.extend(args.sum_columns)
    referenced.extend(args.avg_columns)
    require_columns(headers, referenced)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.sum_columns or args.avg_columns:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    try:
        write_output(output_headers, output_rows, args.output, sys.stdout)
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot write output: {exc}") from exc
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

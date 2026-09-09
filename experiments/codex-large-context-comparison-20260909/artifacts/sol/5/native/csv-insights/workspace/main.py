#!/usr/bin/env python3
"""CSV Insights: filter and aggregate CSV files from the command line."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    """Argument parser that reports errors through the application's error path."""

    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter rows and calculate grouped sums and averages.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
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


def validate_columns(headers: Sequence[str], columns: Sequence[tuple[str, str]]) -> None:
    known = set(headers)
    for option, column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} for {option}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        source = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open {path}: {exc}") from exc

    try:
        with source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty") from exc

            if not headers:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(index) for index, value in enumerate(headers, 1) if value == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty header at column {', '.join(empty_positions)})"
                )

            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                rendered = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"header names must be unique (duplicate: {rendered})")

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
    except csv.Error as exc:
        line_number = getattr(reader, "line_num", "unknown")
        raise CsvInsightsError(f"malformed CSV near line {line_number}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    return headers, rows


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
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


def decimal_precision(values: Sequence[Decimal]) -> int:
    """Return enough context precision to add all finite values without rounding."""
    if not values:
        return 28
    largest_integer = max(max(value.adjusted() + 1, 0) for value in values)
    largest_fraction = max(max(-value.as_tuple().exponent, 0) for value in values)
    carry_digits = math.ceil(math.log10(len(values) + 1))
    return max(28, largest_integer + largest_fraction + carry_digits + 1)


def decimal_string(value: Decimal) -> str:
    """Format a finite Decimal without exponent notation or insignificant zeroes."""
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column in numeric_columns:
            group[column].append(parse_decimal(row[column], row_number, column))

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")
    if len(output_headers) != len(set(output_headers)):
        raise CsvInsightsError(
            "generated aggregate column name conflicts with the group-by column"
        )

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values_by_column = groups[group_value]
        output_row = {group_column: group_value}
        if sum_column:
            values = values_by_column[sum_column]
            with localcontext() as context:
                context.prec = decimal_precision(values)
                total = sum(values, Decimal(0))
            output_row[f"sum_{sum_column}"] = decimal_string(total)
        if avg_column:
            values = values_by_column[avg_column]
            with localcontext() as context:
                context.prec = decimal_precision(values)
                average = sum(values, Decimal(0)) / Decimal(len(values))
            output_row[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(output_row)

    return output_headers, output_rows


def write_output(headers: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return

    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=headers,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(Path(args.input))

    referenced_columns = [("--where", column) for column, _ in filters]
    referenced_columns.extend(
        (option, column)
        for option, column in (
            ("--group-by", args.group_by),
            ("--sum", args.sum_column),
            ("--avg", args.avg_column),
        )
        if column is not None
    )
    validate_columns(headers, referenced_columns)

    filtered_rows = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.sum_column or args.avg_column:
        output_headers, output_rows = aggregate_rows(
            filtered_rows,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered_rows]

    write_output(output_headers, output_rows, args.output)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

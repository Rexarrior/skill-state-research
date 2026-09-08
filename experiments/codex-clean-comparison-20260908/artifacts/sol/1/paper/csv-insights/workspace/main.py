#!/usr/bin/env python3
"""Dependency-free command-line analytics for CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
import sys
from pathlib import Path
from typing import NoReturn, TextIO


class CsvInsightsError(Exception):
    """An input or usage error suitable for display to the user."""


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    args = parser.parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


def parse_filters(raw_filters: list[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str] | None) -> list[str]:
    if headers is None:
        raise CsvInsightsError("input has no header row")
    if not headers:
        raise CsvInsightsError("input header row is empty")
    for index, header in enumerate(headers, start=1):
        if header == "":
            raise CsvInsightsError(f"header column {index} is empty")
    seen: set[str] = set()
    for header in headers:
        if header in seen:
            raise CsvInsightsError(f"duplicate header {header!r}")
        seen.add(header)
    return headers


def require_columns(headers: list[str], requested: list[tuple[str, str]]) -> None:
    known = set(headers)
    for column, usage in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} used by {usage}")


def read_rows(stream: TextIO) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(stream, strict=True)
    try:
        headers = validate_headers(next(reader, None))
        rows: list[tuple[int, dict[str, str]]] = []
        for row in reader:
            record_number = reader.line_num
            if len(row) != len(headers):
                raise CsvInsightsError(
                    f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                )
            rows.append((record_number, dict(zip(headers, row))))
        return headers, rows
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from exc


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate(
    rows: list[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: list[str],
    avg_columns: list[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(sum_columns + avg_columns))
    groups: dict[str, tuple[dict[str, Decimal], dict[str, int]]] = {}
    for row_number, row in rows:
        values = {
            column: decimal_value(row[column], row_number, column)
            for column in numeric_columns
        }
        sums, counts = groups.setdefault(
            row[group_by],
            ({column: Decimal(0) for column in numeric_columns}, {column: 0 for column in numeric_columns}),
        )
        for column, value in values.items():
            sums[column] += value
            counts[column] += 1

    output_headers = [group_by]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        sums, counts = groups[group]
        result = {group_by: group}
        for column in sum_columns:
            result[f"sum_{column}"] = format_decimal(sums[column])
        for column in avg_columns:
            result[f"avg_{column}"] = format_decimal(sums[column] / counts[column])
        output_rows.append(result)
    return output_headers, output_rows


def emit(headers: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: list[str]) -> None:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    try:
        with Path(args.input).open("r", encoding="utf-8", newline="") as stream:
            headers, numbered_rows = read_rows(stream)
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {args.input!r}: {exc}") from exc

    requested = [(column, "--where") for column, _ in filters]
    requested.extend((column, "--group-by") for column in ([args.group_by] if args.group_by else []))
    requested.extend((column, "--sum") for column in args.sum_columns)
    requested.extend((column, "--avg") for column in args.avg_columns)
    require_columns(headers, requested)

    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]
    if args.sum_columns or args.avg_columns:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]
    emit(output_headers, output_rows, args.output)


def main() -> None:
    try:
        run(sys.argv[1:])
    except CsvInsightsError as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()

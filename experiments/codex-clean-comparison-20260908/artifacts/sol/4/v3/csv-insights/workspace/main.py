#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sys
from typing import Iterable, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


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
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
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


def validate_headers(headers: Sequence[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if not name]
    if empty_positions:
        raise CsvInsightsError(
            "header names cannot be empty (field " + ", ".join(empty_positions) + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CsvInsightsError(
            "duplicate header name(s): " + ", ".join(repr(name) for name in duplicates)
        )


def require_known_columns(headers: Sequence[str], columns: Iterable[str | None]) -> None:
    known = set(headers)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def read_filtered_rows(
    stream: TextIO, filters: Sequence[tuple[str, str]]
) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(stream, strict=True)
    try:
        try:
            headers = next(reader)
        except StopIteration:
            raise CsvInsightsError("input has no header row") from None
        validate_headers(headers)
        require_known_columns(headers, (column for column, _ in filters))
        filtered: list[tuple[int, dict[str, str]]] = []
        for row_number, fields in enumerate(reader, start=2):
            if len(fields) != len(headers):
                raise CsvInsightsError(
                    f"row {row_number}: expected {len(headers)} fields, got {len(fields)}"
                )
            row = dict(zip(headers, fields))
            if all(row[column] == value for column, value in filters):
                filtered.append((row_number, row))
        return list(headers), filtered
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near input line {reader.line_num}: {exc}") from None


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c is not None))
    groups: dict[str, dict[str, object]] = {}
    for row_number, row in rows:
        values = {
            column: decimal_value(row[column], row_number, column)
            for column in numeric_columns
        }
        key = row[group_column]
        if key not in groups:
            groups[key] = {
                "totals": {column: Decimal(0) for column in numeric_columns},
                "count": 0,
            }
        group = groups[key]
        totals = group["totals"]
        assert isinstance(totals, dict)
        for column, value in values.items():
            totals[column] += value
        group["count"] = int(group["count"]) + 1

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for key in sorted(groups):
        group = groups[key]
        totals = group["totals"]
        count = int(group["count"])
        assert isinstance(totals, dict)
        result = {group_column: key}
        if sum_column is not None:
            result[f"sum_{sum_column}"] = format_decimal(totals[sum_column])
        if avg_column is not None:
            result[f"avg_{avg_column}"] = format_decimal(totals[avg_column] / count)
        output_rows.append(result)
    return output_headers, output_rows


def emit(headers: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    filters = parse_filters(args.where)
    path = Path(args.input)
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            headers, numbered_rows = read_filtered_rows(stream, filters)
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {str(path)!r}: {exc}") from None

    require_known_columns(
        headers,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    if args.sum_column or args.avg_column:
        output_headers, rows = aggregate_rows(
            numbered_rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        rows = [row for _, row in numbered_rows]
    emit(output_headers, rows, args.output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

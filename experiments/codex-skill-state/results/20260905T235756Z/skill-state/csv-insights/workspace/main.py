#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO


class UserError(Exception):
    """An input or command-line error that should be shown without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-4180-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def validate_headers(headers: list[str]) -> None:
    if any(header == "" for header in headers):
        raise UserError("CSV headers must be non-empty")
    duplicates = sorted({header for header in headers if headers.count(header) > 1})
    if duplicates:
        raise UserError(f"duplicate CSV header: {duplicates[0]!r}")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise UserError(
                f"malformed filter {raw_filter!r}; expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {raw_filter!r}; column must be non-empty"
            )
        filters.append((column, value))
    return filters


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise UserError(f"unknown column: {column!r}")


def read_csv(source: TextIO) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(source, strict=True)
    try:
        headers = next(reader)
    except StopIteration as exc:
        raise UserError("input CSV is empty") from exc
    except csv.Error as exc:
        raise UserError(f"malformed CSV header: {exc}") from exc

    validate_headers(headers)
    rows: list[tuple[int, dict[str, str]]] = []
    try:
        for record_number, fields in enumerate(reader, start=2):
            if len(fields) != len(headers):
                raise UserError(
                    f"row {record_number} has {len(fields)} fields; "
                    f"expected {len(headers)}"
                )
            rows.append((record_number, dict(zip(headers, fields))))
    except csv.Error as exc:
        raise UserError(f"malformed CSV near line {reader.line_num}: {exc}") from exc
    return headers, rows


def decimal_string(value: Decimal) -> str:
    """Return a finite Decimal without exponent notation or redundant zeroes."""
    if not value.is_finite():
        raise InvalidOperation
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in ("", "-0"):
        return "0"
    return rendered


def parse_number(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
        if not number.is_finite():
            raise InvalidOperation
        return number
    except InvalidOperation as exc:
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for row_number, row in rows:
        group = groups.setdefault(row[group_by], {})
        for column in numeric_columns:
            number = parse_number(row[column], row_number, column)
            total, count = group.get(column, (Decimal(0), 0))
            group[column] = (total + number, count + 1)

    output_headers = [
        group_by,
        *(f"sum_{column}" for column in sum_columns),
        *(f"avg_{column}" for column in avg_columns),
    ]
    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result = {group_by: group_value}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(values[column][0])
        for column in avg_columns:
            total, count = values[column]
            result[f"avg_{column}"] = decimal_string(total / count)
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]], destination: TextIO) -> None:
    json.dump(rows, destination, ensure_ascii=False)
    destination.write("\n")


def emit_csv(
    headers: Sequence[str], rows: Sequence[dict[str, str]], destination: TextIO
) -> None:
    writer = csv.DictWriter(
        destination,
        fieldnames=headers,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace, destination: TextIO) -> None:
    has_aggregation = bool(args.sum_columns or args.avg_columns)
    if has_aggregation and not args.group_by:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by and not has_aggregation:
        raise UserError("--group-by requires --sum and/or --avg")

    filters = parse_filters(args.where)
    try:
        with Path(args.input).open("r", encoding="utf-8", newline="") as source:
            headers, numbered_rows = read_csv(source)
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot read {args.input!r}: {exc}") from exc

    requested_columns = [
        *(column for column, _ in filters),
        *([args.group_by] if args.group_by else []),
        *args.sum_columns,
        *args.avg_columns,
    ]
    require_columns(headers, requested_columns)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == expected for column, expected in filters)
    ]

    if has_aggregation:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows, destination)
    else:
        emit_csv(output_headers, output_rows, destination)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args, sys.stdout)
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

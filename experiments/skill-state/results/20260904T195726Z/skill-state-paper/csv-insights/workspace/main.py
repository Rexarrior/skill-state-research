#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, TextIO


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows with an exact string match (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args()
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        parser.error("--group-by requires --sum or --avg")
    return args


def parse_filters(raw_filters: list[str]) -> list[tuple[str, str]]:
    filters = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            fail(f"malformed filter {raw_filter!r}; expected COLUMN=VALUE")
        column, value = raw_filter.split("=", 1)
        if not column:
            fail(f"malformed filter {raw_filter!r}; column must not be empty")
        filters.append((column, value))
    return filters


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        source = open(path, "r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        fail(f"cannot open {path!r}: {exc}")

    with source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader)
        except StopIteration:
            fail("input is empty; a header row is required")
        except (csv.Error, UnicodeError) as exc:
            fail(f"malformed CSV header: {exc}")

        if not header or any(column == "" for column in header):
            fail("headers must be non-empty")
        duplicates = sorted({column for column in header if header.count(column) > 1})
        if duplicates:
            fail(f"headers must be unique; duplicate: {duplicates[0]!r}")

        rows = []
        try:
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    fail(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
        except (csv.Error, UnicodeError) as exc:
            fail(f"malformed CSV near row {reader.line_num}: {exc}")
    return header, rows


def require_columns(header: list[str], columns: list[str]) -> None:
    for column in columns:
        if column not in header:
            fail(f"unknown column: {column!r}")


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate(
    header: list[str],
    rows: list[tuple[int, list[str]]],
    group_by: str,
    sum_columns: list[str],
    avg_columns: list[str],
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_by)
    numeric_columns = list(dict.fromkeys(sum_columns + avg_columns))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for record_number, row in rows:
        values: dict[str, Decimal] = {}
        for column, index in numeric_indexes.items():
            raw_value = row[index]
            try:
                value = Decimal(raw_value)
            except InvalidOperation:
                fail(f"row {record_number}, column {column!r}: invalid numeric value {raw_value!r}")
            if not value.is_finite():
                fail(f"row {record_number}, column {column!r}: numeric value must be finite")
            values[column] = value

        totals = groups.setdefault(row[group_index], {})
        for column, value in values.items():
            total, count = totals.get(column, (Decimal(0), 0))
            totals[column] = (total + value, count + 1)

    output_header = [group_by]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    output_rows = []
    for group in sorted(groups):
        totals = groups[group]
        output_row = [group]
        output_row.extend(decimal_string(totals[column][0]) for column in sum_columns)
        output_row.extend(
            decimal_string(totals[column][0] / totals[column][1]) for column in avg_columns
        )
        output_rows.append(output_row)
    return output_header, output_rows


def emit_json(header: list[str], rows: list[list[str]], stream: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def emit_csv(header: list[str], rows: list[list[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)


def main() -> None:
    args = parse_args()
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    if args.group_by:
        requested_columns.append(args.group_by)
    require_columns(header, requested_columns)

    indexes = [(header.index(column), value) for column, value in filters]
    filtered = [
        (record_number, row)
        for record_number, row in numbered_rows
        if all(row[index] == value for index, value in indexes)
    ]

    if args.group_by:
        output_header, output_rows = aggregate(
            header, filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_header = header
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_header, output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)


if __name__ == "__main__":
    main()

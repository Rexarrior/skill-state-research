#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
import sys
from pathlib import Path
from typing import NoReturn, TextIO


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def parse_filter(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("filters must have the form COLUMN=VALUE")
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError("filter column must not be empty")
    return column, expected


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate a CSV file without modifying it."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where", action="append", default=[], type=parse_filter, metavar="COLUMN=VALUE"
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


def read_rows(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        stream = path.open("r", encoding="utf-8", newline="")
    except OSError as exc:
        fail(f"cannot open {path}: {exc}")

    with stream:
        reader = csv.reader(stream, strict=True)
        try:
            header = next(reader)
        except StopIteration:
            fail("input CSV is empty")
        except (csv.Error, UnicodeError) as exc:
            fail(f"malformed CSV header: {exc}")

        if not header or any(name == "" for name in header):
            fail("headers must be non-empty")
        duplicates = sorted({name for name in header if header.count(name) > 1})
        if duplicates:
            fail(f"headers must be unique; duplicate: {duplicates[0]!r}")

        rows: list[tuple[int, dict[str, str]]] = []
        try:
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(header):
                    fail(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, dict(zip(header, fields))))
        except (csv.Error, UnicodeError) as exc:
            fail(f"malformed CSV near row {reader.line_num}: {exc}")
    return header, rows


def validate_columns(args: argparse.Namespace, header: list[str]) -> None:
    requested = [column for column, _ in args.where]
    requested.extend(args.sum_columns)
    requested.extend(args.avg_columns)
    if args.group_by:
        requested.append(args.group_by)
    for column in requested:
        if column not in header:
            fail(f"unknown column: {column!r}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        fail(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation:
        fail(f"row {row_number}, column {column!r}: invalid numeric value {value!r}")
    if not number.is_finite():
        fail(f"row {row_number}, column {column!r}: non-finite numeric value {value!r}")
    return number


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def aggregate(
    rows: list[tuple[int, dict[str, str]]], args: argparse.Namespace
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(args.sum_columns + args.avg_columns))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        group = row[args.group_by]
        values = {
            column: decimal_value(row[column], row_number, column)
            for column in numeric_columns
        }
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column, value in values.items():
            bucket[column].append(value)

    output_header = [args.group_by]
    output_header.extend(f"sum_{column}" for column in args.sum_columns)
    output_header.extend(f"avg_{column}" for column in args.avg_columns)
    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {args.group_by: group}
        for column in args.sum_columns:
            result[f"sum_{column}"] = format_decimal(sum(groups[group][column], Decimal()))
        for column in args.avg_columns:
            values = groups[group][column]
            result[f"avg_{column}"] = format_decimal(
                sum(values, Decimal()) / Decimal(len(values))
            )
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: list[dict[str, str]], stream: TextIO) -> None:
    json.dump(rows, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def emit_csv(header: list[str], rows: list[dict[str, str]], stream: TextIO) -> None:
    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    header, numbered_rows = read_rows(args.input)
    validate_columns(args, header)
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == expected for column, expected in args.where)
    ]

    if args.group_by:
        output_header, rows = aggregate(filtered, args)
    else:
        output_header = header
        rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(rows, sys.stdout)
    else:
        emit_csv(output_header, rows, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

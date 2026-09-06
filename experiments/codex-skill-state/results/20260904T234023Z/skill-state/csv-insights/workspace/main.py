#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable


def fail(message: str) -> None:
    raise ValueError(message)


def parse_filter(value: str) -> tuple[str, str]:
    if "=" not in value:
        fail(f"malformed filter {value!r}: expected COLUMN=VALUE")
    column, expected = value.split("=", 1)
    if not column:
        fail(f"malformed filter {value!r}: column name is empty")
    return column, expected


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                fail("input CSV is empty; expected a header row")
            if not headers or any(not header for header in headers):
                fail("CSV headers must be non-empty")
            duplicates = sorted({h for h in headers if headers.count(h) > 1})
            if duplicates:
                fail("CSV headers must be unique: " + ", ".join(duplicates))

            rows: list[tuple[int, list[str]]] = []
            for row in reader:
                if len(row) != len(headers):
                    fail(
                        f"row {reader.line_num} has {len(row)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((reader.line_num, row))
            return headers, rows
    except FileNotFoundError:
        fail(f"input file not found: {path}")
    except PermissionError:
        fail(f"cannot read input file: {path}")
    except UnicodeDecodeError as exc:
        fail(f"input is not valid UTF-8: {exc}")
    except csv.Error as exc:
        fail(f"malformed CSV near line {getattr(exc, 'line_num', '?')}: {exc}")
    raise AssertionError("unreachable")


def decimal_text(value: Decimal) -> str:
    # format(..., 'f') never uses exponent notation.  normalize then remove
    # insignificant trailing zeroes while retaining a plain zero.
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in {"", "-0"} else text


def decimal_at(row_number: int, column: str, value: str) -> Decimal:
    if value == "":
        fail(f"blank numeric value at row {row_number}, column {column!r}")
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        fail(f"invalid numeric value {value!r} at row {row_number}, column {column!r}")
    if not parsed.is_finite():
        fail(f"invalid numeric value {value!r} at row {row_number}, column {column!r}")
    return parsed


def validate_columns(headers: list[str], names: Iterable[str]) -> None:
    available = set(headers)
    for name in names:
        if name not in available:
            fail(f"unknown column: {name!r}")


def make_records(
    headers: list[str], rows: list[tuple[int, list[str]]], filters: list[tuple[str, str]]
) -> list[tuple[int, dict[str, str]]]:
    records = [(number, dict(zip(headers, row))) for number, row in rows]
    return [
        (number, record)
        for number, record in records
        if all(record[column] == expected for column, expected in filters)
    ]


def aggregate(
    records: list[tuple[int, dict[str, str]]], group_by: str, sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    groups: dict[str, list[tuple[int, dict[str, str]]]] = defaultdict(list)
    for record in records:
        groups[record[1][group_by]].append(record)

    columns = [group_by]
    if sum_column:
        columns.append(f"sum_{sum_column}")
    if avg_column:
        columns.append(f"avg_{avg_column}")
    result: list[dict[str, str]] = []
    for key in sorted(groups):
        items = groups[key]
        output = {group_by: key}
        if sum_column:
            total = sum((decimal_at(n, sum_column, row[sum_column]) for n, row in items), Decimal())
            output[f"sum_{sum_column}"] = decimal_text(total)
        if avg_column:
            total = sum((decimal_at(n, avg_column, row[avg_column]) for n, row in items), Decimal())
            output[f"avg_{avg_column}"] = decimal_text(total / Decimal(len(items)))
        result.append(output)
    return columns, result


def output_records(columns: list[str], records: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(records, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Filter and aggregate RFC-4180 CSV files.")
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE",
                        help="exact-match filter; may be repeated")
    parser.add_argument("--group-by", metavar="COLUMN", help="group results by this column")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="sum this numeric column")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="average this numeric column")
    parser.add_argument("--output", choices=("json", "csv"), default="json", help="output format (default: json)")
    return parser


def run(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        fail("--sum and --avg require --group-by")
    filters = [parse_filter(value) for value in args.where]
    headers, rows = read_csv(Path(args.input))
    validate_columns(headers, [column for column, _ in filters])
    validate_columns(headers, [column for column in (args.group_by, args.sum_column, args.avg_column) if column])
    records = make_records(headers, rows, filters)
    if args.group_by:
        columns, output = aggregate(records, args.group_by, args.sum_column, args.avg_column)
    else:
        columns, output = headers, [record for _, record in records]
    output_records(columns, output, args.output)


def main() -> int:
    try:
        run(build_parser().parse_args())
        return 0
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

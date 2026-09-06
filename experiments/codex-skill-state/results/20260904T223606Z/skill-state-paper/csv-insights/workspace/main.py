#!/usr/bin/env python3
"""A small, dependency-free command-line CSV analytics tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence


class CsvInsightsError(Exception):
    """An expected input or command-line error."""


def parse_filter(value: str) -> tuple[str, str]:
    """Parse COLUMN=VALUE, preserving all equals signs in VALUE."""
    if "=" not in value:
        raise argparse.ArgumentTypeError(
            f"malformed filter {value!r}; expected COLUMN=VALUE"
        )
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError(
            f"malformed filter {value!r}; column name must not be empty"
        )
    return column, expected


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Filter and aggregate RFC-4180 CSV data.")
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument("--where", action="append", type=parse_filter, default=[],
                        metavar="COLUMN=VALUE", help="keep rows with an exact value (repeatable)")
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
    parser.add_argument("--output", choices=("json", "csv"), default="json",
                        help="output format (default: json)")
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")
    return args


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    try:
        # newline='' is required by csv for embedded newlines and correct dialect handling.
        with Path(path).open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty; a header row is required") from None
            if not headers:
                raise CsvInsightsError("header row must contain at least one non-empty header")
            if any(not header for header in headers):
                raise CsvInsightsError("headers must be non-empty")
            duplicates = sorted({header for header in headers if headers.count(header) > 1})
            if duplicates:
                raise CsvInsightsError("headers must be unique: " + ", ".join(duplicates))

            rows: list[list[str]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
            return headers, rows
    except FileNotFoundError:
        raise CsvInsightsError(f"input file not found: {path}") from None
    except PermissionError:
        raise CsvInsightsError(f"cannot read input file: {path}") from None
    except (OSError, csv.Error) as error:
        raise CsvInsightsError(f"malformed CSV input: {error}") from None


def require_columns(headers: list[str], columns: Sequence[str]) -> None:
    available = set(headers)
    for column in columns:
        if column not in available:
            raise CsvInsightsError(f"unknown column: {column}")


def minimal_decimal(value: Decimal) -> str:
    """Render Decimal without exponent notation or redundant trailing zeroes."""
    if value == 0:
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def parse_decimal(cell: str, row_number: int, column: str) -> Decimal:
    if not cell:
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        value = Decimal(cell)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {cell!r}"
        ) from None
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {cell!r}"
        )
    return value


def build_output(headers: list[str], rows: list[list[str]], args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    indices = {header: index for index, header in enumerate(headers)}
    require_columns(headers, [column for column, _ in args.where])
    require_columns(headers, [column for column in (args.group_by, args.sum_column, args.avg_column) if column])

    filtered = [
        (row_number, row)
        for row_number, row in enumerate(rows, start=2)
        if all(row[indices[column]] == expected for column, expected in args.where)
    ]

    if not args.group_by:
        return headers, [dict(zip(headers, row)) for _, row in filtered]

    group_index = indices[args.group_by]
    sums: dict[str, Decimal] = defaultdict(Decimal)
    avg_sums: dict[str, Decimal] = defaultdict(Decimal)
    avg_counts: dict[str, int] = defaultdict(int)
    for row_number, row in filtered:
        group = row[group_index]
        if args.sum_column:
            sums[group] += parse_decimal(row[indices[args.sum_column]], row_number, args.sum_column)
        if args.avg_column:
            avg_sums[group] += parse_decimal(row[indices[args.avg_column]], row_number, args.avg_column)
            avg_counts[group] += 1

    output_headers = [args.group_by]
    if args.sum_column:
        output_headers.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_headers.append(f"avg_{args.avg_column}")
    output_rows: list[dict[str, str]] = []
    groups = set(sums) | set(avg_sums)
    for group in sorted(groups):
        item = {args.group_by: group}
        if args.sum_column:
            item[f"sum_{args.sum_column}"] = minimal_decimal(sums[group])
        if args.avg_column:
            item[f"avg_{args.avg_column}"] = minimal_decimal(avg_sums[group] / avg_counts[group])
        output_rows.append(item)
    return output_headers, output_rows


def emit(headers: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        headers, rows = read_csv(args.input)
        output_headers, output_rows = build_output(headers, rows, args)
        emit(output_headers, output_rows, args.output)
        return 0
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

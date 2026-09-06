#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence


class CsvInsightsError(Exception):
    """An input or usage error suitable for display to the user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
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
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum or --avg")
    return args


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except OSError as error:
        raise CsvInsightsError(f"cannot open {path}: {error}") from error

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration as error:
                raise CsvInsightsError("input CSV is empty") from error

            if not headers or any(header == "" for header in headers):
                raise CsvInsightsError("CSV headers must be non-empty")
            duplicates = sorted({h for h in headers if headers.count(h) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "CSV headers must be unique; duplicate: " + ", ".join(duplicates)
                )

            rows: list[tuple[int, list[str]]] = []
            for logical_row, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {logical_row} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append((logical_row, row))
            return headers, rows
    except (csv.Error, UnicodeError) as error:
        raise CsvInsightsError(f"malformed CSV: {error}") from error


def require_column(headers: list[str], column: str, option: str) -> int:
    try:
        return headers.index(column)
    except ValueError as error:
        raise CsvInsightsError(f"unknown column for {option}: {column!r}") from error


def parse_filters(filters: list[str], headers: list[str]) -> list[tuple[int, str]]:
    parsed: list[tuple[int, str]] = []
    for expression in filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column must be non-empty"
            )
        parsed.append((require_column(headers, column, "--where"), value))
    return parsed


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def numeric_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: blank numeric value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from error
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def process(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    headers, numbered_rows = read_csv(args.input)
    filters = parse_filters(args.where, headers)
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[index] == value for index, value in filters)
    ]

    if not args.group_by:
        return headers, [dict(zip(headers, row)) for _, row in filtered]

    group_index = require_column(headers, args.group_by, "--group-by")
    sum_index = (
        require_column(headers, args.sum_column, "--sum")
        if args.sum_column
        else None
    )
    avg_index = (
        require_column(headers, args.avg_column, "--avg")
        if args.avg_column
        else None
    )
    groups: dict[str, dict[str, Decimal | int]] = {}
    for row_number, row in filtered:
        group = groups.setdefault(
            row[group_index], {"sum": Decimal(0), "avg_sum": Decimal(0), "count": 0}
        )
        if sum_index is not None:
            group["sum"] += numeric_cell(
                row[sum_index], row_number, args.sum_column
            )
        if avg_index is not None:
            group["avg_sum"] += numeric_cell(
                row[avg_index], row_number, args.avg_column
            )
            group["count"] += 1

    output_headers = [args.group_by]
    if args.sum_column:
        output_headers.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_headers.append(f"avg_{args.avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result: dict[str, str] = OrderedDict([(args.group_by, group_value)])
        if args.sum_column:
            result[f"sum_{args.sum_column}"] = decimal_string(values["sum"])
        if args.avg_column:
            average = values["avg_sum"] / values["count"]
            result[f"avg_{args.avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_headers, output_rows


def emit(headers: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        headers, rows = process(args)
        emit(headers, rows, args.output)
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

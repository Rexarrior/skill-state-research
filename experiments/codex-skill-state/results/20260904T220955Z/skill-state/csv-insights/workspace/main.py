#!/usr/bin/env python3
"""CSV Insights: small dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence


class InsightsError(Exception):
    """An error which should be shown to the command-line user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Filter and aggregate a CSV file.")
    parser.add_argument("input", help="CSV input file")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE",
                        help="Keep rows whose column equals value (may be repeated).")
    parser.add_argument("--group-by", metavar="COLUMN", help="Column used to group aggregates.")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="Column to sum.")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="Column to average.")
    parser.add_argument("--output", choices=("json", "csv"), default="json",
                        help="Output format (default: json).")
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")
    return args


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    try:
        with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            try:
                headers = next(reader)
            except StopIteration:
                raise InsightsError("input CSV is empty")
            if not headers:
                raise InsightsError("CSV header row is empty")
            if any(not header for header in headers):
                raise InsightsError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InsightsError("CSV headers must be unique")
            rows: list[list[str]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise InsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
            return headers, rows
    except OSError as error:
        raise InsightsError(f"cannot read input file: {error}") from error
    except csv.Error as error:
        raise InsightsError(f"malformed CSV: {error}") from error


def require_column(column: str, headers: list[str]) -> None:
    if column not in headers:
        raise InsightsError(f"unknown column: {column}")


def parse_filters(values: list[str], headers: list[str]) -> list[tuple[int, str]]:
    filters: list[tuple[int, str]] = []
    for value in values:
        if "=" not in value:
            raise InsightsError(f"malformed filter {value!r}; expected COLUMN=VALUE")
        column, expected = value.split("=", 1)
        if not column:
            raise InsightsError(f"malformed filter {value!r}; column must not be empty")
        require_column(column, headers)
        filters.append((headers.index(column), expected))
    return filters


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if not value:
        raise InsightsError(f"invalid numeric value at row {row_number}, column {column!r}: blank")
    try:
        result = Decimal(value)
    except InvalidOperation:
        raise InsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from None
    if not result.is_finite():
        raise InsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return result


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value.normalize(), "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def filtered_rows(rows: list[list[str]], filters: list[tuple[int, str]]) -> list[tuple[int, list[str]]]:
    return [(number, row) for number, row in enumerate(rows, start=2)
            if all(row[index] == expected for index, expected in filters)]


def aggregate(headers: list[str], rows: list[tuple[int, list[str]]], args: argparse.Namespace) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(args.group_by)
    sum_index = headers.index(args.sum_column) if args.sum_column else None
    avg_index = headers.index(args.avg_column) if args.avg_column else None
    # value: [sum total, average total, average count]
    groups: dict[str, list[Decimal | int]] = {}
    for row_number, row in rows:
        key = row[group_index]
        state = groups.setdefault(key, [Decimal(0), Decimal(0), 0])
        if sum_index is not None:
            state[0] += decimal_value(row[sum_index], row_number, args.sum_column)
        if avg_index is not None:
            state[1] += decimal_value(row[avg_index], row_number, args.avg_column)
            state[2] += 1
    output_headers = [args.group_by]
    if args.sum_column:
        output_headers.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_headers.append(f"avg_{args.avg_column}")
    output_rows: list[list[str]] = []
    for key in sorted(groups):
        state = groups[key]
        result = [key]
        if args.sum_column:
            result.append(format_decimal(state[0]))
        if args.avg_column:
            result.append(format_decimal(state[1] / state[2]))
        output_rows.append(result)
    return output_headers, output_rows


def emit(headers: list[str], rows: list[list[str]], output: str) -> None:
    if output == "json":
        print(json.dumps([OrderedDict(zip(headers, row)) for row in rows], ensure_ascii=False))
    else:
        writer = csv.writer(sys.stdout, lineterminator="\n")
        writer.writerow(headers)
        writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    headers, rows = read_csv(args.input)
    for column in (args.group_by, args.sum_column, args.avg_column):
        if column:
            require_column(column, headers)
    filters = parse_filters(args.where, headers)
    selected = filtered_rows(rows, filters)
    if args.group_by:
        output_headers, output_rows = aggregate(headers, selected, args)
    else:
        output_headers = headers
        output_rows = [row for _, row in selected]
    emit(output_headers, output_rows, args.output)


def main() -> int:
    try:
        run()
        return 0
    except InsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

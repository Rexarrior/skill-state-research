#!/usr/bin/env python3
"""CSV Insights: filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error suitable for display to a command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter CSV rows and calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by is not None and not (args.sum_columns or args.avg_columns):
        raise CsvInsightsError("--group-by requires --sum or --avg")
    return args


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}; expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}; column must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str] | None) -> list[str]:
    if header is None:
        raise CsvInsightsError("input is empty; expected a header row")
    if not header:
        raise CsvInsightsError("header must contain at least one column")
    for position, name in enumerate(header, start=1):
        if name == "":
            raise CsvInsightsError(f"header column {position} is empty")
    duplicates = sorted({name for name in header if header.count(name) > 1})
    if duplicates:
        raise CsvInsightsError(f"duplicate header column: {duplicates[0]!r}")
    return header


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_string(value: Decimal) -> str:
    """Return a finite Decimal as a plain, minimal decimal string."""
    if not value.is_finite():
        raise ValueError("non-finite decimal")
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def numeric_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: numeric value is blank"
        )
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


def output_rows(fieldnames: Sequence[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def process(stream: TextIO, args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    reader = csv.reader(stream, strict=True)
    try:
        header = validate_header(next(reader, None))
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV header: {exc}") from None

    requested = [column for column, _ in filters]
    if args.group_by is not None:
        requested.append(args.group_by)
    requested.extend(args.sum_columns)
    requested.extend(args.avg_columns)
    require_columns(header, requested)
    indexes = {name: position for position, name in enumerate(header)}

    if args.group_by is None:
        rows: list[dict[str, str]] = []
        try:
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {row_number}: expected {len(header)} fields, got {len(row)}"
                    )
                if all(row[indexes[column]] == value for column, value in filters):
                    rows.append(dict(zip(header, row)))
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV near row {reader.line_num}: {exc}") from None
        output_rows(header, rows, args.output)
        return

    numeric_columns = list(dict.fromkeys(args.sum_columns + args.avg_columns))
    groups: dict[str, dict[str, object]] = {}
    try:
        for row_number, row in enumerate(reader, start=2):
            if len(row) != len(header):
                raise CsvInsightsError(
                    f"row {row_number}: expected {len(header)} fields, got {len(row)}"
                )
            if not all(row[indexes[column]] == value for column, value in filters):
                continue
            group = row[indexes[args.group_by]]
            bucket = groups.setdefault(
                group,
                {"count": 0, "totals": {column: Decimal(0) for column in numeric_columns}},
            )
            totals = bucket["totals"]
            assert isinstance(totals, dict)
            for column in numeric_columns:
                totals[column] += numeric_cell(row[indexes[column]], row_number, column)
            bucket["count"] = int(bucket["count"]) + 1
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near row {reader.line_num}: {exc}") from None

    result_columns = [args.group_by]
    result_columns.extend(f"sum_{column}" for column in args.sum_columns)
    result_columns.extend(f"avg_{column}" for column in args.avg_columns)
    result_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        bucket = groups[group]
        totals = bucket["totals"]
        count = int(bucket["count"])
        assert isinstance(totals, dict)
        result = {args.group_by: group}
        for column in args.sum_columns:
            result[f"sum_{column}"] = decimal_string(totals[column])
        for column in args.avg_columns:
            result[f"avg_{column}"] = decimal_string(totals[column] / count)
        result_rows.append(result)
    output_rows(result_columns, result_rows, args.output)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        path = Path(args.input)
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            process(stream, args)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

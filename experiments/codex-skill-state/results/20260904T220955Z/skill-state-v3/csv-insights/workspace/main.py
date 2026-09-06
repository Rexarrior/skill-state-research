#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files without third-party dependencies."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable, TextIO


class CSVInsightsError(Exception):
    """An expected input or argument error suitable for displaying to a user."""


def parse_filter(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("filter must have the form COLUMN=VALUE")
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError("filter column cannot be empty")
    return column, expected


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    try:
        with Path(path).open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CSVInsightsError("input CSV is empty") from None
            if not headers:
                raise CSVInsightsError("CSV header row is empty")
            empty_headers = [str(index + 1) for index, name in enumerate(headers) if name == ""]
            if empty_headers:
                raise CSVInsightsError("CSV headers must be non-empty (columns " + ", ".join(empty_headers) + ")")
            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                raise CSVInsightsError("CSV headers must be unique: " + ", ".join(duplicates))

            rows: list[list[str]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CSVInsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
            return headers, rows
    except OSError as error:
        raise CSVInsightsError(f"cannot read input file: {error}") from None
    except csv.Error as error:
        raise CSVInsightsError(f"malformed CSV: {error}") from None


def validate_columns(headers: list[str], filters: list[tuple[str, str]], args: argparse.Namespace) -> None:
    requested = [column for column, _ in filters]
    requested.extend(column for column in (args.group_by, args.sum, args.avg) if column is not None)
    unknown = sorted(set(requested) - set(headers))
    if unknown:
        raise CSVInsightsError("unknown column(s): " + ", ".join(unknown))
    if (args.sum or args.avg) and not args.group_by:
        raise CSVInsightsError("--sum and --avg require --group-by")


def filtered_records(
    headers: list[str], rows: Iterable[list[str]], filters: list[tuple[str, str]]
) -> list[dict[str, str]]:
    records = [dict(zip(headers, row)) for row in rows]
    return [
        record
        for record in records
        if all(record[column] == expected for column, expected in filters)
    ]


def display_decimal(value: Decimal) -> str:
    """Format a finite Decimal without exponent notation or insignificant zeros."""
    if value == 0:
        return "0"
    normalized = value.normalize()
    return format(normalized, "f")


def as_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CSVInsightsError(f"blank numeric value at row {row_number}, column '{column}'")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CSVInsightsError(f"invalid numeric value {value!r} at row {row_number}, column '{column}'") from None
    if not number.is_finite():
        raise CSVInsightsError(f"invalid numeric value {value!r} at row {row_number}, column '{column}'")
    return number


def aggregate(
    records: list[dict[str, str]], args: argparse.Namespace, source_row_numbers: list[int]
) -> list[dict[str, str]]:
    groups: OrderedDict[str, dict[str, Decimal | int]] = OrderedDict()
    for record, row_number in zip(records, source_row_numbers):
        group = record[args.group_by]
        state = groups.setdefault(group, {"count": 0})
        state["count"] = int(state["count"]) + 1
        for kind, column in (("sum", args.sum), ("avg", args.avg)):
            if column:
                state[kind] = Decimal(state.get(kind, Decimal(0))) + as_decimal(record[column], row_number, column)

    result: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        item = {args.group_by: group}
        if args.sum:
            item[f"sum_{args.sum}"] = display_decimal(Decimal(state["sum"]))
        if args.avg:
            item[f"avg_{args.avg}"] = display_decimal(Decimal(state["avg"]) / int(state["count"]))
        result.append(item)
    return result


def emit(records: list[dict[str, str]], columns: list[str], output: str, stream: TextIO) -> None:
    if output == "json":
        json.dump(records, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        return
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Filter and aggregate a CSV file.")
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument("--where", action="append", type=parse_filter, default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum", metavar="COLUMN")
    parser.add_argument("--avg", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        headers, rows = read_csv(args.input)
        validate_columns(headers, args.where, args)
        selected_rows = [row for row in rows if all(row[headers.index(col)] == expected for col, expected in args.where)]
        records = filtered_records(headers, selected_rows, [])
        if args.group_by:
            selected_set = {id(row) for row in selected_rows}
            source_row_numbers = [number for number, row in enumerate(rows, start=2) if id(row) in selected_set]
            output = aggregate(records, args, source_row_numbers) if (args.sum or args.avg) else records
            columns = ([args.group_by] + ([f"sum_{args.sum}"] if args.sum else []) + ([f"avg_{args.avg}"] if args.avg else [])) if (args.sum or args.avg) else headers
        else:
            output, columns = records, headers
        emit(output, columns, args.output, sys.stdout)
        return 0
    except CSVInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

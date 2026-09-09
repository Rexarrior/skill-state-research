#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CSVInsightsError(Exception):
    """An expected input or command-line validation error."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CSVInsightsError(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter CSV rows and calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows matching this exact value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")
    return args


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CSVInsightsError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CSVInsightsError(
                f"malformed filter {expression!r}: column name is empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers or any(header == "" for header in headers):
        raise CSVInsightsError("CSV headers must be non-empty")
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CSVInsightsError(f"CSV headers must be unique; duplicate: {names}")


def require_columns(headers: list[str], requested: Sequence[str | None]) -> None:
    known = set(headers)
    for column in requested:
        if column is not None and column not in known:
            raise CSVInsightsError(f"unknown column: {column!r}")


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = Path(path).open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise CSVInsightsError(f"cannot read {path!r}: {exc.strerror or exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CSVInsightsError("input CSV is empty") from None
            validate_headers(headers)

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CSVInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append((record_number, row))
    except csv.Error as exc:
        line = getattr(reader, "line_num", 0)
        location = f" near line {line}" if line else ""
        raise CSVInsightsError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CSVInsightsError(f"input is not valid UTF-8: {exc}") from exc

    return headers, rows


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CSVInsightsError(f"row {record_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CSVInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CSVInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_precision(values: Sequence[Decimal]) -> int:
    """Choose enough precision for exact finite addition and a useful average."""
    if not values:
        return 28
    highest = max(value.adjusted() for value in values if value != 0) if any(values) else 0
    lowest = min(value.as_tuple().exponent for value in values)
    carry = math.ceil(math.log10(len(values) + 1))
    return max(28, highest - lowest + carry + 2)


def calculate(values: Sequence[Decimal], average: bool = False) -> Decimal:
    with localcontext() as context:
        context.prec = decimal_precision(values)
        total = sum(values, Decimal(0))
        return total / Decimal(len(values)) if average else total


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def select_rows(
    headers: list[str],
    rows: list[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(headers.index(column), value) for column, value in filters]
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[index] == value for index, value in indexes)
    ]


def aggregate_rows(
    headers: list[str],
    rows: list[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(group_column)
    numeric_columns = list(
        dict.fromkeys(column for column in (sum_column, avg_column) if column is not None)
    )
    numeric_indexes = {column: headers.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for record_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            bucket[column].append(parse_decimal(row[numeric_indexes[column]], record_number, column))

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        output_row = [group]
        if sum_column:
            output_row.append(format_decimal(calculate(groups[group][sum_column])))
        if avg_column:
            output_row.append(format_decimal(calculate(groups[group][avg_column], average=True)))
        output_rows.append(output_row)
    return output_headers, output_rows


def write_output(headers: list[str], rows: list[list[str]], output: str, stream: TextIO) -> None:
    if output == "csv":
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(headers)
        writer.writerows(rows)
        return

    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    headers, rows = read_csv(args.input)
    require_columns(
        headers,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    selected_rows = select_rows(headers, rows, filters)

    if args.group_by:
        headers, rows = aggregate_rows(
            headers, selected_rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        rows = [row for _, row in selected_rows]
    write_output(headers, rows, args.output, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CSVInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

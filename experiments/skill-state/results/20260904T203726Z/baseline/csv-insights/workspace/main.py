#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files without third-party dependencies."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class InputError(Exception):
    """An input or command-line error that should be shown without a traceback."""


@dataclass(frozen=True)
class CsvData:
    headers: list[str]
    rows: list[list[str]]


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate a CSV file.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")
    return args


def read_csv(path: str) -> CsvData:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as file:
            reader = csv.reader(file, strict=True)
            try:
                headers = next(reader)
            except StopIteration as error:
                raise InputError("input CSV is empty") from error

            if not headers:
                raise InputError("CSV header row is empty")
            if any(header == "" for header in headers):
                raise InputError("CSV headers must be non-empty")
            duplicates = sorted({header for header in headers if headers.count(header) > 1})
            if duplicates:
                raise InputError(f"CSV headers must be unique; duplicate: {duplicates[0]!r}")

            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise InputError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
    except OSError as error:
        raise InputError(f"cannot read {path!r}: {error.strerror or error}") from error
    except UnicodeDecodeError as error:
        raise InputError(f"cannot decode {path!r} as UTF-8: {error}") from error
    except csv.Error as error:
        raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from error

    return CsvData(headers, rows)


def parse_filters(raw_filters: list[str], headers: list[str]) -> list[tuple[int, str]]:
    header_positions = {header: index for index, header in enumerate(headers)}
    filters: list[tuple[int, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise InputError(f"malformed filter {raw_filter!r}; expected COLUMN=VALUE")
        column, value = raw_filter.split("=", 1)
        if not column:
            raise InputError(f"malformed filter {raw_filter!r}; column cannot be empty")
        if column not in header_positions:
            raise InputError(f"unknown column in filter: {column!r}")
        filters.append((header_positions[column], value))
    return filters


def column_index(column: str, headers: list[str], option: str) -> int:
    try:
        return headers.index(column)
    except ValueError as error:
        raise InputError(f"unknown column for {option}: {column!r}") from error


def decimal_value(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise InputError(f"blank numeric value at row {record_number}, column {column!r}")
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise InputError(
            f"invalid numeric value {value!r} at row {record_number}, column {column!r}"
        ) from error
    if not number.is_finite():
        raise InputError(
            f"invalid numeric value {value!r} at row {record_number}, column {column!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def filtered_rows(rows: list[list[str]], filters: list[tuple[int, str]]) -> list[tuple[int, list[str]]]:
    return [
        (record_number, row)
        for record_number, row in enumerate(rows, start=2)
        if all(row[index] == value for index, value in filters)
    ]


def aggregate(
    selected_rows: list[tuple[int, list[str]]],
    headers: list[str],
    group_by: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = column_index(group_by, headers, "--group-by")
    sum_index = column_index(sum_column, headers, "--sum") if sum_column else None
    avg_index = column_index(avg_column, headers, "--avg") if avg_column else None
    groups: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    for record_number, row in selected_rows:
        groups[row[group_index]].append((record_number, row))

    result_headers = [group_by]
    if sum_column:
        result_headers.append(f"sum_{sum_column}")
    if avg_column:
        result_headers.append(f"avg_{avg_column}")

    result_rows: list[list[str]] = []
    # A generous decimal context avoids accidental precision loss during averages.
    with localcontext() as context:
        context.prec = 50
        for group_value in sorted(groups):
            group_rows = groups[group_value]
            result = [group_value]
            if sum_index is not None:
                total = sum(
                    (decimal_value(row[sum_index], record_number, sum_column) for record_number, row in group_rows),
                    Decimal(0),
                )
                result.append(format_decimal(total))
            if avg_index is not None:
                total = sum(
                    (decimal_value(row[avg_index], record_number, avg_column) for record_number, row in group_rows),
                    Decimal(0),
                )
                result.append(format_decimal(total / len(group_rows)))
            result_rows.append(result)
    return result_headers, result_rows


def write_output(headers: list[str], rows: list[list[str]], output: str) -> None:
    if output == "json":
        objects = [dict(zip(headers, row)) for row in rows]
        json.dump(objects, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return

    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    data = read_csv(args.input)
    filters = parse_filters(args.where, data.headers)
    selected_rows = filtered_rows(data.rows, filters)
    if args.group_by:
        headers, rows = aggregate(
            selected_rows, data.headers, args.group_by, args.sum_column, args.avg_column
        )
    else:
        headers = data.headers
        rows = [row for _, row in selected_rows]
    write_output(headers, rows, args.output)


def main(argv: list[str] | None = None) -> int:
    try:
        run(parse_arguments(argv))
    except InputError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

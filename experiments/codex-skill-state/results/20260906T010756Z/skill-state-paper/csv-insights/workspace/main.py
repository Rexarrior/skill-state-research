#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be presented to the command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally compute grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument(
        "--avg", dest="avg_column", metavar="COLUMN", help="column to average"
    )
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")

    empty_positions = [str(index + 1) for index, header in enumerate(headers) if not header]
    if empty_positions:
        raise CsvInsightsError(
            "header names must not be empty (empty field at position "
            + ", ".join(empty_positions)
            + ")"
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header names must be unique (duplicate: {names})")


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    header_set = set(headers)
    unknown = [column for column in columns if column not in header_set]
    if unknown:
        names = ", ".join(repr(column) for column in dict.fromkeys(unknown))
        raise CsvInsightsError(f"unknown column(s): {names}")


def read_csv(source: TextIO) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(source, strict=True)
    try:
        headers = next(reader)
    except StopIteration as error:
        raise CsvInsightsError("input is empty; expected a header row") from error
    except csv.Error as error:
        raise CsvInsightsError(f"malformed CSV near line 1: {error}") from error

    validate_headers(headers)
    rows: list[tuple[int, dict[str, str]]] = []
    logical_row = 1
    try:
        for fields in reader:
            logical_row += 1
            if len(fields) != len(headers):
                raise CsvInsightsError(
                    f"row {logical_row} has {len(fields)} fields; expected {len(headers)}"
                )
            rows.append((logical_row, dict(zip(headers, fields))))
    except csv.Error as error:
        raise CsvInsightsError(
            f"malformed CSV near line {reader.line_num}: {error}"
        ) from error
    return headers, rows


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: numeric value is blank"
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


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def filter_rows(
    rows: Sequence[tuple[int, dict[str, str]]], filters: Sequence[tuple[str, str]]
) -> list[tuple[int, dict[str, str]]]:
    return [
        item
        for item in rows
        if all(item[1][column] == value for column, value in filters)
    ]


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    groups: dict[str, dict[str, Decimal | int]] = {}
    for row_number, row in rows:
        group = row[group_column]
        state = groups.setdefault(
            group, {"sum": Decimal(0), "avg_total": Decimal(0), "avg_count": 0}
        )
        if sum_column is not None:
            state["sum"] = Decimal(state["sum"]) + parse_decimal(
                row[sum_column], row_number, sum_column
            )
        if avg_column is not None:
            state["avg_total"] = Decimal(state["avg_total"]) + parse_decimal(
                row[avg_column], row_number, avg_column
            )
            state["avg_count"] = int(state["avg_count"]) + 1

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        output_row = {group_column: group}
        if sum_column is not None:
            output_row[f"sum_{sum_column}"] = decimal_string(Decimal(state["sum"]))
        if avg_column is not None:
            average = Decimal(state["avg_total"]) / int(state["avg_count"])
            output_row[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(output_row)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column is not None or args.avg_column is not None) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and args.sum_column is None and args.avg_column is None:
        raise CsvInsightsError("--group-by requires --sum or --avg")

    filters = parse_filters(args.where)
    input_path = Path(args.input)
    try:
        with input_path.open("r", encoding="utf-8", newline="") as source:
            headers, rows = read_csv(source)
    except (OSError, UnicodeError) as error:
        raise CsvInsightsError(f"cannot read {args.input!r}: {error}") from error

    requested_columns = [column for column, _ in filters]
    requested_columns.extend(
        column
        for column in (args.group_by, args.sum_column, args.avg_column)
        if column is not None
    )
    require_columns(headers, requested_columns)
    filtered = filter_rows(rows, filters)

    if args.group_by:
        output_headers, output_rows = aggregate_rows(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_headers, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

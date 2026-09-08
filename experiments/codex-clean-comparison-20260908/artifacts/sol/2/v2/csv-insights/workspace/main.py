#!/usr/bin/env python3
"""CSV Insights: dependency-free filtering and decimal aggregation."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def fail(message: str) -> NoReturn:
    raise CsvInsightsError(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and calculate exact grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum or --avg")
    return args


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            fail(f"malformed filter {expression!r}: expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if not column:
            fail(f"malformed filter {expression!r}: column name must not be empty")
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        fail("input has no header row")
    if any(header == "" for header in headers):
        fail("header names must not be empty")
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        fail("header names must be unique; duplicate: " + ", ".join(repr(x) for x in duplicates))


def require_columns(headers: list[str], columns: Sequence[str | None]) -> None:
    known = set(headers)
    for column in columns:
        if column is not None and column not in known:
            fail(f"unknown column: {column!r}")


def read_rows(stream: TextIO) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(stream, strict=True)
    try:
        try:
            headers = next(reader)
        except StopIteration:
            fail("input has no header row")
        validate_headers(headers)

        rows: list[tuple[int, dict[str, str]]] = []
        for values in reader:
            row_number = reader.line_num
            if len(values) != len(headers):
                fail(
                    f"row {row_number} has {len(values)} fields; expected {len(headers)}"
                )
            rows.append((row_number, dict(zip(headers, values))))
        return headers, rows
    except csv.Error as exc:
        fail(f"malformed CSV near row {reader.line_num}: {exc}")


def decimal_cell(row_number: int, column: str, value: str) -> Decimal:
    if value == "":
        fail(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        fail(f"row {row_number}, column {column!r}: invalid numeric value {value!r}")
    if not number.is_finite():
        fail(f"row {row_number}, column {column!r}: invalid numeric value {value!r}")
    return number


def decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: list[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    # Values hold [sum-for-sum, sum-for-average, average-count]. The numeric
    # column is deliberately parsed independently for each requested operation.
    groups: dict[str, list[Decimal | int]] = {}
    for row_number, row in rows:
        group = row[group_column]
        state = groups.setdefault(group, [Decimal(0), Decimal(0), 0])
        if sum_column is not None:
            state[0] = state[0] + decimal_cell(row_number, sum_column, row[sum_column])
        if avg_column is not None:
            state[1] = state[1] + decimal_cell(row_number, avg_column, row[avg_column])
            state[2] = state[2] + 1

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    result: list[dict[str, str]] = []
    for group in sorted(groups):
        sum_value, avg_total, avg_count = groups[group]
        output_row = {group_column: group}
        if sum_column is not None:
            output_row[f"sum_{sum_column}"] = decimal_text(sum_value)
        if avg_column is not None:
            output_row[f"avg_{avg_column}"] = decimal_text(avg_total / avg_count)
        result.append(output_row)
    return output_headers, result


def emit(headers: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    input_path = Path(args.input)
    try:
        with input_path.open("r", encoding="utf-8", newline="") as stream:
            headers, numbered_rows = read_rows(stream)
    except (OSError, UnicodeError) as exc:
        fail(f"cannot read {args.input!r}: {exc}")

    require_columns(
        headers,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.group_by:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]
    emit(output_headers, output_rows, args.output)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        run(args)
        return 0
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

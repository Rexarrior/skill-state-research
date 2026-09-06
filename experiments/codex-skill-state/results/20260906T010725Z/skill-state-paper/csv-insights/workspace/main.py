#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate an RFC-style CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if not name]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty (empty field at position "
            + ", ".join(empty_positions)
            + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique (duplicate: "
            + ", ".join(repr(name) for name in duplicates)
            + ")"
        )


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    header_set = set(headers)
    for column in columns:
        if column not in header_set:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty") from None
            validate_headers(headers)
            rows: list[tuple[int, list[str]]] = []
            try:
                for row in reader:
                    row_number = reader.line_num
                    if len(row) != len(headers):
                        raise CsvInsightsError(
                            f"row {row_number} has {len(row)} fields; expected {len(headers)}"
                        )
                    rows.append((row_number, row))
            except csv.Error as error:
                raise CsvInsightsError(
                    f"malformed CSV near row {reader.line_num}: {error}"
                ) from None
            return headers, rows
    except CsvInsightsError:
        raise
    except (OSError, UnicodeError) as error:
        raise CsvInsightsError(f"cannot read {path!r}: {error}") from None


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def filter_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(headers.index(column), value) for column, value in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == value for index, value in indexes)
    ]


def aggregate_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(group_by)
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    numeric_indexes = {column: headers.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for row_number, row in rows:
        group = row[group_index]
        values: dict[str, Decimal] = {}
        for column in numeric_columns:
            cell = row[numeric_indexes[column]]
            if not cell:
                raise CsvInsightsError(
                    f"row {row_number}, column {column!r}: numeric value is blank"
                )
            try:
                number = Decimal(cell)
            except InvalidOperation:
                raise CsvInsightsError(
                    f"row {row_number}, column {column!r}: invalid numeric value {cell!r}"
                ) from None
            if not number.is_finite():
                raise CsvInsightsError(
                    f"row {row_number}, column {column!r}: invalid numeric value {cell!r}"
                )
            values[column] = number

        totals = groups.setdefault(group, {})
        for column, number in values.items():
            total, count = totals.get(column, (Decimal(0), 0))
            totals[column] = (total + number, count + 1)

    output_headers = [group_by]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[list[str]] = []
    for group in sorted(groups):
        totals = groups[group]
        output_row = [group]
        for column in sum_columns:
            total, _ = totals[column]
            output_row.append(decimal_string(total))
        for column in avg_columns:
            total, count = totals[column]
            output_row.append(decimal_string(total / Decimal(count)))
        output_rows.append(output_row)
    return output_headers, output_rows


def emit_json(headers: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False)
    stream.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(argv: Sequence[str], stdout: TextIO) -> None:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        raise CsvInsightsError("--group-by requires --sum or --avg")

    headers, numbered_rows = read_csv(args.input)
    requested_columns = [column for column, _ in filters]
    if args.group_by:
        requested_columns.append(args.group_by)
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    require_columns(headers, requested_columns)
    filtered = filter_rows(headers, numbered_rows, filters)

    if args.group_by:
        output_headers, output_rows = aggregate_rows(
            headers,
            filtered,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_headers, output_rows, stdout)
    else:
        emit_csv(output_headers, output_rows, stdout)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        run(sys.argv[1:] if argv is None else argv, sys.stdout)
        return 0
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

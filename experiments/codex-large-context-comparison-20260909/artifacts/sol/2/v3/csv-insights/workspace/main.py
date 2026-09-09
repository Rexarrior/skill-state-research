#!/usr/bin/env python3
"""CSV Insights: filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sys
from typing import NoReturn, TextIO


class InputError(Exception):
    """An error that should be presented to the command-line user."""


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally compute grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group results")
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


def parse_filters(raw_filters: list[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise InputError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise InputError(
                f"malformed filter {raw_filter!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise InputError(f"cannot read {path}: {exc}") from exc

    with handle:
        reader = csv.reader(handle, strict=True)
        try:
            try:
                headers = next(reader)
            except StopIteration:
                raise InputError("input CSV is empty") from None

            if not headers:
                raise InputError("header row must contain at least one column")
            empty_positions = [str(index + 1) for index, name in enumerate(headers) if name == ""]
            if empty_positions:
                raise InputError(
                    "header names must be non-empty "
                    f"(empty at column {', '.join(empty_positions)})"
                )
            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                raise InputError(
                    "header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise InputError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append((record_number, row))
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from exc
        except UnicodeError as exc:
            raise InputError(f"input is not valid UTF-8: {exc}") from exc
    return headers, rows


def require_columns(headers: list[str], columns: list[tuple[str, str]]) -> None:
    for role, column in columns:
        if column not in headers:
            raise InputError(f"unknown column for {role}: {column!r}")


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise InputError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise InputError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from None
    if not value.is_finite():
        raise InputError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def analyze(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(Path(args.input))

    requested = [("--where", column) for column, _ in filters]
    requested += [("--group-by", args.group_by)] if args.group_by else []
    requested += [("--sum", args.sum_column)] if args.sum_column else []
    requested += [("--avg", args.avg_column)] if args.avg_column else []
    require_columns(headers, requested)

    indexes = {name: index for index, name in enumerate(headers)}
    filtered_rows = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[indexes[column]] == value for column, value in filters)
    ]

    if not args.group_by:
        return headers, [dict(zip(headers, row)) for _, row in filtered_rows]

    numeric_columns = list(dict.fromkeys(
        column for column in (args.sum_column, args.avg_column) if column is not None
    ))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in filtered_rows:
        group = row[indexes[args.group_by]]
        values = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            values[column].append(decimal_value(row[indexes[column]], row_number, column))

    output_headers = [args.group_by]
    if args.sum_column:
        output_headers.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_headers.append(f"avg_{args.avg_column}")

    results: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {args.group_by: group}
        if args.sum_column:
            total = sum(groups[group][args.sum_column], Decimal(0))
            result[f"sum_{args.sum_column}"] = format_decimal(total)
        if args.avg_column:
            values = groups[group][args.avg_column]
            average = sum(values, Decimal(0)) / Decimal(len(values))
            result[f"avg_{args.avg_column}"] = format_decimal(average)
        results.append(result)
    return output_headers, results


def emit(headers: list[str], rows: list[dict[str, str]], output: str, stream: TextIO) -> None:
    if output == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    try:
        headers, rows = analyze(args)
        emit(headers, rows, args.output, sys.stdout)
    except InputError as exc:
        fail(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

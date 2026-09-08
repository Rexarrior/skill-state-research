#!/usr/bin/env python3
"""CSV Insights: dependency-free filtering and decimal aggregation."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error suitable for presenting to a command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter CSV rows and optionally compute grouped sums and averages.",
    )
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument(
        "--where", action="append", default=[], metavar="COLUMN=VALUE",
        help="keep rows whose column exactly matches value (repeatable)",
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
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str] | None) -> list[str]:
    if header is None:
        raise CsvInsightsError("input is empty: a header row is required")
    empty_positions = [str(i + 1) for i, name in enumerate(header) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty (empty field at position "
            + ", ".join(empty_positions)
            + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique (duplicate: "
            + ", ".join(repr(name) for name in duplicates)
            + ")"
        )
    return header


def decimal_string(value: Decimal) -> str:
    if not value.is_finite():
        raise CsvInsightsError("numeric values must be finite")
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
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
            f"row {row_number}, column {column!r}: numeric value must be finite"
        )
    return number


def add_decimals_exact(left: Decimal, right: Decimal) -> Decimal:
    """Add finite decimals without rounding through the default Decimal context."""
    left_tuple = left.as_tuple()
    right_tuple = right.as_tuple()
    common_exponent = min(left_tuple.exponent, right_tuple.exponent)
    left_places = len(left_tuple.digits) + left_tuple.exponent - common_exponent
    right_places = len(right_tuple.digits) + right_tuple.exponent - common_exponent
    with localcontext() as context:
        context.prec = max(left_places, right_places) + 1
        return left + right


def validate_output_columns(args: argparse.Namespace) -> None:
    output_columns = [args.group_by]
    output_columns.extend(f"sum_{column}" for column in args.sum_columns)
    output_columns.extend(f"avg_{column}" for column in args.avg_columns)
    seen: set[str | None] = set()
    for column in output_columns:
        if column in seen:
            raise CsvInsightsError(
                f"duplicate aggregate output column: {column!r}"
            )
        seen.add(column)


def require_columns(header: list[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def process(args: argparse.Namespace, source: TextIO) -> tuple[list[str], list[dict[str, str]]]:
    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    if args.sum_columns or args.avg_columns:
        validate_output_columns(args)
    try:
        reader = csv.reader(source, strict=True)
        try:
            header = validate_header(next(reader, None))
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV header: {exc}") from None

        referenced = [column for column, _ in filters]
        if args.group_by is not None:
            referenced.append(args.group_by)
        referenced.extend(args.sum_columns)
        referenced.extend(args.avg_columns)
        require_columns(header, referenced)
        indexes = {name: i for i, name in enumerate(header)}
        aggregate = bool(args.sum_columns or args.avg_columns)

        if aggregate:
            numeric_columns = list(dict.fromkeys(args.sum_columns + args.avg_columns))
            groups: dict[str, dict[str, object]] = {}
        else:
            rows: list[dict[str, str]] = []

        try:
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number}: expected {len(header)} fields, found {len(row)}"
                    )
                if any(row[indexes[column]] != value for column, value in filters):
                    continue
                if not aggregate:
                    rows.append(dict(zip(header, row)))
                    continue

                group = row[indexes[args.group_by]]
                bucket = groups.setdefault(
                    group,
                    {"count": 0, "sums": {column: Decimal(0) for column in numeric_columns}},
                )
                numbers = {
                    column: parse_decimal(row[indexes[column]], record_number, column)
                    for column in numeric_columns
                }
                bucket["count"] = int(bucket["count"]) + 1
                sums = bucket["sums"]
                assert isinstance(sums, dict)
                for column, number in numbers.items():
                    sums[column] = add_decimals_exact(sums[column], number)
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV near row {reader.line_num}: {exc}") from None
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid text: {exc}") from None

    if not aggregate:
        return header, rows

    output_header = [args.group_by]
    output_header.extend(f"sum_{column}" for column in args.sum_columns)
    output_header.extend(f"avg_{column}" for column in args.avg_columns)
    result: list[dict[str, str]] = []
    for group in sorted(groups):
        bucket = groups[group]
        sums = bucket["sums"]
        count = int(bucket["count"])
        assert isinstance(sums, dict)
        output_row = {args.group_by: group}
        for column in args.sum_columns:
            output_row[f"sum_{column}"] = decimal_string(sums[column])
        for column in args.avg_columns:
            output_row[f"avg_{column}"] = decimal_string(sums[column] / count)
        result.append(output_row)
    return output_header, result


def emit(header: list[str], rows: list[dict[str, str]], output: str, stream: TextIO) -> None:
    if output == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return
    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    try:
        with Path(args.input).open("r", encoding="utf-8", newline="") as source:
            header, rows = process(args, source)
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {args.input!r}: {exc.strerror or exc}") from None
    emit(header, rows, args.output, stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

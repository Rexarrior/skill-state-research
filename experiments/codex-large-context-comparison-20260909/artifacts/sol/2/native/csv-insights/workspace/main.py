#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import MAX_EMAX, MIN_EMIN, Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CSVInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows with an exact value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument(
        "--avg", dest="avg_column", metavar="COLUMN", help="column to average"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


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
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_arguments(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CSVInsightsError("--sum and --avg require --group-by")


def validate_header(header: list[str]) -> None:
    if not header:
        raise CSVInsightsError("input is empty; expected a header row")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
    if empty_positions:
        raise CSVInsightsError(
            "header names must be non-empty; empty header at column "
            + ", ".join(empty_positions)
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CSVInsightsError(f"header names must be unique; duplicate: {rendered}")


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    available = set(header)
    for column in columns:
        if column not in available:
            raise CSVInsightsError(f"unknown column: {column!r}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from None
    if not number.is_finite():
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    """Return a finite Decimal without an exponent or insignificant zeroes."""
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def add_decimals_exact(left: Decimal, right: Decimal) -> Decimal:
    """Add two finite decimals without rounding in the default context."""
    left_tuple = left.as_tuple()
    right_tuple = right.as_tuple()
    lowest_place = min(left_tuple.exponent, right_tuple.exponent)
    highest_place = max(left.adjusted(), right.adjusted())
    # Cover every place in both operands and one possible carry digit.
    precision = max(1, highest_place - lowest_place + 2)
    with localcontext() as context:
        context.prec = precision
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def divide_for_average(total: Decimal, count: int) -> Decimal:
    """Divide using Decimal with at least the standard 28 significant digits."""
    with localcontext() as context:
        context.prec = max(28, len(total.as_tuple().digits))
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return total / count


def read_and_process(
    stream: TextIO, args: argparse.Namespace, filters: Sequence[tuple[str, str]]
) -> tuple[list[str], list[dict[str, str]]]:
    reader = csv.reader(stream, strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise CSVInsightsError("input is empty; expected a header row") from None
    except csv.Error as exc:
        raise CSVInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from None

    validate_header(header)
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(
        column
        for column in (args.group_by, args.sum_column, args.avg_column)
        if column is not None
    )
    require_columns(header, requested_columns)
    indexes = {name: index for index, name in enumerate(header)}

    aggregate = bool(args.sum_column or args.avg_column)
    output_header = [args.group_by] if aggregate else list(header)
    if args.sum_column:
        output_header.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_header.append(f"avg_{args.avg_column}")
    if len(output_header) != len(set(output_header)):
        raise CSVInsightsError(
            "aggregation produces duplicate output column names; "
            "choose different group or value columns"
        )

    rows: list[dict[str, str]] = []
    groups: dict[str, dict[str, Decimal | int]] = {}

    logical_row = 1
    try:
        for logical_row, fields in enumerate(reader, start=2):
            if len(fields) != len(header):
                raise CSVInsightsError(
                    f"row {logical_row} has {len(fields)} fields; expected {len(header)}"
                )
            if any(fields[indexes[column]] != value for column, value in filters):
                continue

            if not aggregate:
                rows.append(dict(zip(header, fields)))
                continue

            group = fields[indexes[args.group_by]]
            values: dict[str, Decimal] = {}
            for column in {args.sum_column, args.avg_column} - {None}:
                values[column] = decimal_value(
                    fields[indexes[column]], logical_row, column
                )

            state = groups.setdefault(group, {"count": 0})
            state["count"] += 1
            if args.sum_column:
                key = f"sum_{args.sum_column}"
                state[key] = (
                    add_decimals_exact(state[key], values[args.sum_column])
                    if key in state
                    else values[args.sum_column]
                )
            if args.avg_column:
                key = f"total_{args.avg_column}"
                state[key] = (
                    add_decimals_exact(state[key], values[args.avg_column])
                    if key in state
                    else values[args.avg_column]
                )
    except csv.Error as exc:
        raise CSVInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from None

    if not aggregate:
        return output_header, rows

    for group in sorted(groups):
        state = groups[group]
        result = {args.group_by: group}
        if args.sum_column:
            key = f"sum_{args.sum_column}"
            result[key] = format_decimal(state[key])
        if args.avg_column:
            total_key = f"total_{args.avg_column}"
            result[f"avg_{args.avg_column}"] = format_decimal(
                divide_for_average(state[total_key], state["count"])
            )
        rows.append(result)
    return output_header, rows


def emit(header: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    writer = csv.DictWriter(
        sys.stdout, fieldnames=header, lineterminator="\r\n", extrasaction="raise"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        validate_arguments(args)
        filters = parse_filters(args.where)
        input_path = Path(args.input)
        with input_path.open("r", encoding="utf-8", newline="") as stream:
            header, rows = read_and_process(stream, args, filters)
        emit(header, rows, args.output)
    except (CSVInsightsError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(run())

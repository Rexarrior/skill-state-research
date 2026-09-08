#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An input or command-line error suitable for display to the user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UserError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="csv-insights",
        description="Filter CSV rows and optionally compute grouped sums and averages.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise UserError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {expression!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise UserError("CSV header must not be empty")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
    if empty_positions:
        raise UserError(
            "CSV header names must not be empty "
            f"(empty field at position {', '.join(empty_positions)})"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise UserError(
            "CSV header names must be unique "
            f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
        )


def require_columns(header: list[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise UserError(f"unknown column: {column!r}")


def read_rows(stream: TextIO) -> tuple[list[str], list[list[str]]]:
    reader = csv.reader(stream, strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise UserError("input CSV is empty") from None
    except csv.Error as error:
        raise UserError(f"malformed CSV header: {error}") from None

    validate_header(header)
    rows: list[list[str]] = []
    try:
        for logical_row, row in enumerate(reader, start=2):
            if len(row) != len(header):
                raise UserError(
                    f"row {logical_row} has {len(row)} fields; expected {len(header)}"
                )
            rows.append(row)
    except csv.Error as error:
        raise UserError(f"malformed CSV near line {reader.line_num}: {error}") from None
    return header, rows


def decimal_value(value: str, logical_row: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"invalid numeric value at row {logical_row}, column {column!r}: blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise UserError(
            f"invalid numeric value at row {logical_row}, column {column!r}: {value!r}"
        ) from None
    if not number.is_finite():
        raise UserError(
            f"invalid numeric value at row {logical_row}, column {column!r}: {value!r}"
        )
    return number


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals without context-dependent rounding."""
    if not values:
        return Decimal(0)
    exponent = min(value.as_tuple().exponent for value in values)
    total = 0
    for value in values:
        parts = value.as_tuple()
        coefficient = 0
        for digit in parts.digits:
            coefficient = coefficient * 10 + digit
        if parts.sign:
            coefficient = -coefficient
        total += coefficient * (10 ** (parts.exponent - exponent))
    if total == 0:
        return Decimal(0)
    sign = int(total < 0)
    digits = tuple(int(character) for character in str(abs(total)))
    return Decimal((sign, digits, exponent))


def filter_rows(
    header: list[str], rows: list[list[str]], filters: list[tuple[str, str]]
) -> list[tuple[int, list[str]]]:
    indices = [(header.index(column), expected) for column, expected in filters]
    return [
        (logical_row, row)
        for logical_row, row in enumerate(rows, start=2)
        if all(row[index] == expected for index, expected in indices)
    ]


def aggregate_rows(
    header: list[str],
    rows: list[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    sum_index = header.index(sum_column) if sum_column is not None else None
    avg_index = header.index(avg_column) if avg_column is not None else None
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for logical_row, row in rows:
        group = groups.setdefault(row[group_index], {"sum": [], "avg": []})
        if sum_index is not None:
            value = decimal_value(row[sum_index], logical_row, sum_column)
            group["sum"].append(value)
        if avg_index is not None:
            value = decimal_value(row[avg_index], logical_row, avg_column)
            group["avg"].append(value)

    output_header = [group_column]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group_name in sorted(groups):
        values = groups[group_name]
        result = [group_name]
        if sum_column is not None:
            result.append(decimal_string(exact_sum(values["sum"])))
        if avg_column is not None:
            # Division can be repeating; use Decimal's standard 28-digit precision
            # explicitly so the output is stable regardless of an importing caller.
            with localcontext() as context:
                context.prec = 28
                average = exact_sum(values["avg"]) / len(values["avg"])
            result.append(decimal_string(average))
        output_rows.append(result)
    return output_header, output_rows


def emit_json(header: list[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(header: list[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(arguments: Sequence[str], stdout: TextIO) -> None:
    parser = build_parser()
    options = parser.parse_args(arguments)
    filters = parse_filters(options.where)
    if (options.sum_column or options.avg_column) and not options.group_by:
        raise UserError("--sum and --avg require --group-by")

    try:
        with Path(options.input).open("r", encoding="utf-8", newline="") as stream:
            header, rows = read_rows(stream)
    except (OSError, UnicodeError) as error:
        raise UserError(f"cannot read {options.input!r}: {error}") from None

    require_columns(
        header,
        [*(column for column, _ in filters), options.group_by, options.sum_column, options.avg_column],
    )
    selected = filter_rows(header, rows, filters)

    if options.sum_column or options.avg_column:
        output_header, output_rows = aggregate_rows(
            header,
            selected,
            options.group_by,
            options.sum_column,
            options.avg_column,
        )
    else:
        output_header = header
        output_rows = [row for _, row in selected]

    if options.output == "json":
        emit_json(output_header, output_rows, stdout)
    else:
        emit_csv(output_header, output_rows, stdout)


def main() -> int:
    try:
        run(sys.argv[1:], sys.stdout)
    except UserError as error:
        print(f"csv-insights: error: {error}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

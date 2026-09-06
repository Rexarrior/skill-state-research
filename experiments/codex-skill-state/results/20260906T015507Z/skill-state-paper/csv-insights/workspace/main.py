#!/usr/bin/env python3
"""Small, dependency-free CSV filtering and aggregation tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An input or invocation error that should be shown without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    try:
        handle = Path(path).open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot read {path!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("input is empty; a header row is required")
            except csv.Error as exc:
                raise UserError(f"malformed CSV header: {exc}") from exc

            if not header:
                raise UserError("header row is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
            if empty_positions:
                raise UserError(
                    "header names must be non-empty (empty field at position "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise UserError("header names must be unique; duplicate: " + ", ".join(repr(x) for x in duplicates))

            rows: list[list[str]] = []
            try:
                for record_number, row in enumerate(reader, start=2):
                    if len(row) != len(header):
                        raise UserError(
                            f"row {record_number} has {len(row)} fields; expected {len(header)}"
                        )
                    rows.append(row)
            except csv.Error as exc:
                raise UserError(f"malformed CSV near line {reader.line_num}: {exc}") from exc
    except UnicodeError as exc:
        raise UserError(f"input is not valid UTF-8: {exc}") from exc
    return header, rows


def validate_args(
    args: argparse.Namespace, header: list[str]
) -> tuple[list[tuple[int, str]], int | None, list[tuple[str, int]]]:
    indexes = {name: index for index, name in enumerate(header)}

    filters: list[tuple[int, str]] = []
    for expression in args.where:
        if "=" not in expression:
            raise UserError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if not column:
            raise UserError(f"malformed filter {expression!r}; column name is empty")
        if column not in indexes:
            raise UserError(f"unknown filter column: {column!r}")
        filters.append((indexes[column], value))

    aggregate_columns = [("sum", name) for name in args.sum_columns] + [
        ("avg", name) for name in args.avg_columns
    ]
    if aggregate_columns and args.group_by is None:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by is not None and not aggregate_columns:
        raise UserError("--group-by requires at least one --sum or --avg")
    if args.group_by is not None and args.group_by not in indexes:
        raise UserError(f"unknown group-by column: {args.group_by!r}")

    seen_output_names: set[str] = set()
    aggregates: list[tuple[str, int]] = []
    for operation, column in aggregate_columns:
        if column not in indexes:
            raise UserError(f"unknown {operation} column: {column!r}")
        output_name = f"{operation}_{column}"
        if output_name in seen_output_names:
            raise UserError(f"duplicate aggregate requested: {operation} {column!r}")
        seen_output_names.add(output_name)
        aggregates.append((operation, indexes[column]))

    group_index = indexes[args.group_by] if args.group_by is not None else None
    return filters, group_index, aggregates


def decimal_string(value: Decimal) -> str:
    """Return a non-exponent, insignificant-zero-free Decimal representation."""
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def calculate_aggregates(
    rows: list[list[str]],
    header: list[str],
    group_index: int,
    aggregates: list[tuple[str, int]],
) -> tuple[list[str], list[list[str]]]:
    # Values are retained until the end so summation precision can be selected
    # from the actual data rather than silently rounding at Decimal's default.
    groups: dict[str, list[list[Decimal]]] = {}
    for record_number, row in enumerate(rows, start=2):
        buckets = groups.setdefault(row[group_index], [[] for _ in aggregates])
        for aggregate_index, (_, column_index) in enumerate(aggregates):
            raw = row[column_index]
            try:
                value = Decimal(raw)
            except InvalidOperation as exc:
                raise UserError(
                    f"invalid numeric value at row {record_number}, column {header[column_index]!r}: {raw!r}"
                ) from exc
            if raw == "" or not value.is_finite():
                raise UserError(
                    f"invalid numeric value at row {record_number}, column {header[column_index]!r}: {raw!r}"
                )
            buckets[aggregate_index].append(value)

    output_header = [header[group_index]] + [
        f"{operation}_{header[column_index]}" for operation, column_index in aggregates
    ]
    output_rows: list[list[str]] = []
    for group_value in sorted(groups):
        result = [group_value]
        for (operation, _), values in zip(aggregates, groups[group_value]):
            integer_digits = max(1, max(value.adjusted() + 1 for value in values))
            fractional_digits = max(0, max(-value.as_tuple().exponent for value in values))
            precision = max(28, integer_digits + fractional_digits + len(str(len(values))) + 2)
            with localcontext() as context:
                context.prec = precision
                total = sum(values, Decimal(0))
                answer = total if operation == "sum" else total / Decimal(len(values))
            result.append(decimal_string(answer))
        output_rows.append(result)
    return output_header, output_rows


def emit_json(header: list[str], rows: list[list[str]], output: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, output, ensure_ascii=False, separators=(",", ":"))
    output.write("\n")


def emit_csv(header: list[str], rows: list[list[str]], output: TextIO) -> None:
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    header, rows = read_csv(args.input)
    filters, group_index, aggregates = validate_args(args, header)
    filtered = [row for row in rows if all(row[index] == value for index, value in filters)]

    if group_index is not None:
        output_header, output_rows = calculate_aggregates(filtered, header, group_index, aggregates)
    else:
        output_header, output_rows = header, filtered

    if args.output == "json":
        emit_json(output_header, output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

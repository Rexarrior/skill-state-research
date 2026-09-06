#!/usr/bin/env python3
"""CSV Insights: filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An input or usage error suitable for display to the user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UserError(message)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate CSV data.",
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
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by is not None and not (args.sum_columns or args.avg_columns):
        raise UserError("--group-by requires --sum or --avg")
    return args


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = open(path, "r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot open input file {path!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("input CSV is empty")
            except csv.Error as exc:
                raise UserError(f"malformed CSV near line {reader.line_num}: {exc}") from exc

            if not header:
                raise UserError("CSV header is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
            if empty_positions:
                raise UserError(f"CSV header contains an empty name at column {', '.join(empty_positions)}")
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise UserError(f"CSV header contains duplicate column(s): {', '.join(duplicates)}")

            rows: list[tuple[int, list[str]]] = []
            try:
                for row in reader:
                    record_number = len(rows) + 2
                    if len(row) != len(header):
                        raise UserError(
                            f"row {record_number} has {len(row)} fields; expected {len(header)}"
                        )
                    rows.append((record_number, row))
            except csv.Error as exc:
                raise UserError(f"malformed CSV near line {reader.line_num}: {exc}") from exc
    except UnicodeError as exc:
        raise UserError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise UserError(f"could not read input file {path!r}: {exc}") from exc

    return header, rows


def require_column(name: str, indexes: dict[str, int]) -> int:
    try:
        return indexes[name]
    except KeyError:
        raise UserError(f"unknown column: {name!r}") from None


def parse_filters(filters: Sequence[str], indexes: dict[str, int]) -> list[tuple[int, str]]:
    parsed: list[tuple[int, str]] = []
    for expression in filters:
        if "=" not in expression:
            raise UserError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if column == "":
            raise UserError(f"malformed filter {expression!r}; column must not be empty")
        parsed.append((require_column(column, indexes), value))
    return parsed


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def calculate(
    header: list[str], rows: list[tuple[int, list[str]]], args: argparse.Namespace
) -> tuple[list[str], list[list[str]]]:
    indexes = {name: index for index, name in enumerate(header)}
    filters = parse_filters(args.where, indexes)
    filtered = [
        (number, row)
        for number, row in rows
        if all(row[index] == value for index, value in filters)
    ]

    if args.group_by is None:
        return header, [row for _, row in filtered]

    group_index = require_column(args.group_by, indexes)
    metrics: list[tuple[str, str, int]] = []
    seen_output_names: set[str] = set()
    for operation, columns in (("sum", args.sum_columns), ("avg", args.avg_columns)):
        for column in columns:
            index = require_column(column, indexes)
            output_name = f"{operation}_{column}"
            if output_name in seen_output_names:
                raise UserError(f"duplicate aggregation requested: {operation} {column!r}")
            seen_output_names.add(output_name)
            metrics.append((operation, column, index))

    groups: dict[str, tuple[list[Decimal], int]] = {}
    for record_number, row in filtered:
        values: list[Decimal] = []
        for _operation, column, index in metrics:
            raw = row[index]
            if raw == "":
                raise UserError(f"row {record_number}, column {column!r}: blank numeric value")
            try:
                value = Decimal(raw)
            except InvalidOperation:
                raise UserError(
                    f"row {record_number}, column {column!r}: invalid numeric value {raw!r}"
                ) from None
            if not value.is_finite():
                raise UserError(
                    f"row {record_number}, column {column!r}: invalid numeric value {raw!r}"
                )
            values.append(value)

        key = row[group_index]
        if key not in groups:
            groups[key] = ([Decimal(0) for _ in metrics], 0)
        totals, count = groups[key]
        for index, value in enumerate(values):
            totals[index] += value
        groups[key] = (totals, count + 1)

    output_header = [args.group_by] + [f"{operation}_{column}" for operation, column, _ in metrics]
    output_rows: list[list[str]] = []
    for key in sorted(groups):
        totals, count = groups[key]
        result = [key]
        for total, (operation, _column, _index) in zip(totals, metrics):
            result.append(decimal_string(total if operation == "sum" else total / Decimal(count)))
        output_rows.append(result)
    return output_header, output_rows


def emit(header: list[str], rows: list[list[str]], output: str, stream: TextIO) -> None:
    if output == "json":
        objects = [dict(zip(header, row)) for row in rows]
        json.dump(objects, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    else:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        header, rows = read_csv(args.input)
        output_header, output_rows = calculate(header, rows, args)
        emit(output_header, output_rows, args.output, sys.stdout)
        return 0
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An input or command-line error that should be shown without a traceback."""


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        parser.error("--group-by requires at least one --sum or --avg")
    return args


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("input CSV is empty") from None
            except csv.Error as exc:
                raise UserError(f"malformed CSV near row 1: {exc}") from exc

            if not header:
                raise UserError("header row is empty")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if not name]
            if empty_positions:
                raise UserError(
                    "header names must be non-empty (empty column position(s): "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise UserError("duplicate header name(s): " + ", ".join(duplicates))

            rows: list[list[str]] = []
            try:
                for row_number, row in enumerate(reader, start=2):
                    if len(row) != len(header):
                        raise UserError(
                            f"row {row_number} has {len(row)} fields; expected {len(header)}"
                        )
                    rows.append(row)
            except csv.Error as exc:
                # reader.line_num is a physical line number and is still the most useful
                # location for malformed quoting, including records with embedded newlines.
                raise UserError(
                    f"malformed CSV near line {reader.line_num}: {exc}"
                ) from exc
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot read {path!r}: {exc}") from exc
    return header, rows


def column_index(header: list[str], column: str) -> int:
    try:
        return header.index(column)
    except ValueError:
        raise UserError(f"unknown column: {column!r}") from None


def parse_filters(filters: list[str], header: list[str]) -> list[tuple[int, str]]:
    parsed: list[tuple[int, str]] = []
    for expression in filters:
        if "=" not in expression:
            raise UserError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {expression!r}; column name cannot be empty"
            )
        parsed.append((column_index(header, column), value))
    return parsed


def minimal_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    header: list[str],
    rows: list[tuple[int, list[str]]],
    group_column: str,
    sum_columns: list[str],
    avg_columns: list[str],
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = column_index(header, group_column)
    metric_columns = list(dict.fromkeys(sum_columns + avg_columns))
    metric_indexes = {name: column_index(header, name) for name in metric_columns}

    # Validate all selected cells before calculating anything. Precision is sized
    # from their Decimal exponents so finite sums are not rounded by the context.
    parsed_rows: list[tuple[str, dict[str, Decimal]]] = []
    highest_adjusted = 0
    lowest_exponent = 0
    for row_number, row in rows:
        values: dict[str, Decimal] = {}
        for name, index in metric_indexes.items():
            cell = row[index]
            if not cell:
                raise UserError(f"row {row_number}, column {name!r}: blank numeric value")
            try:
                number = Decimal(cell)
            except InvalidOperation:
                raise UserError(
                    f"row {row_number}, column {name!r}: invalid numeric value {cell!r}"
                ) from None
            if not number.is_finite():
                raise UserError(
                    f"row {row_number}, column {name!r}: invalid numeric value {cell!r}"
                )
            values[name] = number
            if not number.is_zero():
                highest_adjusted = max(highest_adjusted, number.adjusted())
                lowest_exponent = min(lowest_exponent, number.as_tuple().exponent)
        parsed_rows.append((row[group_index], values))

    precision = max(
        28,
        highest_adjusted - lowest_exponent + len(str(max(1, len(rows)))) + 30,
    )
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for group, values in parsed_rows:
        bucket = groups.setdefault(group, {name: [] for name in metric_columns})
        for name, number in values.items():
            bucket[name].append(number)

    output_header = (
        [group_column]
        + [f"sum_{name}" for name in sum_columns]
        + [f"avg_{name}" for name in avg_columns]
    )
    result: list[dict[str, str]] = []
    with localcontext() as context:
        context.prec = precision
        for group in sorted(groups):
            output_row = {group_column: group}
            for name in sum_columns:
                output_row[f"sum_{name}"] = minimal_decimal(sum(groups[group][name]))
            for name in avg_columns:
                values = groups[group][name]
                output_row[f"avg_{name}"] = minimal_decimal(sum(values) / len(values))
            result.append(output_row)
    return output_header, result


def emit_json(records: list[dict[str, str]], stream: TextIO) -> None:
    json.dump(records, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(header: list[str], records: list[dict[str, str]], stream: TextIO) -> None:
    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(records)


def run(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    header, rows = read_csv(args.input)
    filters = parse_filters(args.where, header)
    numbered_rows = list(enumerate(rows, start=2))
    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[i] == value for i, value in filters)
    ]

    if args.group_by:
        output_header, records = aggregate(
            header,
            filtered,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_header = header
        records = [dict(zip(header, row)) for _, row in filtered]

    if args.output == "json":
        emit_json(records, sys.stdout)
    else:
        emit_csv(output_header, records, sys.stdout)
    return 0


def main() -> int:
    try:
        return run(sys.argv[1:])
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

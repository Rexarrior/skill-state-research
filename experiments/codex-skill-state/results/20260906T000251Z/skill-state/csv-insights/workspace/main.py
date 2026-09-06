#!/usr/bin/env python3
"""Dependency-free command-line analytics for CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO


class UserError(Exception):
    """An input or command-line error suitable for display to the user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    args = parser.parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if len(set(args.sum_columns)) != len(args.sum_columns):
        parser.error("the same column cannot be supplied to --sum more than once")
    if len(set(args.avg_columns)) != len(args.avg_columns):
        parser.error("the same column cannot be supplied to --avg more than once")
    return args


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
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def check_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise UserError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot open {path}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise UserError("input CSV is empty") from exc
            except csv.Error as exc:
                raise UserError(f"malformed CSV header: {exc}") from exc

            if not headers:
                raise UserError("header row is empty")
            if any(header == "" for header in headers):
                raise UserError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                duplicates = sorted(
                    {header for header in headers if headers.count(header) > 1}
                )
                raise UserError(f"duplicate CSV header: {duplicates[0]!r}")

            rows: list[tuple[int, dict[str, str]]] = []
            logical_row = 1
            try:
                for fields in reader:
                    logical_row += 1
                    if len(fields) != len(headers):
                        raise UserError(
                            f"row {logical_row} has {len(fields)} fields; "
                            f"expected {len(headers)}"
                        )
                    rows.append((logical_row, dict(zip(headers, fields))))
            except csv.Error as exc:
                raise UserError(f"malformed CSV near row {logical_row + 1}: {exc}") from exc
    except UnicodeError as exc:
        raise UserError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise UserError(f"could not read {path}: {exc}") from exc

    return list(headers), rows


def decimal_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"invalid numeric value at row {row_number}, column {column!r}: blank")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise UserError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise UserError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def decimal_text(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def analyze(
    headers: Sequence[str],
    numbered_rows: Sequence[tuple[int, dict[str, str]]],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    requested = [column for column, _ in filters]
    requested += list(sum_columns) + list(avg_columns)
    if group_by is not None:
        requested.append(group_by)
    check_columns(headers, requested)

    rows = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]
    if not sum_columns and not avg_columns:
        return list(headers), [row for _, row in rows]

    assert group_by is not None
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        values = {
            column: decimal_cell(row[column], row_number, column)
            for column in numeric_columns
        }
        bucket = groups.setdefault(
            row[group_by], {column: [] for column in numeric_columns}
        )
        for column, value in values.items():
            bucket[column].append(value)

    output_headers = [group_by]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result: dict[str, str] = {group_by: group_value}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_text(sum(values[column], Decimal(0)))
        for column in avg_columns:
            with localcontext() as context:
                context.prec = max(28, sum(len(v.as_tuple().digits) for v in values[column]) + 8)
                average = sum(values[column], Decimal(0)) / len(values[column])
            result[f"avg_{column}"] = decimal_text(average)
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    json.dump(rows, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(
    headers: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO
) -> None:
    writer = csv.DictWriter(
        stream, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(Path(args.input))
    output_headers, rows = analyze(
        headers,
        numbered_rows,
        filters,
        args.group_by,
        args.sum_columns,
        args.avg_columns,
    )
    if args.output == "csv":
        emit_csv(output_headers, rows, sys.stdout)
    else:
        emit_json(rows, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

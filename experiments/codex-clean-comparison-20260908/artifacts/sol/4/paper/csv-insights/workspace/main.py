#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An error caused by invalid input or command-line options."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
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


def check_columns(headers: list[str], requested: Sequence[tuple[str, str]]) -> None:
    known = set(headers)
    for option, column in requested:
        if column not in known:
            raise UserError(f"unknown column {column!r} for {option}")


def decimal_string(value: Decimal) -> str:
    """Return a non-exponential decimal string without insignificant zeroes."""
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def read_csv(
    stream: TextIO,
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    reader = csv.reader(stream, strict=True)
    try:
        headers = next(reader)
    except StopIteration:
        raise UserError("input CSV is empty; a header row is required") from None
    except csv.Error as exc:
        raise UserError(f"malformed CSV header: {exc}") from exc

    if not headers:
        raise UserError("input CSV header row is empty")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if not name]
    if empty_positions:
        raise UserError(
            "CSV headers must be non-empty (empty header at column "
            + ", ".join(empty_positions)
            + ")"
        )
    duplicates = sorted({name for name in headers if headers.count(name) > 1})
    if duplicates:
        raise UserError("CSV headers must be unique (duplicate: " + ", ".join(map(repr, duplicates)) + ")")

    requested = [("--where", column) for column, _ in filters]
    if group_by is not None:
        requested.append(("--group-by", group_by))
    if sum_column is not None:
        requested.append(("--sum", sum_column))
    if avg_column is not None:
        requested.append(("--avg", avg_column))
    check_columns(headers, requested)

    positions = {name: index for index, name in enumerate(headers)}
    filtered: list[dict[str, str]] = []
    try:
        for record_number, fields in enumerate(reader, start=2):
            if len(fields) != len(headers):
                raise UserError(
                    f"row {record_number} has {len(fields)} fields; expected {len(headers)}"
                )
            if all(fields[positions[column]] == value for column, value in filters):
                filtered.append(dict(zip(headers, fields)))
    except csv.Error as exc:
        # line_num is useful for records containing embedded newlines.
        raise UserError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc

    return headers, filtered


def aggregate(
    rows: Sequence[dict[str, str]],
    group_by: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = defaultdict(
        lambda: {column: [] for column in numeric_columns}
    )

    for row_number, row in enumerate(rows, start=2):
        group = row[group_by]
        for column in numeric_columns:
            raw = row[column]
            try:
                value = Decimal(raw)
            except InvalidOperation:
                raise UserError(
                    f"invalid numeric value at row {row_number}, column {column!r}: {raw!r}"
                ) from None
            if not value.is_finite():
                raise UserError(
                    f"invalid numeric value at row {row_number}, column {column!r}: {raw!r}"
                )
            groups[group][column].append(value)

    output_headers = [group_by]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    results: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_by: group}
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(sum(groups[group][sum_column], Decimal(0)))
        if avg_column:
            values = groups[group][avg_column]
            result[f"avg_{avg_column}"] = decimal_string(
                sum(values, Decimal(0)) / Decimal(len(values))
            )
        results.append(result)
    return output_headers, results


def emit(headers: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=headers,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise UserError("--group-by requires --sum and/or --avg")

    filters = parse_filters(args.where)
    path = Path(args.input)
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            headers, rows = read_csv(
                stream,
                filters,
                args.group_by,
                args.sum_column,
                args.avg_column,
            )
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot read {path}: {exc}") from exc

    if args.group_by:
        headers, rows = aggregate(
            rows, args.group_by, args.sum_column, args.avg_column
        )
    emit(headers, rows, args.output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""A small, dependency-free command-line CSV analytics tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CSVInsightsError(Exception):
    """An expected input or command-line error."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="exact-match filter; may be repeated",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
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


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CSVInsightsError("input is empty: a header row is required")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if not name]
    if empty_positions:
        raise CSVInsightsError(
            "header names must be non-empty; empty header at column "
            + ", ".join(empty_positions)
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CSVInsightsError(
            "header names must be unique; duplicate header(s): "
            + ", ".join(repr(name) for name in duplicates)
        )


def validate_columns(headers: list[str], requested: Sequence[tuple[str, str]]) -> None:
    known = set(headers)
    for purpose, column in requested:
        if column not in known:
            raise CSVInsightsError(f"unknown column for {purpose}: {column!r}")


def read_filtered_rows(
    source: TextIO, filters: Sequence[tuple[str, str]]
) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(source, strict=True)
    try:
        headers = next(reader)
    except StopIteration:
        raise CSVInsightsError("input is empty: a header row is required") from None
    except csv.Error as exc:
        raise CSVInsightsError(f"malformed CSV header: {exc}") from exc

    validate_headers(headers)
    validate_columns(headers, [("--where", column) for column, _ in filters])

    rows: list[tuple[int, dict[str, str]]] = []
    record_number = 1
    try:
        for fields in reader:
            record_number += 1
            if len(fields) != len(headers):
                raise CSVInsightsError(
                    f"row {record_number} has {len(fields)} fields; "
                    f"expected {len(headers)}"
                )
            row = dict(zip(headers, fields))
            if all(row[column] == value for column, value in filters):
                rows.append((record_number, row))
    except csv.Error as exc:
        raise CSVInsightsError(f"malformed CSV near row {record_number + 1}: {exc}") from exc
    return headers, rows


def parse_number(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, object]] = {}

    for row_number, row in rows:
        values = {
            column: parse_number(row[column], row_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(
            row[group_column],
            {"count": 0, "totals": {column: Decimal(0) for column in numeric_columns}},
        )
        group["count"] = int(group["count"]) + 1
        totals = group["totals"]
        assert isinstance(totals, dict)
        for column, number in values.items():
            totals[column] += number

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        group = groups[group_value]
        totals = group["totals"]
        assert isinstance(totals, dict)
        result = {group_column: group_value}
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(totals[sum_column])
        if avg_column:
            with localcontext() as context:
                context.prec = max(28, len(totals[avg_column].as_tuple().digits) + 28)
                average = totals[avg_column] / int(group["count"])
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]], destination: TextIO) -> None:
    json.dump(rows, destination, ensure_ascii=False, separators=(",", ":"))
    destination.write("\n")


def emit_csv(
    headers: Sequence[str], rows: Sequence[dict[str, str]], destination: TextIO
) -> None:
    writer = csv.DictWriter(destination, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CSVInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CSVInsightsError("--group-by requires --sum and/or --avg")

    filters = parse_filters(args.where)
    input_path = Path(args.input)
    try:
        with input_path.open("r", encoding="utf-8", newline="") as source:
            headers, numbered_rows = read_filtered_rows(source, filters)
    except OSError as exc:
        raise CSVInsightsError(f"cannot read {args.input!r}: {exc}") from exc
    except UnicodeError as exc:
        raise CSVInsightsError(f"input is not valid UTF-8: {exc}") from exc

    requested: list[tuple[str, str]] = []
    if args.group_by:
        requested.append(("--group-by", args.group_by))
    if args.sum_column:
        requested.append(("--sum", args.sum_column))
    if args.avg_column:
        requested.append(("--avg", args.avg_column))
    validate_columns(headers, requested)

    if args.group_by:
        output_headers, output_rows = aggregate_rows(
            numbered_rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in numbered_rows]

    if args.output == "json":
        emit_json(output_rows, sys.stdout)
    else:
        emit_csv(output_headers, output_rows, sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CSVInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

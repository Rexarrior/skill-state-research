#!/usr/bin/env python3
"""Dependency-free command-line analytics for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An expected input or command-line error."""


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
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
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


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    for position, header in enumerate(headers, start=1):
        if header == "":
            raise CsvInsightsError(f"header column {position} is empty")
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"duplicate header column(s): {names}")


def require_columns(headers: list[str], columns: Sequence[str | None]) -> None:
    known = set(headers)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        stream = path.open("r", encoding="utf-8-sig", newline="")
    except (OSError, UnicodeError) as error:
        raise CsvInsightsError(f"cannot open {path}: {error}") from error

    try:
        with stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration as error:
                raise CsvInsightsError("input is empty") from error
            validate_headers(headers)
            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append((record_number, row))
            return headers, rows
    except csv.Error as error:
        raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {error}") from error
    except UnicodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from error


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        value = Decimal(text)
    except InvalidOperation as error:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from error
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def filtered_rows(
    headers: list[str], rows: list[tuple[int, list[str]]], filters: list[tuple[str, str]]
) -> list[tuple[int, list[str]]]:
    indices = [(headers.index(column), value) for column, value in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == expected for index, expected in indices)
    ]


def aggregate(
    headers: list[str],
    rows: list[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(group_column)
    numeric_columns = list(
        dict.fromkeys(column for column in (sum_column, avg_column) if column is not None)
    )
    numeric_indices = {column: headers.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = row[group_index]
        values = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            values[column].append(decimal_value(row[numeric_indices[column]], row_number, column))

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        result = [group]
        # Size the context from the actual input so large exact sums are not rounded.
        digit_count = sum(
            len(value.as_tuple().digits)
            for column_values in groups[group].values()
            for value in column_values
        )
        with localcontext() as context:
            context.prec = max(28, digit_count + 10)
            if sum_column:
                result.append(decimal_string(sum(groups[group][sum_column], Decimal(0))))
            if avg_column:
                values = groups[group][avg_column]
                average = sum(values, Decimal(0)) / Decimal(len(values))
                result.append(decimal_string(average))
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(headers: list[str], rows: Sequence[Sequence[str]], output: TextIO) -> None:
    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, output, ensure_ascii=False, indent=2)
    output.write("\n")


def emit_csv(headers: list[str], rows: Sequence[Sequence[str]], output: TextIO) -> None:
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(arguments: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(arguments)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")

    try:
        filters = parse_filters(args.where)
        headers, numbered_rows = read_csv(Path(args.input))
        require_columns(
            headers,
            [column for column, _ in filters]
            + [args.group_by, args.sum_column, args.avg_column],
        )
        selected = filtered_rows(headers, numbered_rows, filters)
        if args.group_by:
            output_headers, output_rows = aggregate(
                headers, selected, args.group_by, args.sum_column, args.avg_column
            )
        else:
            output_headers = headers
            output_rows = [row for _, row in selected]

        if args.output == "json":
            emit_json(output_headers, output_rows, sys.stdout)
        else:
            emit_csv(output_headers, output_rows, sys.stdout)
        return 0
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())

#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


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
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
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
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        filters.append((column, value))
    return filters


def require_columns(headers: Sequence[str], columns: Sequence[tuple[str, str]]) -> None:
    known = set(headers)
    for option, column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} for {option}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        stream = path.open("r", encoding="utf-8", newline="")
    except OSError as error:
        raise CsvInsightsError(f"cannot read {path}: {error}") from error

    try:
        with stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input has no header row") from None
            except csv.Error as error:
                raise CsvInsightsError(f"malformed CSV header: {error}") from error

            if not headers:
                raise CsvInsightsError("input has no header row")
            empty_positions = [str(index) for index, name in enumerate(headers, 1) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty at column {', '.join(empty_positions)})"
                )
            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, dict[str, str]]] = []
            try:
                for row_number, fields in enumerate(reader, start=2):
                    if len(fields) != len(headers):
                        raise CsvInsightsError(
                            f"row {row_number} has {len(fields)} fields; "
                            f"expected {len(headers)}"
                        )
                    rows.append((row_number, dict(zip(headers, fields))))
            except csv.Error as error:
                raise CsvInsightsError(
                    f"malformed CSV near physical line {reader.line_num}: {error}"
                ) from error
            return headers, rows
    except UnicodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from error


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def format_decimal(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        values = {
            column: decimal_value(row[column], row_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column, value in values.items():
            group[column].append(value)

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    result: list[dict[str, str]] = []
    for group_value in sorted(groups):
        item = {group_column: group_value}
        if sum_column:
            item[f"sum_{sum_column}"] = format_decimal(sum(groups[group_value][sum_column], Decimal(0)))
        if avg_column:
            values = groups[group_value][avg_column]
            item[f"avg_{avg_column}"] = format_decimal(
                sum(values, Decimal(0)) / Decimal(len(values))
            )
        result.append(item)
    return output_headers, result


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=headers,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(arguments: argparse.Namespace) -> None:
    if (arguments.sum_column or arguments.avg_column) and not arguments.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(arguments.where)
    headers, numbered_rows = read_csv(Path(arguments.input))
    requested_columns: list[tuple[str, str]] = [
        ("--where", column) for column, _ in filters
    ]
    requested_columns.extend(
        (option, column)
        for option, column in (
            ("--group-by", arguments.group_by),
            ("--sum", arguments.sum_column),
            ("--avg", arguments.avg_column),
        )
        if column is not None
    )
    require_columns(headers, requested_columns)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if arguments.group_by:
        output_headers, output_rows = aggregate(
            filtered,
            arguments.group_by,
            arguments.sum_column,
            arguments.avg_column,
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if arguments.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_headers, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        run(arguments)
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

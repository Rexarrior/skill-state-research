#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def fail(message: str) -> NoReturn:
    raise CsvInsightsError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to sum (repeatable)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to average (repeatable)",
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    return parser


def validate_headers(headers: list[str]) -> None:
    if not headers:
        fail("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if name == ""]
    if empty_positions:
        fail(f"header names must be non-empty (empty field at position {', '.join(empty_positions)})")
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        fail(f"header names must be unique (duplicate: {', '.join(repr(x) for x in duplicates)})")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                fail("input is empty; expected a header row")
            validate_headers(headers)
            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    fail(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, row))
            return headers, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        fail(f"malformed CSV near line {getattr(reader, 'line_num', '?')}: {exc}")
    except UnicodeError as exc:
        fail(f"input is not valid UTF-8: {exc}")
    except OSError as exc:
        fail(f"cannot read {path}: {exc}")


def require_column(name: str, indexes: dict[str, int], context: str) -> int:
    try:
        return indexes[name]
    except KeyError:
        fail(f"unknown column {name!r} in {context}")


def parse_filters(raw_filters: Sequence[str], indexes: dict[str, int]) -> list[tuple[int, str]]:
    filters: list[tuple[int, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            fail(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if column == "":
            fail(f"malformed filter {expression!r}; column name is empty")
        filters.append((require_column(column, indexes, "--where"), value))
    return filters


def decimal_value(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        fail(f"row {record_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        fail(f"row {record_number}, column {column!r}: invalid numeric value {value!r}")
    if not number.is_finite():
        fail(f"row {record_number}, column {column!r}: invalid numeric value {value!r}")
    return number


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: Sequence[tuple[int, list[str]]],
    headers: Sequence[str],
    indexes: dict[str, int],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = require_column(group_column, indexes, "--group-by")
    for column in sum_columns:
        require_column(column, indexes, "--sum")
    for column in avg_columns:
        require_column(column, indexes, "--avg")

    output_headers = [group_column]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    if len(output_headers) != len(set(output_headers)):
        fail("aggregation options produce duplicate output column names")

    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, tuple[dict[str, Decimal], int]] = {}
    for record_number, row in rows:
        values = {
            column: decimal_value(row[indexes[column]], record_number, column)
            for column in numeric_columns
        }
        key = row[group_index]
        if key not in groups:
            groups[key] = ({column: Decimal(0) for column in numeric_columns}, 0)
        totals, count = groups[key]
        for column, value in values.items():
            totals[column] += value
        groups[key] = (totals, count + 1)

    result: list[dict[str, str]] = []
    for key in sorted(groups):
        totals, count = groups[key]
        item = {group_column: key}
        for column in sum_columns:
            item[f"sum_{column}"] = format_decimal(totals[column])
        for column in avg_columns:
            item[f"avg_{column}"] = format_decimal(totals[column] / Decimal(count))
        result.append(item)
    return output_headers, result


def emit_json(rows: Sequence[dict[str, str]], output: TextIO) -> None:
    json.dump(rows, output, ensure_ascii=False)
    output.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]], output: TextIO) -> None:
    writer = csv.DictWriter(output, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(arguments: argparse.Namespace, output: TextIO) -> None:
    if (arguments.sum_columns or arguments.avg_columns) and arguments.group_by is None:
        fail("--sum and --avg require --group-by")
    if arguments.group_by is not None and not (arguments.sum_columns or arguments.avg_columns):
        fail("--group-by requires at least one --sum or --avg")

    headers, numbered_rows = read_csv(Path(arguments.input))
    indexes = {name: index for index, name in enumerate(headers)}
    filters = parse_filters(arguments.where, indexes)

    filtered = [
        (record_number, row)
        for record_number, row in numbered_rows
        if all(row[index] == value for index, value in filters)
    ]
    if arguments.group_by is not None:
        output_headers, result = aggregate(
            filtered,
            headers,
            indexes,
            arguments.group_by,
            arguments.sum_columns,
            arguments.avg_columns,
        )
    else:
        output_headers = headers
        result = [dict(zip(headers, row)) for _, row in filtered]

    if arguments.output == "json":
        emit_json(result, output)
    else:
        emit_csv(output_headers, result, output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        run(arguments, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

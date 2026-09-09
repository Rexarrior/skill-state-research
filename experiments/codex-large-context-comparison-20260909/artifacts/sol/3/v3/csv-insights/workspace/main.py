#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics command line tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise CsvInsightsError(f"invalid arguments: {message}")


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate CSV data.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
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
                f"malformed filter {expression!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str] | None) -> list[str]:
    if headers is None:
        raise CsvInsightsError("malformed input: CSV file is empty")
    if not headers:
        raise CsvInsightsError("malformed input: header row is empty")

    empty_positions = [str(index + 1) for index, name in enumerate(headers) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "malformed input: empty header at column " + ", ".join(empty_positions)
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"malformed input: duplicate header(s): {rendered}")
    return headers


def read_csv(path: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = open(path, "r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read input {path!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = validate_headers(next(reader, None))
                rows: list[tuple[int, dict[str, str]]] = []
                for record_number, values in enumerate(reader, start=2):
                    if len(values) != len(headers):
                        raise CsvInsightsError(
                            f"malformed input: row {record_number} has {len(values)} fields; "
                            f"expected {len(headers)}"
                        )
                    rows.append((record_number, dict(zip(headers, values))))
                return headers, rows
            except csv.Error as exc:
                line = getattr(reader, "line_num", 0)
                location = f" near physical line {line}" if line else ""
                raise CsvInsightsError(f"malformed input{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"cannot decode input {path!r} as UTF-8: {exc}") from exc


def require_known_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, object]] = {}

    for row_number, row in rows:
        group = row[group_column]
        if group not in groups:
            groups[group] = {
                "totals": {column: Decimal(0) for column in numeric_columns},
                "count": 0,
            }
        state = groups[group]
        totals = state["totals"]
        assert isinstance(totals, dict)
        for column in numeric_columns:
            totals[column] += decimal_value(row[column], row_number, column)
        state["count"] = int(state["count"]) + 1

    output_headers = [group_column]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []

    for group in sorted(groups):
        state = groups[group]
        totals = state["totals"]
        count = int(state["count"])
        assert isinstance(totals, dict)
        result: OrderedDict[str, str] = OrderedDict([(group_column, group)])
        for column in sum_columns:
            result[f"sum_{column}"] = format_decimal(totals[column])
        for column in avg_columns:
            result[f"avg_{column}"] = format_decimal(totals[column] / count)
        output_rows.append(dict(result))
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    json.dump(rows, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(args.input)
    referenced = [column for column, _ in filters]
    if args.group_by:
        referenced.append(args.group_by)
    referenced.extend(args.sum_columns)
    referenced.extend(args.avg_columns)
    require_known_columns(headers, referenced)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.sum_columns or args.avg_columns:
        output_headers, output_rows = aggregate(
            filtered,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows, sys.stdout)
    else:
        emit_csv(output_headers, output_rows, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

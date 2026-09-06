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
from typing import TextIO


class CsvInsightsError(Exception):
    """An error suitable for displaying to a command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(f"invalid arguments: {message}")


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate a CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="group rows by column")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
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
                f"malformed filter {expression!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_columns(columns: Sequence[str], headers: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    with handle:
        reader = csv.reader(handle, strict=True)
        try:
            headers = next(reader)
        except StopIteration as exc:
            raise CsvInsightsError("input CSV is empty") from exc
        except (csv.Error, UnicodeError) as exc:
            raise CsvInsightsError(f"malformed CSV near row 1: {exc}") from exc

        if not headers:
            raise CsvInsightsError("header row must contain at least one column")
        for index, header in enumerate(headers, start=1):
            if header == "":
                raise CsvInsightsError(f"header {index} must not be empty")
        duplicates = sorted({name for name in headers if headers.count(name) > 1})
        if duplicates:
            raise CsvInsightsError(
                "duplicate header name(s): " + ", ".join(repr(name) for name in duplicates)
            )

        rows: list[tuple[int, list[str]]] = []
        logical_row = 1
        try:
            for values in reader:
                logical_row += 1
                if len(values) != len(headers):
                    raise CsvInsightsError(
                        f"row {logical_row} has {len(values)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((logical_row, values))
        except csv.Error as exc:
            raise CsvInsightsError(
                f"malformed CSV near physical line {reader.line_num}: {exc}"
            ) from exc
        except UnicodeError as exc:
            raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    return headers, rows


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


def format_decimal(number: Decimal) -> str:
    if number == 0:
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def selected_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(headers.index(column), value) for column, value in filters]
    return [
        (row_number, values)
        for row_number, values in rows
        if all(values[index] == expected for index, expected in indexes)
    ]


def aggregate(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(group_column)
    metric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    metric_indexes = {column: headers.index(column) for column in metric_columns}
    groups: dict[str, dict[str, Decimal | int]] = {}

    for row_number, values in rows:
        group = values[group_index]
        state = groups.setdefault(
            group,
            {**{column: Decimal(0) for column in metric_columns}, "__count": 0},
        )
        state["__count"] = int(state["__count"]) + 1
        for column in metric_columns:
            state[column] = Decimal(state[column]) + decimal_value(
                values[metric_indexes[column]], row_number, column
            )

    output_headers = [group_column]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[list[str]] = []
    for group in sorted(groups):
        state = groups[group]
        count = int(state["__count"])
        values = [group]
        values.extend(format_decimal(Decimal(state[column])) for column in sum_columns)
        values.extend(
            format_decimal(Decimal(state[column]) / count) for column in avg_columns
        )
        output_rows.append(values)
    return output_headers, output_rows


def emit_json(headers: Sequence[str], rows: Sequence[Sequence[str]], out: TextIO) -> None:
    objects = [dict(zip(headers, values, strict=True)) for values in rows]
    json.dump(objects, out, ensure_ascii=False, separators=(",", ":"))
    out.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[Sequence[str]], out: TextIO) -> None:
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)
    has_aggregation = bool(args.sum_columns or args.avg_columns)
    if has_aggregation and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not has_aggregation:
        raise CsvInsightsError("--group-by requires --sum or --avg")

    headers, numbered_rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    if args.group_by:
        requested_columns.append(args.group_by)
    validate_columns(requested_columns, headers)
    numbered_rows = selected_rows(headers, numbered_rows, filters)

    if has_aggregation:
        output_headers, output_rows = aggregate(
            headers,
            numbered_rows,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_headers = headers
        output_rows = [values for _, values in numbered_rows]

    if args.output == "json":
        emit_json(output_headers, output_rows, sys.stdout)
    else:
        emit_csv(output_headers, output_rows, sys.stdout)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

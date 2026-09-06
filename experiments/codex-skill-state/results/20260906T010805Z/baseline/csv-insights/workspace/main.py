#!/usr/bin/env python3
"""Small, dependency-free command-line analytics tool for CSV files."""

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
    """An error that should be reported to the command-line user."""


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
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file {str(path)!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header row is required") from exc
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

            if not header:
                raise CsvInsightsError("header must contain at least one column")
            empty_positions = [str(index) for index, name in enumerate(header, 1) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty column at position {', '.join(empty_positions)})"
                )

            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, list[str]]] = []
            try:
                for row_number, row in enumerate(reader, start=2):
                    if len(row) != len(header):
                        raise CsvInsightsError(
                            f"row {row_number} has {len(row)} fields; expected {len(header)}"
                        )
                    rows.append((row_number, row))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near physical line {reader.line_num}: {exc}"
                ) from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc

    return header, rows


def require_columns(header: Sequence[str], requested: Sequence[tuple[str, str]]) -> None:
    known = set(header)
    for purpose, column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} in {purpose}")


def decimal_at(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    if number == 0:
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def analyze(
    header: list[str],
    numbered_rows: list[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    positions = {name: index for index, name in enumerate(header)}
    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[positions[column]] == value for column, value in filters)
    ]

    if sum_column is None and avg_column is None:
        return header, [row for _, row in filtered]

    assert group_by is not None
    aggregate_columns = [column for column in (sum_column, avg_column) if column]
    groups: dict[str, tuple[list[Decimal], int]] = {}
    for row_number, row in filtered:
        group = row[positions[group_by]]
        values = [decimal_at(row[positions[column]], row_number, column) for column in aggregate_columns]
        if group not in groups:
            groups[group] = ([Decimal(0) for _ in aggregate_columns], 0)
        totals, count = groups[group]
        for index, value in enumerate(values):
            totals[index] += value
        groups[group] = (totals, count + 1)

    output_header = [group_by]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        totals, count = groups[group]
        value_index = 0
        result = [group]
        if sum_column is not None:
            result.append(decimal_string(totals[value_index]))
            value_index += 1
        if avg_column is not None:
            result.append(decimal_string(totals[value_index] / Decimal(count)))
        output_rows.append(result)
    return output_header, output_rows


def emit(header: Sequence[str], rows: Sequence[Sequence[str]], output: str, stream: TextIO) -> None:
    if output == "json":
        objects = [dict(zip(header, row, strict=True)) for row in rows]
        json.dump(objects, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        return

    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    header, rows = read_csv(Path(args.input))
    requested = [("--where", column) for column, _ in filters]
    requested.extend(
        (option, column)
        for option, column in (
            ("--group-by", args.group_by),
            ("--sum", args.sum_column),
            ("--avg", args.avg_column),
        )
        if column is not None
    )
    require_columns(header, requested)
    output_header, output_rows = analyze(
        header, rows, filters, args.group_by, args.sum_column, args.avg_column
    )
    emit(output_header, output_rows, args.output, sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

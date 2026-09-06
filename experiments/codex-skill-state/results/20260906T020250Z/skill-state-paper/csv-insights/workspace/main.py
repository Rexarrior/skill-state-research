#!/usr/bin/env python3
"""Dependency-free CSV filtering and aggregation utility."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, TextIO


class CsvInsightsError(Exception):
    """An error that should be presented to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise CsvInsightsError(message)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument(
        "--where", action="append", default=[], metavar="COLUMN=VALUE"
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    return args


def parse_filters(raw_filters: list[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: column must not be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle: TextIO
        with Path(path).open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

            if not header:
                raise CsvInsightsError("CSV header is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "CSV header contains empty column name(s) at position(s): "
                    + ", ".join(empty_positions)
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "CSV header contains duplicate column(s): "
                    + ", ".join(repr(name) for name in duplicates)
                )

            rows: list[tuple[int, dict[str, str]]] = []
            try:
                for row_number, fields in enumerate(reader, start=2):
                    if len(fields) != len(header):
                        raise CsvInsightsError(
                            f"row {row_number} has {len(fields)} field(s); expected {len(header)}"
                        )
                    rows.append((row_number, dict(zip(header, fields))))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near row {reader.line_num}: {exc}"
                ) from exc
            return header, rows
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path!r}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc


def require_columns(header: list[str], columns: list[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: list[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: list[str],
    avg_columns: list[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(sum_columns + avg_columns))
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for row_number, row in rows:
        values: dict[str, Decimal] = {}
        for column in numeric_columns:
            raw_value = row[column]
            if raw_value == "":
                raise CsvInsightsError(
                    f"row {row_number}, column {column!r}: blank numeric value"
                )
            try:
                value = Decimal(raw_value)
            except InvalidOperation:
                raise CsvInsightsError(
                    f"row {row_number}, column {column!r}: invalid numeric value {raw_value!r}"
                ) from None
            if not value.is_finite():
                raise CsvInsightsError(
                    f"row {row_number}, column {column!r}: invalid numeric value {raw_value!r}"
                )
            values[column] = value

        group = groups.setdefault(
            row[group_by], {column: (Decimal(0), 0) for column in numeric_columns}
        )
        for column, value in values.items():
            total, count = group[column]
            group[column] = (total + value, count + 1)

    output_header = [group_by]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        result = {group_by: group_value}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(groups[group_value][column][0])
        for column in avg_columns:
            total, count = groups[group_value][column]
            result[f"avg_{column}"] = decimal_string(total / count)
        output_rows.append(result)
    return output_header, output_rows


def emit(header: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: list[str]) -> None:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    if args.group_by:
        requested_columns.append(args.group_by)
    require_columns(header, requested_columns)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]
    if args.sum_columns or args.avg_columns:
        output_header, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_header = header
        output_rows = [row for _, row in filtered]
    emit(output_header, output_rows, args.output)


def main() -> int:
    try:
        run(sys.argv[1:])
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

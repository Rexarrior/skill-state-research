#!/usr/bin/env python3
"""A small, dependency-free command-line tool for filtering CSV data."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or command validation error suitable for showing to a user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally aggregate numeric columns."
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
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_options(args: argparse.Namespace) -> None:
    has_aggregation = args.sum_column is not None or args.avg_column is not None
    if has_aggregation and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by is not None and not has_aggregation:
        raise CsvInsightsError("--group-by requires --sum or --avg")


def validate_headers(headers: list[str]) -> None:
    if not headers or any(header == "" for header in headers):
        raise CsvInsightsError("CSV headers must be non-empty")

    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        rendered = ", ".join(repr(header) for header in duplicates)
        raise CsvInsightsError(f"CSV headers must be unique; duplicate: {rendered}")


def validate_columns(
    headers: list[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> None:
    known = set(headers)
    requested = [column for column, _ in filters]
    requested.extend(
        column for column in (group_by, sum_column, avg_column) if column is not None
    )
    for column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")

    generated = []
    if sum_column is not None:
        generated.append(f"sum_{sum_column}")
    if avg_column is not None:
        generated.append(f"avg_{avg_column}")
    if group_by in generated:
        raise CsvInsightsError(
            f"output column {group_by!r} conflicts with the group-by column"
        )


def parse_number(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank cell"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from error
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals without silently rounding long input values."""
    left_tuple = left.as_tuple()
    right_tuple = right.as_tuple()
    common_exponent = min(left_tuple.exponent, right_tuple.exponent)
    left_places = len(left_tuple.digits) + left_tuple.exponent - common_exponent
    right_places = len(right_tuple.digits) + right_tuple.exponent - common_exponent
    with localcontext() as context:
        context.prec = max(1, left_places, right_places) + 1
        return left + right


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def read_and_analyze(
    input_path: Path,
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    with input_path.open("r", encoding="utf-8", newline="") as input_file:
        reader = csv.reader(input_file, strict=True)
        try:
            headers = next(reader)
        except StopIteration as error:
            raise CsvInsightsError("input CSV is empty") from error

        validate_headers(headers)
        validate_columns(headers, filters, group_by, sum_column, avg_column)
        indexes = {header: index for index, header in enumerate(headers)}
        filter_indexes = [(indexes[column], value) for column, value in filters]

        if group_by is None:
            output_rows: list[dict[str, str]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(headers)}"
                    )
                if all(row[index] == value for index, value in filter_indexes):
                    output_rows.append(dict(zip(headers, row)))
            return headers, output_rows

        group_index = indexes[group_by]
        numeric_columns = []
        if sum_column is not None:
            numeric_columns.append(sum_column)
        if avg_column is not None and avg_column != sum_column:
            numeric_columns.append(avg_column)

        groups: dict[str, tuple[int, dict[str, Decimal]]] = {}
        for row_number, row in enumerate(reader, start=2):
            if len(row) != len(headers):
                raise CsvInsightsError(
                    f"row {row_number} has {len(row)} fields; expected {len(headers)}"
                )
            if not all(row[index] == value for index, value in filter_indexes):
                continue

            parsed = {
                column: parse_number(row[indexes[column]], row_number, column)
                for column in numeric_columns
            }
            group_value = row[group_index]
            count, totals = groups.setdefault(group_value, (0, {}))
            for column, number in parsed.items():
                totals[column] = exact_add(totals.get(column, Decimal(0)), number)
            groups[group_value] = (count + 1, totals)

    output_headers = [group_by]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    output_rows = []
    for group_value in sorted(groups):
        count, totals = groups[group_value]
        output_row = {group_by: group_value}
        if sum_column is not None:
            output_row[f"sum_{sum_column}"] = decimal_string(
                totals[sum_column]
            )
        if avg_column is not None:
            total = totals[avg_column]
            output_row[f"avg_{avg_column}"] = decimal_string(total / count)
        output_rows.append(output_row)
    return output_headers, output_rows


def write_output(
    output_format: str,
    headers: Sequence[str],
    rows: Sequence[dict[str, str]],
    stream: TextIO,
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        validate_options(args)
        filters = parse_filters(args.where)
        headers, rows = read_and_analyze(
            Path(args.input),
            filters,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
        write_output(args.output, headers, rows, stdout)
    except (CsvInsightsError, OSError, UnicodeError, csv.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(run())

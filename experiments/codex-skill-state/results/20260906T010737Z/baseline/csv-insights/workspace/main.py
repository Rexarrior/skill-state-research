#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import MAX_EMAX, MIN_EMIN, Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that can be presented directly to a command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate a CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
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


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input is empty; expected a header row")

    empty_positions = [
        str(index) for index, header in enumerate(headers, start=1) if not header
    ]
    if empty_positions:
        raise CsvInsightsError(
            "header names must not be empty (empty field at position "
            + ", ".join(empty_positions)
            + ")"
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        rendered = ", ".join(repr(header) for header in duplicates)
        raise CsvInsightsError(f"header names must be unique; duplicate: {rendered}")


def require_columns(headers: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(headers)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as input_file:
            reader = csv.reader(input_file, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty; expected a header row") from None

            validate_headers(headers)
            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, row))
            return headers, rows
    except CsvInsightsError:
        raise
    except csv.Error as error:
        raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {error}") from error
    except UnicodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from error
    except OSError as error:
        raise CsvInsightsError(f"cannot read {str(path)!r}: {error}") from error


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if not value:
        raise CsvInsightsError(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from error
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def filtered_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    positions = [(headers.index(column), expected) for column, expected in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[position] == expected for position, expected in positions)
    ]


def aggregate_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_position = headers.index(group_column)
    numeric_columns = list(
        dict.fromkeys(column for column in (sum_column, avg_column) if column is not None)
    )
    numeric_positions = {column: headers.index(column) for column in numeric_columns}

    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        group = groups.setdefault(
            row[group_position], {column: [] for column in numeric_columns}
        )
        for column in numeric_columns:
            group[column].append(
                decimal_value(row[numeric_positions[column]], row_number, column)
            )

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        output_row = [group_value]
        all_numbers = [
            number for column in numeric_columns for number in values[column]
        ]
        smallest_exponent = min(number.as_tuple().exponent for number in all_numbers)
        largest_adjusted = max(
            (number.adjusted() for number in all_numbers if number), default=0
        )
        # Include the full span between the largest and smallest decimal places,
        # plus enough carry digits for adding every value. This prevents Decimal's
        # default 28-digit context from silently dropping a small addend.
        precision = max(
            28,
            largest_adjusted
            - smallest_exponent
            + len(str(len(all_numbers)))
            + 2,
        )
        with localcontext() as context:
            context.prec = precision
            context.Emax = MAX_EMAX
            context.Emin = MIN_EMIN
            if sum_column is not None:
                output_row.append(format_decimal(sum(values[sum_column], Decimal(0))))
            if avg_column is not None:
                numbers = values[avg_column]
                average = sum(numbers, Decimal(0)) / Decimal(len(numbers))
                output_row.append(format_decimal(average))
        output_rows.append(output_row)
    return output_headers, output_rows


def emit_json(headers: Sequence[str], rows: Sequence[Sequence[str]], output: TextIO) -> None:
    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, output, ensure_ascii=False, indent=2)
    output.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[Sequence[str]], output: TextIO) -> None:
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(arguments: argparse.Namespace, output: TextIO) -> None:
    filters = parse_filters(arguments.where)
    if (arguments.sum_column or arguments.avg_column) and not arguments.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    headers, numbered_rows = read_csv(Path(arguments.input))
    requested_columns = [
        *(column for column, _ in filters),
        arguments.group_by,
        arguments.sum_column,
        arguments.avg_column,
    ]
    require_columns(headers, requested_columns)
    selected_rows = filtered_rows(headers, numbered_rows, filters)

    if arguments.sum_column or arguments.avg_column:
        result_headers, result_rows = aggregate_rows(
            headers,
            selected_rows,
            arguments.group_by,
            arguments.sum_column,
            arguments.avg_column,
        )
    else:
        result_headers = list(headers)
        result_rows = [row for _, row in selected_rows]

    if arguments.output == "json":
        emit_json(result_headers, result_rows, output)
    else:
        emit_csv(result_headers, result_rows, output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        run(arguments, sys.stdout)
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

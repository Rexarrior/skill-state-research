#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence


class CsvInsightsError(Exception):
    """An input or invocation error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and compute grouped decimal aggregates."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as input_file:
            reader = csv.reader(input_file, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header:
                raise CsvInsightsError("header must contain at least one column")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty (empty at position "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique (duplicate: "
                    + ", ".join(repr(name) for name in duplicates)
                    + ")"
                )

            rows: list[tuple[int, list[str]]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((row_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        line = getattr(reader, "line_num", "unknown")
        raise CsvInsightsError(f"malformed CSV near physical line {line}: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8 near byte {exc.start}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc.strerror or exc}") from exc


def validate_columns(
    parser: argparse.ArgumentParser,
    header: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> None:
    if (sum_columns or avg_columns) and group_by is None:
        parser.error("--sum and --avg require --group-by")

    requested = [column for column, _ in filters]
    requested.extend(sum_columns)
    requested.extend(avg_columns)
    if group_by is not None:
        requested.append(group_by)
    for column in requested:
        if column not in header:
            parser.error(f"unknown column: {column!r}")

    for option, columns in (("--sum", sum_columns), ("--avg", avg_columns)):
        duplicates = sorted({column for column in columns if columns.count(column) > 1})
        if duplicates:
            parser.error(f"{option} repeated for column {duplicates[0]!r}")

    if group_by is not None:
        output_names = [group_by]
        output_names.extend(f"sum_{column}" for column in sum_columns)
        output_names.extend(f"avg_{column}" for column in avg_columns)
        if len(output_names) != len(set(output_names)):
            parser.error("aggregation produces duplicate output column names")


def filter_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), value) for column, value in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == value for index, value in indexes)
    ]


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: non-finite numeric value {value!r}"
        )
    return number


def aggregate_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str | Decimal]]]:
    group_index = header.index(group_by)
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    parsed_rows: list[tuple[str, dict[str, Decimal]]] = []
    maximum_digits = 1

    for row_number, row in rows:
        numbers: dict[str, Decimal] = {}
        for column, index in numeric_indexes.items():
            number = parse_decimal(row[index], row_number, column)
            numbers[column] = number
            maximum_digits = max(maximum_digits, len(number.as_tuple().digits))
        parsed_rows.append((row[group_index], numbers))

    groups: dict[str, dict[str, list[Decimal]]] = {}
    for group_value, numbers in parsed_rows:
        group = groups.setdefault(group_value, {column: [] for column in numeric_columns})
        for column, number in numbers.items():
            group[column].append(number)

    result_header = [group_by]
    result_header.extend(f"sum_{column}" for column in sum_columns)
    result_header.extend(f"avg_{column}" for column in avg_columns)
    result: list[dict[str, str | Decimal]] = []
    precision = max(28, maximum_digits + math.ceil(math.log10(len(rows) + 1)) + 10)
    with localcontext() as context:
        context.prec = precision
        for group_value in sorted(groups):
            values = groups[group_value]
            output_row: dict[str, str | Decimal] = {group_by: group_value}
            for column in sum_columns:
                output_row[f"sum_{column}"] = sum(values[column], Decimal(0))
            for column in avg_columns:
                column_values = values[column]
                output_row[f"avg_{column}"] = (
                    sum(column_values, Decimal(0)) / Decimal(len(column_values))
                )
            result.append(output_row)
    return result_header, result


def decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def write_json(rows: Sequence[dict[str, str | Decimal]]) -> None:
    encoded_rows: list[str] = []
    for row in rows:
        fields = []
        for key, value in row.items():
            encoded_value = decimal_text(value) if isinstance(value, Decimal) else json.dumps(value)
            fields.append(f"{json.dumps(key)}: {encoded_value}")
        encoded_rows.append("{" + ", ".join(fields) + "}")
    sys.stdout.write("[" + ", ".join(encoded_rows) + "]\n")


def write_csv(header: Sequence[str], rows: Sequence[dict[str, str | Decimal]]) -> None:
    writer = csv.writer(sys.stdout)
    writer.writerow(header)
    for row in rows:
        writer.writerow(
            decimal_text(value) if isinstance(value, Decimal) else value
            for value in (row[column] for column in header)
        )


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        filters = parse_filters(args.where)
        header, numbered_rows = read_csv(args.input)
        validate_columns(
            parser,
            header,
            filters,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
        filtered = filter_rows(header, numbered_rows, filters)

        if args.sum_columns or args.avg_columns:
            output_header, output_rows = aggregate_rows(
                header,
                filtered,
                args.group_by,
                args.sum_columns,
                args.avg_columns,
            )
        else:
            output_header = list(header)
            output_rows = [dict(zip(header, row)) for _, row in filtered]

        if args.output == "json":
            write_json(output_rows)
        else:
            write_csv(output_header, output_rows)
        return 0
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())

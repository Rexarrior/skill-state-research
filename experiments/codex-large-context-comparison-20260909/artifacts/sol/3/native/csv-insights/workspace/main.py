#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
import sys
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that can be presented directly to a command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    """Argument parser whose errors are also convenient to test."""

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        raise CsvInsightsError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        description="Filter and aggregate an RFC-4180-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="sum a numeric column (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="average a numeric column (repeatable; requires --group-by)",
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
                f"malformed filter {expression!r}: column must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input is empty; a header row is required")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
    if empty_positions:
        raise CsvInsightsError(
            "header names must not be empty (empty column position(s): "
            + ", ".join(empty_positions)
            + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header names must be unique (duplicate(s): {rendered})")


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty; a header row is required")
            validate_headers(header)
            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} field(s); "
                        f"expected {len(header)}"
                    )
                rows.append(row)
            return header, rows
    except CsvInsightsError:
        raise
    except (csv.Error, UnicodeError) as exc:
        raise CsvInsightsError(f"malformed CSV input: {exc}") from exc
    except OSError as exc:
        detail = exc.strerror or str(exc)
        raise CsvInsightsError(f"cannot read {path!r}: {detail}") from exc


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_cell(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: numeric value is blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    """Render a finite Decimal without exponent or insignificant trailing zeroes."""
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def filtered_rows(
    header: Sequence[str], rows: Sequence[list[str]], filters: Sequence[tuple[str, str]]
) -> list[list[str]]:
    positions = [(header.index(column), value) for column, value in filters]
    return [row for row in rows if all(row[index] == value for index, value in positions)]


def aggregate(
    header: Sequence[str],
    rows: Sequence[list[str]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for record_number, row in enumerate(rows, start=2):
        values = {
            column: decimal_cell(row[index], record_number, column)
            for column, index in numeric_indexes.items()
        }
        group = row[group_index]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column, number in values.items():
            bucket[column].append(number)

    output_header = [group_column]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    if len(output_header) != len(set(output_header)):
        raise CsvInsightsError(
            "aggregate output column names are not unique; "
            "remove duplicate aggregate options or choose different columns"
        )
    output_rows: list[list[str]] = []
    for group in sorted(groups):
        bucket = groups[group]
        result = [group]
        result.extend(format_decimal(sum(bucket[column], Decimal(0))) for column in sum_columns)
        result.extend(
            format_decimal(sum(bucket[column], Decimal(0)) / len(bucket[column]))
            for column in avg_columns
        )
        output_rows.append(result)
    return output_header, output_rows


def write_csv(header: Sequence[str], rows: Sequence[Sequence[str]], output: TextIO) -> None:
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def write_json(
    header: Sequence[str],
    rows: Sequence[Sequence[str]],
    output: TextIO,
    numeric_from: int | None = None,
) -> None:
    if numeric_from is None:
        objects = [dict(zip(header, row)) for row in rows]
        json.dump(objects, output, ensure_ascii=False)
        output.write("\n")
        return

    # json.JSONEncoder cannot emit Decimal as a number. Build each small object
    # using json.dumps for keys/string values and verified decimal lexemes for
    # aggregate values, avoiding any conversion through binary float.
    output.write("[")
    for row_number, row in enumerate(rows):
        if row_number:
            output.write(", ")
        fields: list[str] = []
        for index, (key, value) in enumerate(zip(header, row)):
            encoded_value = json.dumps(value, ensure_ascii=False) if index < numeric_from else value
            fields.append(f"{json.dumps(key, ensure_ascii=False)}: {encoded_value}")
        output.write("{" + ", ".join(fields) + "}")
    output.write("]\n")


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    filters = parse_filters(args.where)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    header, rows = read_csv(args.input)
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    if args.group_by is not None:
        requested_columns.append(args.group_by)
    require_columns(header, requested_columns)
    rows = filtered_rows(header, rows, filters)

    aggregated = bool(args.sum_columns or args.avg_columns)
    if aggregated:
        header, rows = aggregate(
            header, rows, args.group_by, args.sum_columns, args.avg_columns
        )

    if args.output == "csv":
        write_csv(header, rows, sys.stdout)
    else:
        write_json(header, rows, sys.stdout, numeric_from=1 if aggregated else None)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

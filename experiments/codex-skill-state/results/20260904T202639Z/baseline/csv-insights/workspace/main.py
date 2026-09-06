#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, DecimalException, InvalidOperation
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or validation error suitable for displaying to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="UTF-8 CSV input file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="exact-match filter; may be repeated and all filters must match",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument(
        "--avg", dest="avg_column", metavar="COLUMN", help="column to average"
    )
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


def read_rows(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header row is required") from exc

            if not header:
                raise CsvInsightsError("header row must contain at least one column")

            empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty header at column "
                    + ", ".join(empty_positions)
                )

            seen: set[str] = set()
            duplicate_names: list[str] = []
            for name in header:
                if name in seen and name not in duplicate_names:
                    duplicate_names.append(name)
                seen.add(name)
            if duplicate_names:
                duplicates = ", ".join(repr(name) for name in duplicate_names)
                raise CsvInsightsError(f"header names must be unique; duplicate: {duplicates}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path!r}: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r}")


def filtered_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    positions = [(header.index(column), value) for column, value in filters]
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[index] == value for index, value in positions)
    ]


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {record_number}, column {column!r}: numeric value is blank")
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


def minimal_decimal(number: Decimal) -> str:
    if number == 0:
        return "0"
    result = format(number, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    numeric_columns = list(dict.fromkeys(column for column in (sum_column, avg_column) if column))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}

    # Each group stores its row count and a Decimal total for every requested column.
    groups: dict[str, tuple[int, dict[str, Decimal]]] = {}
    for record_number, row in rows:
        parsed = {
            column: parse_decimal(row[index], record_number, column)
            for column, index in numeric_indexes.items()
        }
        group = row[group_index]
        count, totals = groups.setdefault(
            group, (0, {column: Decimal(0) for column in numeric_columns})
        )
        try:
            for column, number in parsed.items():
                totals[column] += number
        except DecimalException as exc:
            raise CsvInsightsError(
                f"row {record_number}, column {column!r}: decimal arithmetic failed: {exc}"
            ) from exc
        groups[group] = (count + 1, totals)

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")
    if len(output_header) != len(set(output_header)):
        raise CsvInsightsError("aggregation creates duplicate output column names")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        count, totals = groups[group]
        output_row = [group]
        if sum_column:
            output_row.append(minimal_decimal(totals[sum_column]))
        if avg_column:
            try:
                average = totals[avg_column] / Decimal(count)
            except DecimalException as exc:
                raise CsvInsightsError(
                    f"group {group!r}, column {avg_column!r}: decimal arithmetic failed: {exc}"
                ) from exc
            output_row.append(minimal_decimal(average))
        output_rows.append(output_row)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    objects = [dict(zip(header, row, strict=True)) for row in rows]
    json.dump(objects, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    writer = csv.writer(sys.stdout, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(arguments: argparse.Namespace) -> None:
    filters = parse_filters(arguments.where)
    header, rows = read_rows(arguments.input)

    referenced_columns = [column for column, _ in filters]
    referenced_columns.extend(
        column
        for column in (arguments.group_by, arguments.sum_column, arguments.avg_column)
        if column is not None
    )
    require_columns(header, referenced_columns)
    rows = filtered_rows(header, rows, filters)

    if arguments.sum_column or arguments.avg_column:
        output_header, output_rows = aggregate(
            header,
            rows,
            arguments.group_by,
            arguments.sum_column,
            arguments.avg_column,
        )
    else:
        output_header = header
        output_rows = [row for _, row in rows]

    if arguments.output == "json":
        emit_json(output_header, output_rows)
    else:
        emit_csv(output_header, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if (arguments.sum_column or arguments.avg_column) and not arguments.group_by:
        parser.error("--sum and --avg require --group-by")

    try:
        run(arguments)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

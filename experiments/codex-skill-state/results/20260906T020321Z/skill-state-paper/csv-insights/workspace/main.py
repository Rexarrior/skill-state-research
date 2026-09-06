#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation tool."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or processing error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
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


def validate_arguments(args: argparse.Namespace) -> list[tuple[str, str]]:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CsvInsightsError("--group-by requires --sum, --avg, or both")
    return parse_filters(args.where)


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header or any(name == "" for name in header):
                raise CsvInsightsError("CSV headers must be non-empty")
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                rendered = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"CSV headers must be unique; duplicate: {rendered}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        line = f" near physical line {getattr(reader, 'line_num', '?')}"
        raise CsvInsightsError(f"malformed CSV{line}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def column_indexes(header: Sequence[str], columns: Sequence[str]) -> dict[str, int]:
    indexes = {name: index for index, name in enumerate(header)}
    for column in columns:
        if column not in indexes:
            raise CsvInsightsError(f"unknown column: {column!r}")
    return indexes


def filter_rows(
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
    indexes: dict[str, int],
) -> list[tuple[int, list[str]]]:
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[indexes[column]] == value for column, value in filters)
    ]


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {record_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {record_number}, "
            f"column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {record_number}, "
            f"column {column!r}: {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate(
    rows: Sequence[tuple[int, list[str]]],
    indexes: dict[str, int],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    # Values are retained per group so precision can be sized before arithmetic;
    # this avoids the default Decimal context rounding otherwise exact sums.
    groups: dict[str, dict[str, list[Decimal]]] = {}
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    for record_number, row in rows:
        group = row[indexes[group_column]]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            bucket[column].append(
                parse_decimal(row[indexes[column]], record_number, column)
            )

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    results: list[dict[str, str]] = []
    for group in sorted(groups):
        values_by_column = groups[group]
        all_values = [value for values in values_by_column.values() for value in values]
        precision = max(
            28,
            sum(max(1, len(value.as_tuple().digits)) for value in all_values) + 10,
        )
        with localcontext() as context:
            context.prec = precision
            result = {group_column: group}
            if sum_column:
                total = sum(values_by_column[sum_column], Decimal(0))
                result[f"sum_{sum_column}"] = decimal_string(total)
            if avg_column:
                values = values_by_column[avg_column]
                average = sum(values, Decimal(0)) / Decimal(len(values))
                result[f"avg_{avg_column}"] = decimal_string(average)
        results.append(result)
    return output_header, results


def write_output(
    output_format: str,
    header: Sequence[str],
    records: Sequence[dict[str, str]],
    destination: TextIO,
) -> None:
    if output_format == "json":
        json.dump(records, destination, ensure_ascii=False)
        destination.write("\n")
        return
    writer = csv.DictWriter(destination, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        filters = validate_arguments(args)
        header, rows = read_csv(Path(args.input))
        referenced = [column for column, _ in filters]
        referenced.extend(
            column
            for column in (args.group_by, args.sum_column, args.avg_column)
            if column is not None
        )
        indexes = column_indexes(header, referenced)
        selected = filter_rows(rows, filters, indexes)

        if args.group_by:
            output_header, records = aggregate(
                selected,
                indexes,
                args.group_by,
                args.sum_column,
                args.avg_column,
            )
        else:
            output_header = header
            records = [dict(zip(header, row)) for _, row in selected]
        write_output(args.output, output_header, records, sys.stdout)
        return 0
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(run())

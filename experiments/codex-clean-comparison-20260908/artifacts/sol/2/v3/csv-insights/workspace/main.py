#!/usr/bin/env python3
"""Dependency-free command-line analytics for RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from contextlib import nullcontext
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or invocation error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-4180-style CSV file."
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
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def unique_in_order(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(values))


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


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        source = Path(path).open("r", encoding="utf-8", newline="")
    except (OSError, ValueError) as exc:
        raise CsvInsightsError(f"cannot open input file {path!r}: {exc}") from exc

    with source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader)
        except StopIteration as exc:
            raise CsvInsightsError("input CSV is empty") from exc
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

        if not header:
            raise CsvInsightsError("CSV header is empty")
        empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
        if empty_positions:
            raise CsvInsightsError(
                "CSV header contains an empty column name at position(s) "
                + ", ".join(empty_positions)
            )
        duplicate_names = unique_in_order(
            [name for index, name in enumerate(header) if name in header[:index]]
        )
        if duplicate_names:
            raise CsvInsightsError(
                "CSV header contains duplicate column name(s): "
                + ", ".join(repr(name) for name in duplicate_names)
            )

        rows: list[tuple[int, list[str]]] = []
        try:
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
        except csv.Error as exc:
            raise CsvInsightsError(
                f"malformed CSV near input line {reader.line_num}: {exc}"
            ) from exc
        except UnicodeError as exc:
            raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc

    return header, rows


def validate_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    unknown = unique_in_order([column for column in columns if column not in known])
    if unknown:
        raise CsvInsightsError(
            "unknown column(s): " + ", ".join(repr(column) for column in unknown)
        )


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite decimals without applying the active Decimal context."""
    if not values:
        return Decimal(0)
    exponent = min(value.as_tuple().exponent for value in values)
    coefficient = 0
    for value in values:
        parts = value.as_tuple()
        digits = int("".join(str(digit) for digit in parts.digits) or "0")
        if parts.sign:
            digits = -digits
        coefficient += digits * 10 ** (parts.exponent - exponent)
    sign = int(coefficient < 0)
    coefficient_digits = tuple(int(digit) for digit in str(abs(coefficient)))
    return Decimal((sign, coefficient_digits, exponent))


def division_precision(total: Decimal, count: int) -> int:
    """Provide ample deterministic precision for a Decimal average."""
    parts = total.as_tuple()
    integer_digits = max(1, len(parts.digits) + parts.exponent)
    fractional_digits = max(0, -parts.exponent)
    return max(28, integer_digits + fractional_digits + len(str(count)) + 28)


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: blank numeric value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: "
            f"invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: "
            f"invalid numeric value {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def filter_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    positions = {name: index for index, name in enumerate(header)}
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[positions[column]] == value for column, value in filters)
    ]


def aggregate_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    positions = {name: index for index, name in enumerate(header)}
    numeric_columns = unique_in_order([*sum_columns, *avg_columns])
    groups: dict[str, dict[str, list[Decimal]]] = defaultdict(
        lambda: {column: [] for column in numeric_columns}
    )

    for record_number, row in rows:
        group = row[positions[group_by]]
        for column in numeric_columns:
            groups[group][column].append(
                parse_decimal(row[positions[column]], record_number, column)
            )

    output_header = [
        group_by,
        *(f"sum_{column}" for column in sum_columns),
        *(f"avg_{column}" for column in avg_columns),
    ]
    if len(output_header) != len(set(output_header)):
        raise CsvInsightsError(
            "aggregation produces duplicate output column names; "
            "remove repeated or conflicting aggregate columns"
        )

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        group_values = groups[group]
        row = [group]
        for column in sum_columns:
            values = group_values[column]
            row.append(format_decimal(exact_sum(values)))
        for column in avg_columns:
            values = group_values[column]
            total = exact_sum(values)
            with localcontext() as context:
                context.prec = division_precision(total, len(values))
                row.append(format_decimal(total / Decimal(len(values))))
        output_rows.append(row)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Sequence[Sequence[str]], out: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, out, ensure_ascii=False)
    out.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[Sequence[str]], out: TextIO) -> None:
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    filters = parse_filters(args.where)
    sum_columns = unique_in_order(args.sum_columns)
    avg_columns = unique_in_order(args.avg_columns)
    aggregation_requested = bool(sum_columns or avg_columns)
    if aggregation_requested and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not aggregation_requested:
        parser.error("--group-by requires at least one --sum or --avg")

    header, numbered_rows = read_csv(args.input)
    validate_columns(
        header,
        [*(column for column, _ in filters), *sum_columns, *avg_columns]
        + ([args.group_by] if args.group_by else []),
    )
    filtered_rows = filter_rows(header, numbered_rows, filters)

    if aggregation_requested:
        output_header, output_rows = aggregate_rows(
            header,
            filtered_rows,
            args.group_by,
            sum_columns,
            avg_columns,
        )
    else:
        output_header = list(header)
        output_rows = [row for _, row in filtered_rows]

    if args.output == "json":
        emit_json(output_header, output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)
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

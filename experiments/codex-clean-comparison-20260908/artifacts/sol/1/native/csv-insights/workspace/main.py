#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics command."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, DecimalException, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An expected, user-facing error."""


class ArgumentParser(argparse.ArgumentParser):
    """Make argument errors consistent with all other command errors."""

    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="csv-insights",
        description="Filter CSV rows and optionally calculate grouped sums and averages.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
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
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index) for index, name in enumerate(header, start=1) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty "
            f"(empty field at column {', '.join(empty_positions)})"
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header names must be unique (duplicate: {rendered})")


def require_columns(header: Sequence[str], requested: Sequence[str | None]) -> None:
    available = set(header)
    for column in requested:
        if column is not None and column not in available:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(stream: TextIO, source: str) -> tuple[list[str], list[list[str]]]:
    reader = csv.reader(stream, strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise CsvInsightsError("input has no header row") from None
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV in {source}: {exc}") from None

    validate_header(header)
    rows: list[list[str]] = []
    try:
        for record_number, row in enumerate(reader, start=2):
            if len(row) != len(header):
                raise CsvInsightsError(
                    f"row {record_number} has {len(row)} fields; expected {len(header)}"
                )
            rows.append(row)
    except csv.Error as exc:
        raise CsvInsightsError(
            f"malformed CSV in {source} near physical line {reader.line_num}: {exc}"
        ) from None
    return header, rows


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {record_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    indexes = {name: index for index, name in enumerate(header)}
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")
    if len(output_header) != len(set(output_header)):
        raise CsvInsightsError(
            "generated aggregate column name conflicts with the group column"
        )

    for record_number, row in rows:
        group = row[indexes[group_column]]
        values = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            values[column].append(parse_decimal(row[indexes[column]], record_number, column))

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_column: group}
        # A generous, data-dependent context keeps addition exact for ordinary and
        # very large input coefficients. Repeating averages use Decimal rounding.
        all_values = [number for values in groups[group].values() for number in values]
        if all_values:
            highest_digit = max(number.adjusted() for number in all_values)
            lowest_place = min(number.as_tuple().exponent for number in all_values)
            exact_sum_digits = highest_digit - lowest_place + len(str(len(all_values))) + 2
        else:  # Groups always contain a numeric value, but keep the bound total.
            exact_sum_digits = 28
        with localcontext() as context:
            context.prec = max(28, exact_sum_digits)
            if sum_column:
                total = sum(groups[group][sum_column], Decimal(0))
                result[f"sum_{sum_column}"] = decimal_string(total)
            if avg_column:
                values = groups[group][avg_column]
                average = sum(values, Decimal(0)) / Decimal(len(values))
                result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    json.dump(rows, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None, stdout: TextIO = sys.stdout) -> None:
    args = build_parser().parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    source = args.input
    try:
        with Path(source).open("r", encoding="utf-8", newline="") as stream:
            header, rows = read_csv(stream, source)
    except CsvInsightsError:
        raise
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {source!r}: {exc}") from None

    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    indexes = {name: index for index, name in enumerate(header)}
    filtered = [
        (record_number, row)
        for record_number, row in enumerate(rows, start=2)
        if all(row[indexes[column]] == value for column, value in filters)
    ]

    if args.sum_column or args.avg_column:
        output_header, output_rows = aggregate_rows(
            header, filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = list(header)
        output_rows = [dict(zip(header, row)) for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows, stdout)
    else:
        emit_csv(output_header, output_rows, stdout)


def main() -> int:
    try:
        run()
    except (CsvInsightsError, DecimalException) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

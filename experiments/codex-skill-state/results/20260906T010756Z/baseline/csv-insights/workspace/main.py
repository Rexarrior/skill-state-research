#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where",
        metavar="COLUMN=VALUE",
        action="append",
        default=[],
        help="keep rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
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
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validated_csv_lines(source: TextIO):
    """Yield physical lines while rejecting quotes inside unquoted fields.

    ``csv.reader(strict=True)`` catches unterminated and malformed escaped fields,
    but deliberately accepts a bare quote in an unquoted field. RFC 4180 does
    not, so this small streaming state machine closes that gap.
    """
    state = "field_start"
    for line in source:
        for character in line:
            if state == "quoted":
                if character == '"':
                    state = "after_quote"
            elif state == "after_quote":
                if character == '"':
                    state = "quoted"
                elif character == ",":
                    state = "field_start"
                elif character in "\r\n":
                    state = "field_start"
                else:
                    raise CsvInsightsError(
                        "malformed CSV: unexpected character after closing quote"
                    )
            elif state == "field_start":
                if character == '"':
                    state = "quoted"
                elif character == ",":
                    pass
                elif character in "\r\n":
                    state = "field_start"
                else:
                    state = "unquoted"
            else:  # unquoted
                if character == '"':
                    raise CsvInsightsError("malformed CSV: quote in unquoted field")
                if character == ",":
                    state = "field_start"
                elif character in "\r\n":
                    state = "field_start"
        yield line
    if state == "quoted":
        raise CsvInsightsError("malformed CSV: unexpected end of quoted field")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(validated_csv_lines(source), strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; expected a header") from exc

            if not header:
                raise CsvInsightsError("header must contain at least one column")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty column at position(s) "
                    + ", ".join(empty_positions)
                )

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in header:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                rendered = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"header names must be unique; duplicate(s): {rendered}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} field(s); "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except (OSError, UnicodeError, csv.Error) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[tuple[str, str]]) -> None:
    known = set(header)
    for option, column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} for {option}")


def filter_rows(
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
        raise CsvInsightsError(f"row {record_number}, column {column!r}: blank numeric value")
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


def decimal_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals exactly, independent of the active Decimal context."""
    if not values:
        return Decimal(0)
    common_exponent = min(value.as_tuple().exponent for value in values)
    total = 0
    for value in values:
        parts = value.as_tuple()
        coefficient = int("".join(map(str, parts.digits)) or "0")
        if parts.sign:
            coefficient = -coefficient
        total += coefficient * 10 ** (parts.exponent - common_exponent)
    sign = 1 if total < 0 else 0
    digits = tuple(int(digit) for digit in str(abs(total)))
    return Decimal((sign, digits, common_exponent))


def decimal_avg(total: Decimal, count: int) -> Decimal:
    # Division may repeat. Use at least Decimal's standard 28 significant digits,
    # while allowing large exact inputs enough room before rounding the quotient.
    parts = total.as_tuple()
    precision = max(28, len(parts.digits) + abs(parts.exponent) + len(str(count)) + 2)
    with localcontext() as context:
        context.prec = precision
        return total / count


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
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
    group_index = header.index(group_column)
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for record_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column, index in numeric_indexes.items():
            bucket[column].append(parse_decimal(row[index], record_number, column))

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")
    if len(set(output_header)) != len(output_header):
        raise CsvInsightsError(
            "aggregation produces duplicate output column names; "
            "choose different grouping or numeric columns"
        )

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_column: group}
        totals: dict[str, Decimal] = {}
        if sum_column:
            totals[sum_column] = decimal_sum(groups[group][sum_column])
            result[f"sum_{sum_column}"] = format_decimal(totals[sum_column])
        if avg_column:
            total = totals.get(avg_column)
            if total is None:
                total = decimal_sum(groups[group][avg_column])
            average = decimal_avg(total, len(groups[group][avg_column]))
            result[f"avg_{avg_column}"] = format_decimal(average)
        output_rows.append(result)
    return output_header, output_rows


def write_output(
    output_format: str, header: Sequence[str], rows: Sequence[dict[str, str]]
) -> None:
    if output_format == "json":
        json.dump(list(rows), sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return

    writer = csv.DictWriter(
        sys.stdout, fieldnames=list(header), extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(arguments: argparse.Namespace) -> None:
    filters = parse_filters(arguments.where)
    if (arguments.sum_column or arguments.avg_column) and not arguments.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    header, rows = read_csv(arguments.input)
    requested_columns = [("--where", column) for column, _ in filters]
    requested_columns.extend(
        (option, column)
        for option, column in (
            ("--group-by", arguments.group_by),
            ("--sum", arguments.sum_column),
            ("--avg", arguments.avg_column),
        )
        if column is not None
    )
    require_columns(header, requested_columns)
    selected = filter_rows(header, rows, filters)

    if arguments.sum_column or arguments.avg_column:
        output_header, output_rows = aggregate_rows(
            header,
            selected,
            arguments.group_by,
            arguments.sum_column,
            arguments.avg_column,
        )
    else:
        output_header = header
        output_rows = [dict(zip(header, row)) for _, row in selected]
    write_output(arguments.output, output_header, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        run(arguments)
    except CsvInsightsError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

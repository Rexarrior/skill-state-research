#!/usr/bin/env python3
"""A small, dependency-free CSV filtering and aggregation tool."""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from decimal import (
    MAX_EMAX,
    MIN_EMIN,
    Decimal,
    DecimalException,
    InvalidOperation,
    localcontext,
)
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or processing error suitable for display to the user."""


def validate_quote_placement(content: str) -> None:
    """Reject quote placement that the stdlib CSV reader accepts beyond RFC 4180."""
    START, UNQUOTED, QUOTED, AFTER_QUOTE = range(4)
    state = START
    line = 1
    index = 0
    while index < len(content):
        character = content[index]
        if state == START:
            if character == '"':
                state = QUOTED
            elif character not in ",\r\n":
                state = UNQUOTED
        elif state == UNQUOTED:
            if character == '"':
                raise CsvInsightsError(
                    f"malformed CSV near input line {line}: "
                    "quote in an unquoted field"
                )
            if character == ",":
                state = START
        elif state == QUOTED:
            if character == '"':
                state = AFTER_QUOTE
        else:
            if character == '"':
                state = QUOTED
            elif character == ",":
                state = START
            elif character not in "\r\n":
                raise CsvInsightsError(
                    f"malformed CSV near input line {line}: "
                    "unexpected character after closing quote"
                )

        if state != QUOTED and character in "\r\n":
            state = START
        if character == "\r" and index + 1 < len(content) and content[index + 1] == "\n":
            line += 1
            index += 1
        elif character in "\r\n":
            line += 1
        index += 1

    if state == QUOTED:
        raise CsvInsightsError(
            f"malformed CSV near input line {line}: unexpected end of data"
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally aggregate decimal columns."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        source = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file {path}: {exc}") from exc

    try:
        with source:
            content = source.read()
            validate_quote_placement(content)
            reader = csv.reader(io.StringIO(content, newline=""), strict=True)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input is empty; a header row is required") from exc
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

            if not headers:
                raise CsvInsightsError("header row is empty")
            empty_positions = [
                str(index + 1) for index, name in enumerate(headers) if not name
            ]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty header at column "
                    + ", ".join(empty_positions)
                )

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in headers:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique; duplicate "
                    + ", ".join(repr(name) for name in duplicates)
                )

            rows: list[tuple[int, list[str]]] = []
            try:
                for record_number, row in enumerate(reader, start=2):
                    if len(row) != len(headers):
                        raise CsvInsightsError(
                            f"row {record_number} has {len(row)} fields; "
                            f"expected {len(headers)}"
                        )
                    rows.append((record_number, row))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near input line {reader.line_num}: {exc}"
                ) from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"could not read input file {path}: {exc}") from exc

    return headers, rows


def parse_filters(
    raw_filters: Sequence[str], headers: Sequence[str]
) -> list[tuple[int, str]]:
    positions = {name: index for index, name in enumerate(headers)}
    filters: list[tuple[int, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column name must be non-empty"
            )
        if column not in positions:
            raise CsvInsightsError(f"unknown column in --where: {column!r}")
        filters.append((positions[column], value))
    return filters


def validate_columns(args: argparse.Namespace, headers: Sequence[str]) -> None:
    known = set(headers)
    for option, column in (
        ("--group-by", args.group_by),
        ("--sum", args.sum_column),
        ("--avg", args.avg_column),
    ):
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column for {option}: {column!r}")
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")


def filtered_rows(
    rows: Sequence[tuple[int, list[str]]], filters: Sequence[tuple[int, str]]
) -> list[tuple[int, list[str]]]:
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[index] == expected for index, expected in filters)
    ]


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if not value.strip():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: blank numeric value"
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


def decimal_string(number: Decimal) -> str:
    if number == 0:
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals without rounding them to the default context precision."""
    lowest_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    highest_digit = max(left.adjusted(), right.adjusted())
    precision = max(1, highest_digit - lowest_exponent + 1)
    with localcontext() as context:
        context.prec = precision
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def aggregate(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    positions = {name: index for index, name in enumerate(headers)}
    group_index = positions[group_column]
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))

    # Each group stores (sum, count) for every requested numeric column.
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}
    for record_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {})
        for column in numeric_columns:
            number = parse_decimal(row[positions[column]], record_number, column)
            total, count = bucket.get(column, (Decimal(0), 0))
            try:
                bucket[column] = (exact_add(total, number), count + 1)
            except DecimalException as exc:
                raise CsvInsightsError(
                    f"row {record_number}, column {column!r}: numeric value is out of range"
                ) from exc

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    results: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_column: group}
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(
                groups[group][sum_column][0]
            )
        if avg_column:
            total, count = groups[group][avg_column]
            try:
                average = total / count
            except DecimalException as exc:
                raise CsvInsightsError(
                    f"could not calculate average for group {group!r}, "
                    f"column {avg_column!r}"
                ) from exc
            result[f"avg_{avg_column}"] = decimal_string(average)
        results.append(result)
    return output_headers, results


def emit_json(
    headers: Sequence[str], rows: Sequence[Sequence[str]], output: TextIO
) -> None:
    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, output, ensure_ascii=False)
    output.write("\n")


def emit_csv(
    headers: Sequence[str], rows: Sequence[Sequence[str]], output: TextIO
) -> None:
    writer = csv.writer(output, dialect="excel", lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(args: argparse.Namespace, output: TextIO) -> None:
    headers, rows = read_csv(Path(args.input))
    validate_columns(args, headers)
    filters = parse_filters(args.where, headers)
    selected = filtered_rows(rows, filters)

    if args.sum_column or args.avg_column:
        result_headers, objects = aggregate(
            headers,
            selected,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
        result_rows = [[obj[name] for name in result_headers] for obj in objects]
    else:
        result_headers = headers
        result_rows = [row for _, row in selected]

    if args.output == "json":
        emit_json(result_headers, result_rows, output)
    else:
        emit_csv(result_headers, result_rows, output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

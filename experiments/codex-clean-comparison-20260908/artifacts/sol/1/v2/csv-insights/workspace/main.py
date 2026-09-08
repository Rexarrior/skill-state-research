#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import math
import sys
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where", action="append", default=[], metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json",
        help="output format (default: json)",
    )
    return parser


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    args = build_parser().parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        fail("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        fail("--group-by requires --sum or --avg")
    return args


def validate_headers(headers: list[str]) -> None:
    if not headers:
        fail("input CSV has no header row")
    empty_positions = [str(i) for i, name in enumerate(headers, 1) if name == ""]
    if empty_positions:
        fail(f"header names must be non-empty (column {', '.join(empty_positions)})")
    seen: set[str] = set()
    duplicate: set[str] = set()
    for name in headers:
        if name in seen:
            duplicate.add(name)
        seen.add(name)
    if duplicate:
        fail(f"duplicate header name(s): {', '.join(sorted(duplicate))}")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            fail(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if not column:
            fail(f"malformed filter {expression!r}; column must be non-empty")
        filters.append((column, value))
    return filters


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            fail(f"unknown column: {column}")


def read_csv(path: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = open(Path(path), "r", encoding="utf-8", newline="")
    except OSError as exc:
        fail(f"cannot open {path!r}: {exc.strerror or exc}")

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                fail("input CSV is empty; a header row is required")
            validate_headers(headers)
            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, 2):
                if len(fields) != len(headers):
                    fail(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
            return headers, rows
    except csv.Error as exc:
        fail(f"malformed CSV near line {reader.line_num}: {exc}")
    except UnicodeError as exc:
        fail(f"input is not valid UTF-8: {exc}")


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        fail(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        value = Decimal(text)
    except InvalidOperation:
        fail(f"row {row_number}, column {column!r}: invalid numeric value {text!r}")
    if not value.is_finite():
        fail(f"row {row_number}, column {column!r}: invalid numeric value {text!r}")
    return value


def decimal_text(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def arithmetic_precision(numbers: Sequence[Decimal]) -> int:
    """Return enough precision to add finite decimals without rounding."""
    highest_place = max(number.adjusted() for number in numbers)
    lowest_place = min(number.as_tuple().exponent for number in numbers)
    carry_digits = math.ceil(math.log10(len(numbers) + 1))
    return max(28, highest_place - lowest_place + 1 + carry_digits)


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    requested = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        group = groups.setdefault(row[group_column], {column: [] for column in requested})
        for column in requested:
            group[column].append(decimal_value(row[column], row_number, column))

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result = {group_column: group_value}
        if sum_column:
            numbers = values[sum_column]
            with localcontext() as context:
                context.prec = arithmetic_precision(numbers)
                total = sum(numbers, Decimal(0))
            result[f"sum_{sum_column}"] = decimal_text(total)
        if avg_column:
            numbers = values[avg_column]
            with localcontext() as context:
                context.prec = arithmetic_precision(numbers)
                average = sum(numbers, Decimal(0)) / Decimal(len(numbers))
            result[f"avg_{avg_column}"] = decimal_text(average)
        output_rows.append(result)
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
    writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="raise", lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    headers, numbered_rows = read_csv(args.input)
    filters = parse_filters(args.where)
    columns = [column for column, _ in filters]
    columns.extend(c for c in (args.group_by, args.sum_column, args.avg_column) if c)
    require_columns(headers, columns)

    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]
    if args.group_by:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]
    write_output(args.output, output_headers, output_rows, sys.stdout)


def main() -> None:
    try:
        run()
    except BrokenPipeError:
        # Quietly support common shell pipelines such as `... | head`.
        raise SystemExit(0) from None


if __name__ == "__main__":
    main()

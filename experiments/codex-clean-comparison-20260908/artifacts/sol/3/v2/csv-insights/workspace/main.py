#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or usage error suitable for display to the user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum or --avg")
    return args


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = Path(path).open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise CsvInsightsError(f"cannot open input file {path!r}: {exc.strerror or exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

            if not headers:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(headers) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty (empty field at position "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique (duplicate: "
                    + ", ".join(repr(name) for name in duplicates)
                    + ")"
                )

            rows: list[tuple[int, list[str]]] = []
            logical_row = 1
            try:
                for row in reader:
                    logical_row += 1
                    if len(row) != len(headers):
                        raise CsvInsightsError(
                            f"row {logical_row} has {len(row)} fields; expected {len(headers)}"
                        )
                    rows.append((logical_row, row))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near physical line {reader.line_num}: {exc}"
                ) from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc

    return headers, rows


def require_column(column: str, headers: list[str], option: str) -> int:
    try:
        return headers.index(column)
    except ValueError:
        raise CsvInsightsError(f"unknown column {column!r} for {option}") from None


def parse_filters(filters: list[str], headers: list[str]) -> list[tuple[int, str]]:
    parsed: list[tuple[int, str]] = []
    for expression in filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column name cannot be empty"
            )
        parsed.append((require_column(column, headers, "--where"), value))
    return parsed


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from None
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def analyze(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    headers, numbered_rows = read_csv(args.input)
    filters = parse_filters(args.where, headers)
    rows = [
        (number, row)
        for number, row in numbered_rows
        if all(row[index] == expected for index, expected in filters)
    ]

    if not args.group_by:
        return headers, [dict(zip(headers, row)) for _, row in rows]

    group_index = require_column(args.group_by, headers, "--group-by")
    sum_index = (
        require_column(args.sum_column, headers, "--sum")
        if args.sum_column is not None
        else None
    )
    avg_index = (
        require_column(args.avg_column, headers, "--avg")
        if args.avg_column is not None
        else None
    )

    # Each group stores [sum value, average total, average count].
    groups: dict[str, list[Decimal | int]] = {}
    for row_number, row in rows:
        key = row[group_index]
        state = groups.setdefault(key, [Decimal(0), Decimal(0), 0])
        if sum_index is not None:
            state[0] += decimal_value(row[sum_index], row_number, args.sum_column)
        if avg_index is not None:
            state[1] += decimal_value(row[avg_index], row_number, args.avg_column)
            state[2] += 1

    output_headers = [args.group_by]
    if sum_index is not None:
        output_headers.append(f"sum_{args.sum_column}")
    if avg_index is not None:
        output_headers.append(f"avg_{args.avg_column}")

    result: list[dict[str, str]] = []
    for key in sorted(groups):
        total, avg_total, count = groups[key]
        item = {args.group_by: key}
        if sum_index is not None:
            item[f"sum_{args.sum_column}"] = format_decimal(total)  # type: ignore[arg-type]
        if avg_index is not None:
            item[f"avg_{args.avg_column}"] = format_decimal(
                avg_total / Decimal(count)  # type: ignore[arg-type]
            )
        result.append(item)
    return output_headers, result


def emit(headers: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        headers, rows = analyze(args)
        emit(headers, rows, args.output)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

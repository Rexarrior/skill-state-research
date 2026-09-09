#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, DecimalException, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or processing error suitable for showing to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate a CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
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
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def validate_arguments(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty field at position {', '.join(empty_positions)})"
                )

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in header:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, list[str]]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((row_number, row))
            return header, rows
    except csv.Error as error:
        line = getattr(locals().get("reader"), "line_num", None)
        location = f" near line {line}" if line else ""
        raise CsvInsightsError(f"malformed CSV{location}: {error}") from None
    except UnicodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from None
    except OSError as error:
        raise CsvInsightsError(f"cannot read {path!r}: {error}") from None


def require_column(column: str, header: list[str], option: str) -> int:
    try:
        return header.index(column)
    except ValueError:
        raise CsvInsightsError(f"unknown column for {option}: {column!r}") from None


def parse_filters(filters: Sequence[str], header: list[str]) -> list[tuple[int, str]]:
    parsed: list[tuple[int, str]] = []
    for expression in filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed --where filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed --where filter {expression!r}; column cannot be empty"
            )
        parsed.append((require_column(column, header, "--where"), value))
    return parsed


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except (DecimalException, ValueError):
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def exact_sum(values: list[Decimal]) -> Decimal:
    """Add finite Decimals without rounding in the active Decimal context."""
    if not values:
        return Decimal(0)
    exponent = min(value.as_tuple().exponent for value in values)
    largest_aligned = max(
        len(value.as_tuple().digits) + value.as_tuple().exponent - exponent
        for value in values
    )
    # The extra digits cover carrying when every value has the same magnitude.
    precision = max(1, largest_aligned + len(str(len(values))) + 1)
    with localcontext() as context:
        context.prec = precision
        return sum(values, Decimal(0))


def select_rows(
    rows: list[tuple[int, list[str]]], filters: list[tuple[int, str]]
) -> list[tuple[int, list[str]]]:
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == value for index, value in filters)
    ]


def aggregate_rows(
    rows: list[tuple[int, list[str]]],
    header: list[str],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = require_column(group_column, header, "--group-by")
    sum_index = require_column(sum_column, header, "--sum") if sum_column else None
    avg_index = require_column(avg_column, header, "--avg") if avg_column else None

    # Values are retained per group so that sums use Decimal's exact input values
    # and averages have an unambiguous count.
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        group = groups.setdefault(row[group_index], {"sum": [], "avg": []})
        if sum_index is not None and sum_column is not None:
            group["sum"].append(decimal_value(row[sum_index], row_number, sum_column))
        if avg_index is not None and avg_column is not None:
            group["avg"].append(decimal_value(row[avg_index], row_number, avg_column))

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result = [group_value]
        if sum_column:
            result.append(format_decimal(exact_sum(values["sum"])))
        if avg_column:
            total = exact_sum(values["avg"])
            result.append(format_decimal(total / Decimal(len(values["avg"]))))
        output_rows.append(result)
    return output_header, output_rows


def write_output(
    output_format: str, header: list[str], rows: list[list[str]], destination: TextIO
) -> None:
    if output_format == "csv":
        writer = csv.writer(destination, lineterminator="\r\n")
        writer.writerow(header)
        writer.writerows(rows)
        return

    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, destination, ensure_ascii=False)
    destination.write("\n")


def run(args: argparse.Namespace, parser: argparse.ArgumentParser, output: TextIO) -> None:
    validate_arguments(args, parser)
    header, numbered_rows = read_csv(args.input)
    filters = parse_filters(args.where, header)
    selected = select_rows(numbered_rows, filters)

    if args.group_by:
        output_header, output_rows = aggregate_rows(
            selected, header, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = header
        output_rows = [row for _, row in selected]
    write_output(args.output, output_header, output_rows, output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args, parser, sys.stdout)
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

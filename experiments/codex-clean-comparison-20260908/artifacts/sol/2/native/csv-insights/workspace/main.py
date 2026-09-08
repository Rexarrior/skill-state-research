#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from math import gcd
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that can be shown directly to a command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums or averages."
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


def validate_header(header: list[str] | None) -> list[str]:
    if header is None:
        raise CsvInsightsError("input is empty; expected a header row")
    if not header:
        raise CsvInsightsError("header must contain at least one non-empty name")
    if any(name == "" for name in header):
        raise CsvInsightsError("header names must be non-empty")

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header names must be unique; duplicate: {names}")
    return header


def check_columns(
    header: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> None:
    known = set(header)
    requested = [column for column, _ in filters]
    requested.extend(
        column for column in (group_by, sum_column, avg_column) if column is not None
    )
    for column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")

    generated = []
    if sum_column:
        generated.append(f"sum_{sum_column}")
    if avg_column:
        generated.append(f"avg_{avg_column}")
    if group_by is not None and group_by in generated:
        raise CsvInsightsError(
            f"output column {group_by!r} conflicts with the group-by column"
        )


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        number = Decimal("NaN")
    if value == "" or not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def decimal_string(value: Decimal) -> str:
    """Render a finite Decimal without exponent notation or redundant zeroes."""
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered.startswith("."):
        rendered = "0" + rendered
    elif rendered.startswith("-."):
        rendered = "-0" + rendered[1:]
    return rendered


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals with enough precision to avoid context rounding."""
    smallest_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    largest_adjusted = max(left.adjusted(), right.adjusted())
    required_precision = max(1, largest_adjusted - smallest_exponent + 2)
    with localcontext() as context:
        context.prec = required_precision
        return left + right


def decimal_average(total: Decimal, count: int) -> Decimal:
    """Divide exactly when the result terminates, otherwise use Decimal precision."""
    digits = total.as_tuple().digits
    coefficient = int("".join(map(str, digits))) if digits else 0
    denominator = count // gcd(coefficient, count)
    twos = fives = 0
    while denominator % 2 == 0:
        denominator //= 2
        twos += 1
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    if denominator != 1:
        return total / count

    with localcontext() as context:
        context.prec = max(1, len(digits) + max(twos, fives) + 2)
        return total / count


def read_and_process(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    aggregate = args.sum_column is not None or args.avg_column is not None

    try:
        source = Path(args.input).open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {args.input!r}: {exc}") from exc

    try:
        with source:
            reader = csv.reader(source, strict=True)
            try:
                header = validate_header(next(reader, None))
                check_columns(
                    header,
                    filters,
                    args.group_by,
                    args.sum_column,
                    args.avg_column,
                )
                indexes = {name: index for index, name in enumerate(header)}

                if aggregate:
                    groups: dict[str, dict[str, Decimal | int]] = {}
                else:
                    rows: list[dict[str, str]] = []

                for row_number, fields in enumerate(reader, start=2):
                    if len(fields) != len(header):
                        raise CsvInsightsError(
                            f"row {row_number} has {len(fields)} fields; "
                            f"expected {len(header)}"
                        )
                    if not all(fields[indexes[column]] == value for column, value in filters):
                        continue

                    if not aggregate:
                        rows.append(dict(zip(header, fields)))
                        continue

                    group_value = fields[indexes[args.group_by]]
                    group = groups.setdefault(
                        group_value,
                        {"count": 0, "sum": Decimal(0), "avg_sum": Decimal(0)},
                    )
                    group["count"] += 1
                    if args.sum_column:
                        group["sum"] = exact_add(
                            group["sum"],
                            parse_decimal(
                                fields[indexes[args.sum_column]], row_number, args.sum_column
                            ),
                        )
                    if args.avg_column:
                        group["avg_sum"] = exact_add(
                            group["avg_sum"],
                            parse_decimal(
                                fields[indexes[args.avg_column]], row_number, args.avg_column
                            ),
                        )
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near line {reader.line_num}: {exc}"
                ) from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"cannot decode {args.input!r} as UTF-8: {exc}") from exc

    if not aggregate:
        return list(header), rows

    output_header = [args.group_by]
    if args.sum_column:
        output_header.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_header.append(f"avg_{args.avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        group = groups[group_value]
        result = {args.group_by: group_value}
        if args.sum_column:
            result[f"sum_{args.sum_column}"] = decimal_string(group["sum"])
        if args.avg_column:
            average = decimal_average(group["avg_sum"], group["count"])
            result[f"avg_{args.avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_header, output_rows


def emit(
    output_format: str,
    header: Sequence[str],
    rows: Sequence[dict[str, str]],
    destination: TextIO,
) -> None:
    if output_format == "json":
        json.dump(rows, destination, ensure_ascii=False)
        destination.write("\n")
        return

    writer = csv.DictWriter(
        destination,
        fieldnames=header,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        header, rows = read_and_process(args)
        emit(args.output, header, rows, sys.stdout)
    except (CsvInsightsError, OSError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

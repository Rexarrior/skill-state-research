#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally aggregate numeric columns."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="UTF-8 CSV input file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="exact-match filter; may be repeated",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        parser.error("--sum and --avg require --group-by")
    if args.group_by is not None and not (args.sum_columns or args.avg_columns):
        parser.error("--group-by requires at least one --sum or --avg")
    return args


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
                f"malformed filter {raw_filter!r}: column must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty (empty field at position "
            + ", ".join(empty_positions)
            + ")"
        )
    duplicates = sorted({name for name in header if header.count(name) > 1})
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique (duplicate: "
            + ", ".join(repr(name) for name in duplicates)
            + ")"
        )


def validate_columns(
    header: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> None:
    requested = [column for column, _ in filters]
    requested.extend(sum_columns)
    requested.extend(avg_columns)
    if group_by is not None:
        requested.append(group_by)
    unknown = sorted(set(requested).difference(header))
    if unknown:
        raise CsvInsightsError(
            "unknown column" + ("s" if len(unknown) > 1 else "") + ": "
            + ", ".join(repr(name) for name in unknown)
        )
    duplicate_aggregates = sorted(
        {name for name in sum_columns if sum_columns.count(name) > 1}
        | {name for name in avg_columns if avg_columns.count(name) > 1}
    )
    if duplicate_aggregates:
        raise CsvInsightsError(
            "duplicate aggregation column" + ("s" if len(duplicate_aggregates) > 1 else "")
            + ": "
            + ", ".join(repr(name) for name in duplicate_aggregates)
        )


def decimal_string(value: Decimal) -> str:
    """Return a non-exponential, minimal representation of a finite Decimal."""
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def numeric_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: numeric value is blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def analyze(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    filters = parse_filters(args.where)
    path = Path(args.input)
    try:
        source = path.open("r", encoding="utf-8", newline="")
    except OSError as error:
        raise CsvInsightsError(f"cannot open {args.input!r}: {error.strerror or error}") from error

    with source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader)
        except StopIteration:
            raise CsvInsightsError("input has no header row") from None
        except csv.Error as error:
            raise CsvInsightsError(f"malformed CSV header: {error}") from error

        validate_header(header)
        validate_columns(
            header,
            filters,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
        indexes = {name: index for index, name in enumerate(header)}
        filter_indexes = [(indexes[column], value) for column, value in filters]

        aggregate_columns = list(dict.fromkeys(args.sum_columns + args.avg_columns))
        aggregate_indexes = {column: indexes[column] for column in aggregate_columns}
        groups: dict[str, dict[str, list[Decimal] | int]] = {}
        rows: list[dict[str, str]] = []

        try:
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {row_number}: expected {len(header)} fields, found {len(row)}"
                    )
                if not all(row[index] == value for index, value in filter_indexes):
                    continue

                if args.group_by is None:
                    rows.append(dict(zip(header, row)))
                    continue

                # Parse every selected numeric value before mutating group state.
                numbers = {
                    column: numeric_cell(row[index], row_number, column)
                    for column, index in aggregate_indexes.items()
                }
                group_value = row[indexes[args.group_by]]
                state = groups.setdefault(
                    group_value,
                    {"count": 0, "sums": [Decimal(0) for _ in aggregate_columns]},
                )
                state["count"] = int(state["count"]) + 1
                sums = state["sums"]
                assert isinstance(sums, list)
                for index, column in enumerate(aggregate_columns):
                    sums[index] += numbers[column]
        except csv.Error as error:
            raise CsvInsightsError(
                f"malformed CSV near input line {reader.line_num}: {error}"
            ) from error

    if args.group_by is None:
        return header, rows

    output_header = [args.group_by]
    output_header.extend(f"sum_{column}" for column in args.sum_columns)
    output_header.extend(f"avg_{column}" for column in args.avg_columns)
    aggregate_positions = {column: index for index, column in enumerate(aggregate_columns)}
    for group_value in sorted(groups):
        state = groups[group_value]
        sums = state["sums"]
        count = int(state["count"])
        assert isinstance(sums, list)
        result = {args.group_by: group_value}
        for column in args.sum_columns:
            result[f"sum_{column}"] = decimal_string(sums[aggregate_positions[column]])
        for column in args.avg_columns:
            result[f"avg_{column}"] = decimal_string(
                sums[aggregate_positions[column]] / Decimal(count)
            )
        rows.append(result)
    return output_header, rows


def emit(header: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        header, rows = analyze(args)
        emit(header, rows, args.output)
    except (CsvInsightsError, UnicodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

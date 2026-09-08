#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, DecimalException, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    """Make argparse errors consistent with data-processing errors."""

    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        prog="csv-insights",
        description="Filter and aggregate RFC-4180-style CSV files.",
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
                f"malformed filter {expression!r}: column name is empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty; empty header at column "
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
        raise CsvInsightsError(f"header names must be unique; duplicate: {rendered}")


def validate_columns(header: list[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_filtered_rows(
    source: TextIO,
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(source, strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise CsvInsightsError("input has no header row") from None
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV in header: {exc}") from exc

    validate_header(header)
    validate_columns(
        header,
        [*(column for column, _ in filters), group_by, sum_column, avg_column],
    )
    indexes = {name: index for index, name in enumerate(header)}
    selected: list[tuple[int, dict[str, str]]] = []

    try:
        for record_number, fields in enumerate(reader, start=2):
            if len(fields) != len(header):
                raise CsvInsightsError(
                    f"row {record_number} has {len(fields)} fields; "
                    f"expected {len(header)}"
                )
            if all(fields[indexes[column]] == value for column, value in filters):
                selected.append((record_number, dict(zip(header, fields))))
    except csv.Error as exc:
        # reader.line_num is a physical line number, useful when syntax itself is bad.
        raise CsvInsightsError(
            f"malformed CSV near line {reader.line_num}: {exc}"
        ) from exc

    return header, selected


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {record_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except DecimalException as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    """Return a finite Decimal without exponent or insignificant trailing zeroes."""
    if number.is_zero():
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_by: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(
        column for column in (sum_column, avg_column) if column is not None
    ))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for record_number, row in rows:
        values = {
            column: parse_decimal(row[column], record_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(row[group_by], {column: [] for column in numeric_columns})
        for column, value in values.items():
            group[column].append(value)

    output_header = [group_by]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")
    if len(output_header) != len(set(output_header)):
        raise CsvInsightsError(
            "aggregation creates a duplicate output column; choose a different "
            "--group-by or aggregate column"
        )

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        result = {group_by: group_value}
        try:
            all_values = [
                value
                for values in groups[group_value].values()
                for value in values
            ]
            # Addition aligns values at the smallest exponent. Account for the
            # entire aligned coefficient and a possible carry from every row.
            min_exponent = min(
                (int(value.as_tuple().exponent) for value in all_values),
                default=0,
            )
            max_adjusted = max(
                (value.adjusted() for value in all_values),
                default=0,
            )
            sum_precision = max_adjusted - min_exponent + 1 + len(str(len(rows) or 1))
            with localcontext() as context:
                context.prec = max(28, sum_precision)
                if sum_column is not None:
                    total = sum(groups[group_value][sum_column], Decimal(0))
                    result[f"sum_{sum_column}"] = decimal_string(total)
                if avg_column is not None:
                    values = groups[group_value][avg_column]
                    average = sum(values, Decimal(0)) / Decimal(len(values))
                    result[f"avg_{avg_column}"] = decimal_string(average)
        except DecimalException as exc:
            raise CsvInsightsError(
                f"could not calculate group {group_value!r}: {exc}"
            ) from exc
        output_rows.append(result)

    return output_header, output_rows


def write_output(
    destination: TextIO,
    output_format: str,
    header: Sequence[str],
    rows: Sequence[dict[str, str]],
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


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    filters = parse_filters(args.where)
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    path = Path(args.input)
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            header, numbered_rows = read_filtered_rows(
                source,
                filters,
                args.group_by,
                args.sum_column,
                args.avg_column,
            )
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {args.input!r}: {exc}") from exc

    if args.sum_column is not None or args.avg_column is not None:
        header, rows = aggregate_rows(
            numbered_rows,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
    else:
        rows = [row for _, row in numbered_rows]

    write_output(sys.stdout, args.output, header, rows)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"csv-insights: error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

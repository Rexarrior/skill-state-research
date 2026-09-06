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
from typing import TextIO


class CsvInsightsError(Exception):
    """An expected input or usage error."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
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
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as input_file:
            reader = csv.reader(input_file, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header is required") from exc

            if not header:
                raise CsvInsightsError("input CSV header is empty")
            for index, name in enumerate(header, start=1):
                if name == "":
                    raise CsvInsightsError(
                        f"input CSV header column {index} has an empty name"
                    )
            duplicate = next((name for name in header if header.count(name) > 1), None)
            if duplicate is not None:
                raise CsvInsightsError(f"input CSV has duplicate header {duplicate!r}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"cannot decode input as UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def require_columns(header: Sequence[str], requested: Sequence[str | None]) -> None:
    for column in requested:
        if column is not None and column not in header:
            raise CsvInsightsError(f"unknown column {column!r}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def process(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(Path(args.input))
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )

    positions = {name: index for index, name in enumerate(header)}
    rows = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[positions[column]] == value for column, value in filters)
    ]

    if not args.group_by:
        return list(header), [dict(zip(header, row)) for _, row in rows]

    group_index = positions[args.group_by]
    groups: dict[str, list[tuple[int, list[str]]]] = {}
    for row_number, row in rows:
        groups.setdefault(row[group_index], []).append((row_number, row))

    output_header = [args.group_by]
    if args.sum_column:
        output_header.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_header.append(f"avg_{args.avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        group_rows = groups[group_value]
        result = {args.group_by: group_value}
        if args.sum_column:
            values = [
                decimal_value(row[positions[args.sum_column]], row_number, args.sum_column)
                for row_number, row in group_rows
            ]
            result[f"sum_{args.sum_column}"] = format_decimal(sum(values, Decimal(0)))
        if args.avg_column:
            values = [
                decimal_value(row[positions[args.avg_column]], row_number, args.avg_column)
                for row_number, row in group_rows
            ]
            result[f"avg_{args.avg_column}"] = format_decimal(
                sum(values, Decimal(0)) / Decimal(len(values))
            )
        output_rows.append(result)
    return output_header, output_rows


def write_output(
    output_format: str, header: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        return

    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    validate_arguments(args, parser)
    try:
        header, rows = process(args)
        write_output(args.output, header, rows, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate an RFC-style CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(values: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise CsvInsightsError(
                f"malformed filter {value!r}: expected COLUMN=VALUE"
            )
        column, expected = value.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {value!r}: column name cannot be empty"
            )
        filters.append((column, expected))
    return filters


def read_csv(path: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = Path(path).open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty header at column "
                    + ", ".join(empty_positions)
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique; duplicate header(s): "
                    + ", ".join(repr(name) for name in duplicates)
                )

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, dict(zip(header, fields))))
            return header, rows
    except (csv.Error, UnicodeError) as exc:
        raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[tuple[str, str]]) -> None:
    available = set(header)
    for purpose, column in columns:
        if column not in available:
            raise CsvInsightsError(f"unknown column {column!r} for {purpose}")


def parse_number(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: numeric value is blank"
        )
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return number


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Add finite Decimals with enough context precision to avoid rounding."""
    if not values:
        return Decimal(0)
    fractional_places = max(max(-value.as_tuple().exponent, 0) for value in values)
    integer_places = max(max(value.adjusted() + 1, 0) for value in values)
    carry_places = len(str(len(values)))
    with localcontext() as context:
        context.prec = max(1, integer_places + fractional_places + carry_places + 1)
        return sum(values, Decimal(0))


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column in numeric_columns:
            group[column].append(parse_number(row[column], row_number, column))

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        result = {group_column: group_value}
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(exact_sum(values[sum_column]))
        if avg_column:
            total = exact_sum(values[avg_column])
            with localcontext() as context:
                context.prec = 28
                average = total / Decimal(len(values[avg_column]))
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_header, output_rows


def write_output(
    header: Sequence[str], rows: Sequence[dict[str, str]], output_format: str
) -> None:
    if output_format == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=header,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CsvInsightsError("--group-by requires --sum and/or --avg")

    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    referenced = [("--where", column) for column, _ in filters]
    if args.group_by:
        referenced.append(("--group-by", args.group_by))
    if args.sum_column:
        referenced.append(("--sum", args.sum_column))
    if args.avg_column:
        referenced.append(("--avg", args.avg_column))
    require_columns(header, referenced)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == expected for column, expected in filters)
    ]

    if args.group_by:
        output_header, output_rows = aggregate_rows(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = header
        output_rows = [row for _, row in filtered]
    write_output(output_header, output_rows, args.output)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

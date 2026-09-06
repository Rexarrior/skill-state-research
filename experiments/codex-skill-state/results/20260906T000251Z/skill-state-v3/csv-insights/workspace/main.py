#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def build_parser() -> argparse.ArgumentParser:
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
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(values: list[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise CsvInsightsError(
                f"malformed filter {value!r}; expected COLUMN=VALUE"
            )
        column, expected = value.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {value!r}; column name must not be empty"
            )
        filters.append((column, expected))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input CSV is empty; a header row is required")
    for index, header in enumerate(headers, start=1):
        if header == "":
            raise CsvInsightsError(f"header column {index} is empty")
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"duplicate header column(s): {rendered}")


def require_columns(headers: list[str], requested: list[tuple[str, str]]) -> None:
    known = set(headers)
    for purpose, column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} for {purpose}")


def read_rows(stream: TextIO) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(stream, strict=True)
    try:
        try:
            headers = next(reader)
        except StopIteration:
            raise CsvInsightsError("input CSV is empty; a header row is required") from None
        validate_headers(headers)

        rows: list[tuple[int, dict[str, str]]] = []
        for record_number, fields in enumerate(reader, start=2):
            if len(fields) != len(headers):
                raise CsvInsightsError(
                    f"row {record_number} has {len(fields)} fields; expected {len(headers)}"
                )
            rows.append((record_number, dict(zip(headers, fields))))
        return headers, rows
    except csv.Error as exc:
        line = reader.line_num or 1
        raise CsvInsightsError(f"malformed CSV near line {line}: {exc}") from None


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def add_decimal_exact(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals without rounding long coefficients."""
    lowest_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    highest_digit = max(left.adjusted(), right.adjusted())
    with localcontext() as context:
        context.prec = max(1, highest_digit - lowest_exponent + 2)
        return left + right


def divide_decimal(total: Decimal, count: int) -> Decimal:
    """Preserve large coefficients while retaining Decimal's finite precision."""
    with localcontext() as context:
        context.prec = max(28, len(total.as_tuple().digits) + 28)
        return total / count


def aggregate_rows(
    rows: list[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    groups: dict[str, dict[str, Decimal | int]] = {}
    for row_number, row in rows:
        key = row[group_column]
        group = groups.setdefault(key, {})
        if sum_column is not None:
            number = parse_decimal(row[sum_column], row_number, sum_column)
            previous = group.get("sum", Decimal(0))
            assert isinstance(previous, Decimal)
            group["sum"] = add_decimal_exact(previous, number)
        if avg_column is not None:
            number = parse_decimal(row[avg_column], row_number, avg_column)
            previous = group.get("avg_total", Decimal(0))
            assert isinstance(previous, Decimal)
            group["avg_total"] = add_decimal_exact(previous, number)
            group["avg_count"] = group.get("avg_count", 0) + 1

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for key in sorted(groups):
        values = groups[key]
        output: dict[str, str] = {group_column: key}
        if sum_column is not None:
            output[f"sum_{sum_column}"] = format_decimal(values["sum"])  # type: ignore[arg-type]
        if avg_column is not None:
            total = values["avg_total"]
            count = values["avg_count"]
            assert isinstance(total, Decimal) and isinstance(count, int)
            output[f"avg_{avg_column}"] = format_decimal(divide_decimal(total, count))
        output_rows.append(output)
    return output_headers, output_rows


def emit_json(rows: list[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def emit_csv(headers: list[str], rows: list[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=headers,
        extrasaction="raise",
        lineterminator="\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    path = Path(args.input)
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            headers, numbered_rows = read_rows(stream)
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {str(path)!r}: {exc}") from None

    requested = [("--where", column) for column, _ in filters]
    if args.group_by:
        requested.append(("--group-by", args.group_by))
    if args.sum_column:
        requested.append(("--sum", args.sum_column))
    if args.avg_column:
        requested.append(("--avg", args.avg_column))
    require_columns(headers, requested)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == expected for column, expected in filters)
    ]

    if args.sum_column or args.avg_column:
        output_headers, output_rows = aggregate_rows(
            filtered,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_headers, output_rows)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

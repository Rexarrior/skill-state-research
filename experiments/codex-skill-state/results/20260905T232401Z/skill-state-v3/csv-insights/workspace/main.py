#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or processing error that is safe to show to the user."""


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
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    return parser


def validate_options(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum or --avg")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("CSV header is empty")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "CSV headers must be non-empty; empty header at column "
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
            "CSV headers must be unique; duplicate "
            + ", ".join(repr(name) for name in duplicates)
        )


def require_columns(headers: list[str], columns: Sequence[str | None]) -> None:
    known = set(headers)
    missing: list[str] = []
    for column in columns:
        if column is not None and column not in known and column not in missing:
            missing.append(column)
    if missing:
        raise CsvInsightsError(
            "unknown column" + ("s" if len(missing) > 1 else "") + ": "
            + ", ".join(repr(name) for name in missing)
        )


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise CsvInsightsError(f"cannot open {str(path)!r}: {exc.strerror or exc}") from exc

    with handle:
        reader = csv.reader(handle, strict=True)
        try:
            headers = next(reader)
        except StopIteration as exc:
            raise CsvInsightsError("CSV input is empty; a header row is required") from exc
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from exc

        validate_headers(headers)
        rows: list[list[str]] = []
        record_number = 1
        try:
            for row in reader:
                record_number += 1
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {exc}") from exc
    return headers, rows


def parse_number(value: str, row_number: int, column: str) -> Decimal:
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


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add finite decimals without silently rounding at the default precision."""
    lower_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    upper_digit = max(left.adjusted(), right.adjusted())
    precision = max(28, upper_digit - lower_exponent + 3)
    with localcontext() as context:
        context.prec = precision
        return left + right


def decimal_text(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def filter_rows(
    headers: list[str], rows: list[list[str]], filters: list[tuple[str, str]]
) -> list[list[str]]:
    indices = [(headers.index(column), value) for column, value in filters]
    return [row for row in rows if all(row[index] == value for index, value in indices)]


def aggregate(
    headers: list[str],
    rows: list[list[str]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]], set[str]]:
    group_index = headers.index(group_column)
    numeric_columns = [column for column in (sum_column, avg_column) if column is not None]
    numeric_indices = {column: headers.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for row_number, row in enumerate(rows, start=2):
        group = row[group_index]
        group_data = groups.setdefault(group, {})
        for column in numeric_columns:
            value = parse_number(row[numeric_indices[column]], row_number, column)
            total, count = group_data.get(column, (Decimal(0), 0))
            group_data[column] = (exact_add(total, value), count + 1)

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    number_headers = set(output_headers[1:])
    for group in sorted(groups):
        values = [group]
        if sum_column:
            values.append(decimal_text(groups[group][sum_column][0]))
        if avg_column:
            total, count = groups[group][avg_column]
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits) + 28)
                average = total / Decimal(count)
            values.append(decimal_text(average))
        output_rows.append(values)
    return output_headers, output_rows, number_headers


def write_json(
    output: TextIO, headers: list[str], rows: list[list[str]], number_headers: set[str]
) -> None:
    output.write("[")
    for row_index, row in enumerate(rows):
        if row_index:
            output.write(", ")
        output.write("{")
        for column_index, (header, value) in enumerate(zip(headers, row)):
            if column_index:
                output.write(", ")
            output.write(json.dumps(header, ensure_ascii=False))
            output.write(": ")
            output.write(value if header in number_headers else json.dumps(value, ensure_ascii=False))
        output.write("}")
    output.write("]\n")


def write_csv(output: TextIO, headers: list[str], rows: list[list[str]]) -> None:
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    headers, rows = read_csv(Path(args.input))
    require_columns(
        headers,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    rows = filter_rows(headers, rows, filters)

    number_headers: set[str] = set()
    if args.group_by:
        headers, rows, number_headers = aggregate(
            headers, rows, args.group_by, args.sum_column, args.avg_column
        )

    if args.output == "csv":
        write_csv(sys.stdout, headers, rows)
    else:
        write_json(sys.stdout, headers, rows, number_headers)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    validate_options(args, parser)
    try:
        run(args)
    except (CsvInsightsError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

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
    """An input or processing error that should be shown to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="extend",
        nargs="+",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
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
                f"malformed filter {expression!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        source_context = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    with source_context as source:
        csv.field_size_limit(sys.maxsize)
        reader = csv.reader(source, dialect="excel", strict=True)
        try:
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty; a header row is required")

            if not headers:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(i + 1) for i, name in enumerate(headers) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty at column {', '.join(empty_positions)})"
                )

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in headers:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                rendered = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"header names must be unique; duplicate: {rendered}")

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
        except csv.Error as exc:
            line = reader.line_num or 1
            raise CsvInsightsError(f"malformed CSV near line {line}: {exc}") from exc
        except UnicodeError as exc:
            raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
        except OSError as exc:
            raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    return headers, rows


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def parse_number(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except DecimalException as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Add finite Decimals without losing digits to the default Decimal context."""
    if not values:
        return Decimal(0)

    minimum_exponent = min(value.as_tuple().exponent for value in values)
    aligned_digits = max(
        len(value.as_tuple().digits) + value.as_tuple().exponent - minimum_exponent
        for value in values
    )
    precision = max(28, aligned_digits + len(str(len(values))) + 2)
    with localcontext() as context:
        context.prec = precision
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
    numeric_columns = [
        column for column in (sum_column, avg_column) if column is not None
    ]
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column in numeric_columns:
            group[column].append(parse_number(row[column], row_number, column))

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")
    if len(set(output_headers)) != len(output_headers):
        raise CsvInsightsError("aggregation produces duplicate output column names")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        result = {group_column: group_value}
        if sum_column is not None:
            result[f"sum_{sum_column}"] = decimal_string(
                exact_sum(groups[group_value][sum_column])
            )
        if avg_column is not None:
            values = groups[group_value][avg_column]
            total = exact_sum(values)
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits))
                average = total / Decimal(len(values))
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)

    return output_headers, output_rows


def write_output(
    stream: TextIO,
    output_format: str,
    headers: Sequence[str],
    rows: Sequence[dict[str, str]],
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.DictWriter(
        stream,
        fieldnames=headers,
        dialect="excel",
        lineterminator="\r\n",
        extrasaction="raise",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace, output: TextIO = sys.stdout) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CsvInsightsError("--group-by requires --sum, --avg, or both")

    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(Path(args.input))
    referenced_columns = [column for column, _ in filters]
    referenced_columns.extend(
        column
        for column in (args.group_by, args.sum_column, args.avg_column)
        if column is not None
    )
    require_columns(headers, referenced_columns)

    filtered_rows = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.group_by:
        output_headers, result_rows = aggregate_rows(
            filtered_rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        result_rows = [row for _, row in filtered_rows]
    write_output(output, args.output, output_headers, result_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        parser.error(str(exc))
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

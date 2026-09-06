#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path


class CsvInsightsError(Exception):
    """An error that can be shown directly to the command-line user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if len(set(args.sum_columns)) != len(args.sum_columns):
        parser.error("the same column may not be passed to --sum more than once")
    if len(set(args.avg_columns)) != len(args.avg_columns):
        parser.error("the same column may not be passed to --avg more than once")
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


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if not name]
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


def validate_columns(
    headers: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> None:
    requested = [column for column, _ in filters]
    if group_by is not None:
        requested.append(group_by)
    requested.extend(sum_columns)
    requested.extend(avg_columns)
    unknown = sorted(set(requested).difference(headers))
    if unknown:
        raise CsvInsightsError(
            "unknown column" + ("s" if len(unknown) != 1 else "") + ": "
            + ", ".join(repr(column) for column in unknown)
        )


def read_rows(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as input_file:
            reader = csv.reader(input_file, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty") from None
            validate_headers(headers)

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
            return headers, rows
    except CsvInsightsError:
        raise
    except csv.Error as error:
        raise CsvInsightsError(f"malformed CSV near line {reader.line_num}: {error}") from None
    except UnicodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from None
    except OSError as error:
        raise CsvInsightsError(f"cannot read {path}: {error}") from None


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if not value:
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


def format_decimal(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for row_number, row in rows:
        values = {
            column: decimal_value(row[column], row_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(row[group_by], {})
        for column, number in values.items():
            total, count = group.get(column, (Decimal(0), 0))
            group[column] = (total + number, count + 1)

    output_headers = [group_by]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        result = {group_by: group_value}
        for column in sum_columns:
            total, _ = groups[group_value][column]
            result[f"sum_{column}"] = format_decimal(total)
        for column in avg_columns:
            total, count = groups[group_value][column]
            result[f"avg_{column}"] = format_decimal(total / Decimal(count))
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="ignore", lineterminator="\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    headers, numbered_rows = read_rows(Path(args.input))
    validate_columns(
        headers, filters, args.group_by, args.sum_columns, args.avg_columns
    )
    filtered_rows = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.sum_columns or args.avg_columns:
        output_headers, output_rows = aggregate_rows(
            filtered_rows, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered_rows]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_headers, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Iterable, Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or processing error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="UTF-8 CSV input file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to sum (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to average (repeatable; requires --group-by)",
    )
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
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: Sequence[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    for position, header in enumerate(headers, start=1):
        if header == "":
            raise CsvInsightsError(f"header column {position} is empty")
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"duplicate header column(s): {names}")


def validate_columns(headers: Sequence[str], columns: Iterable[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_from_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank cell"
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


def decimal_string(number: Decimal) -> str:
    if number == 0:
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def read_and_process(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    filters = parse_filters(args.where)
    aggregate_columns = args.sum_columns + args.avg_columns
    if aggregate_columns and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    try:
        input_file = Path(args.input).open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file: {exc}") from None

    with input_file:
        reader = csv.reader(input_file, strict=True)
        try:
            headers = next(reader)
        except StopIteration:
            raise CsvInsightsError("input has no header row") from None
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV header: {exc}") from None

        validate_headers(headers)
        requested_columns = [column for column, _ in filters]
        if args.group_by is not None:
            requested_columns.append(args.group_by)
        requested_columns.extend(aggregate_columns)
        validate_columns(headers, requested_columns)

        indexes = {name: index for index, name in enumerate(headers)}
        filter_indexes = [(indexes[column], value) for column, value in filters]

        if not aggregate_columns:
            output_rows: list[dict[str, str]] = []
            try:
                for record_number, row in enumerate(reader, start=2):
                    if len(row) != len(headers):
                        raise CsvInsightsError(
                            f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                        )
                    if all(row[index] == value for index, value in filter_indexes):
                        output_rows.append(dict(zip(headers, row)))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near physical line {reader.line_num}: {exc}"
                ) from None
            except UnicodeError as exc:
                raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from None
            return list(headers), output_rows

        # Each group stores sums and counts by input column. OrderedDict keeps
        # deterministic insertion internally; final output is explicitly sorted.
        groups: dict[str, dict[str, list[Decimal | int]]] = {}
        numeric_columns = list(dict.fromkeys(aggregate_columns))
        try:
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                if not all(row[index] == value for index, value in filter_indexes):
                    continue
                values = {
                    column: decimal_from_cell(row[indexes[column]], record_number, column)
                    for column in numeric_columns
                }
                group = row[indexes[args.group_by]]
                stats = groups.setdefault(
                    group,
                    {column: [Decimal(0), 0] for column in numeric_columns},
                )
                for column, value in values.items():
                    stats[column][0] += value
                    stats[column][1] += 1
        except csv.Error as exc:
            raise CsvInsightsError(
                f"malformed CSV near physical line {reader.line_num}: {exc}"
            ) from None
        except UnicodeError as exc:
            raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from None
        except (InvalidOperation, OverflowError) as exc:
            raise CsvInsightsError(f"numeric aggregation failed: {exc}") from None

    output_headers = [args.group_by]
    output_headers.extend(f"sum_{column}" for column in args.sum_columns)
    output_headers.extend(f"avg_{column}" for column in args.avg_columns)
    result: list[dict[str, str]] = []
    for group in sorted(groups):
        row_result: dict[str, str] = OrderedDict()
        row_result[args.group_by] = group
        for column in args.sum_columns:
            row_result[f"sum_{column}"] = decimal_string(groups[group][column][0])
        for column in args.avg_columns:
            total, count = groups[group][column]
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits) + 28)
                average = total / count
            row_result[f"avg_{column}"] = decimal_string(average)
        result.append(row_result)
    return output_headers, result


def write_output(
    headers: Sequence[str], rows: Sequence[dict[str, str]], output_format: str, stream: TextIO
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        headers, rows = read_and_process(args)
        write_output(headers, rows, args.output, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

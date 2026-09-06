#!/usr/bin/env python3
"""A small, dependency-free CSV filtering and aggregation tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CSVInsightsError(Exception):
    """An error that can be shown directly to a command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CSVInsightsError(f"invalid arguments: {message}")


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate an RFC-style CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value; repeatable",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def validate_arguments(args: argparse.Namespace) -> None:
    has_aggregation = args.sum_column is not None or args.avg_column is not None
    if has_aggregation and args.group_by is None:
        raise CSVInsightsError("invalid arguments: --sum and --avg require --group-by")
    if args.group_by is not None and not has_aggregation:
        raise CSVInsightsError("invalid arguments: --group-by requires --sum or --avg")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        column, separator, value = raw_filter.partition("=")
        if not separator or not column:
            raise CSVInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as input_file:
            reader = csv.reader(input_file, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CSVInsightsError("malformed input: CSV file is empty") from exc

            if not header:
                raise CSVInsightsError("malformed input: header is empty")
            empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
            if empty_positions:
                raise CSVInsightsError(
                    "malformed input: header names must be non-empty "
                    f"(empty column at position {', '.join(empty_positions)})"
                )

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in header:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                duplicate_list = ", ".join(repr(name) for name in duplicates)
                raise CSVInsightsError(
                    f"malformed input: header names must be unique (duplicate: {duplicate_list})"
                )

            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CSVInsightsError(
                        f"malformed input: row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append(row)
            return header, rows
    except CSVInsightsError:
        raise
    except UnicodeError as exc:
        raise CSVInsightsError(f"cannot decode input as UTF-8: {exc}") from exc
    except csv.Error as exc:
        raise CSVInsightsError(f"malformed input: CSV parse error: {exc}") from exc
    except OSError as exc:
        raise CSVInsightsError(f"cannot read input file {str(path)!r}: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CSVInsightsError(f"unknown column: {column!r}")


def filter_rows(
    header: Sequence[str],
    rows: Sequence[list[str]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), value) for column, value in filters]
    return [
        (record_number, row)
        for record_number, row in enumerate(rows, start=2)
        if all(row[index] == value for index, value in indexes)
    ]


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if not value:
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank value"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def sum_exact(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals without losing digits to the default context."""
    if not values:
        return Decimal(0)
    smallest_exponent = min(value.as_tuple().exponent for value in values)
    largest_adjusted = max(value.adjusted() for value in values if value != 0) if any(values) else 0
    integer_digits = max(1, largest_adjusted + 1)
    fractional_digits = max(0, -smallest_exponent)
    with localcontext() as context:
        context.prec = max(28, integer_digits + fractional_digits + len(str(len(values))) + 1)
        return sum(values, Decimal(0))


def average(values: Sequence[Decimal]) -> Decimal:
    total = sum_exact(values)
    digit_count = len(total.as_tuple().digits)
    with localcontext() as context:
        context.prec = max(28, digit_count + 28)
        return total / Decimal(len(values))


def decimal_string(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def aggregate_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    # A column requested for both operations still contributes one value per row.
    numeric_columns = list(
        dict.fromkeys(column for column in (sum_column, avg_column) if column is not None)
    )
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            bucket[column].append(parse_decimal(row[numeric_indexes[column]], row_number, column))

    output_header = [group_column]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        result = [group]
        if sum_column is not None:
            result.append(decimal_string(sum_exact(groups[group][sum_column])))
        if avg_column is not None:
            result.append(decimal_string(average(groups[group][avg_column])))
        output_rows.append(result)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    objects = [dict(zip(header, row, strict=True)) for row in rows]
    json.dump(objects, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    writer = csv.writer(sys.stdout, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    validate_arguments(args)
    filters = parse_filters(args.where)

    header, rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(
        column
        for column in (args.group_by, args.sum_column, args.avg_column)
        if column is not None
    )
    require_columns(header, requested_columns)
    filtered_rows = filter_rows(header, rows, filters)

    if args.group_by is None:
        output_header = header
        output_rows = [row for _, row in filtered_rows]
    else:
        output_header, output_rows = aggregate_rows(
            header,
            filtered_rows,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )

    if args.output == "json":
        emit_json(output_header, output_rows)
    else:
        emit_csv(output_header, output_rows)


def main() -> int:
    try:
        run()
    except CSVInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

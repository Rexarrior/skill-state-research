#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An input or command-line error suitable for displaying to the user."""


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
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise UserError("--group-by requires --sum or --avg")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise UserError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {raw_filter!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise UserError("CSV header is empty")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
    if empty_positions:
        raise UserError(
            "CSV header contains an empty column name at position(s) "
            + ", ".join(empty_positions)
        )
    duplicates = sorted({name for name in header if header.count(name) > 1})
    if duplicates:
        raise UserError("CSV header contains duplicate column(s): " + ", ".join(duplicates))


def require_columns(header: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise UserError(f"unknown column: {column}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("CSV input is empty") from None
            validate_header(header)

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise UserError(
                        f"row {record_number} has {len(row)} field(s); "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except UserError:
        raise
    except csv.Error as error:
        raise UserError(f"malformed CSV near line {getattr(reader, 'line_num', '?')}: {error}") from error
    except UnicodeError as error:
        raise UserError(f"input is not valid UTF-8: {error}") from error
    except OSError as error:
        raise UserError(f"cannot read {path}: {error}") from error


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"row {row_number}, column {column}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise UserError(
            f"row {row_number}, column {column}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise UserError(
            f"row {row_number}, column {column}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def select_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), value) for column, value in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == value for index, value in indexes)
    ]


def aggregate_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = header.index(group_column)
    numeric_columns = [column for column in (sum_column, avg_column) if column]
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            bucket[column].append(decimal_value(row[numeric_indexes[column]], row_number, column))

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_column: group}
        if sum_column:
            result[f"sum_{sum_column}"] = format_decimal(sum(groups[group][sum_column]))
        if avg_column:
            values = groups[group][avg_column]
            result[f"avg_{avg_column}"] = format_decimal(sum(values) / len(values))
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    json.dump(rows, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    validate_arguments(args)
    filters = parse_filters(args.where)
    header, rows = read_csv(Path(args.input))
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    selected = select_rows(header, rows, filters)

    if args.group_by:
        output_header, output_rows = aggregate_rows(
            header, selected, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = list(header)
        output_rows = [dict(zip(header, row)) for _, row in selected]

    if args.output == "json":
        emit_json(output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except UserError as error:
        parser.error(str(error))
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

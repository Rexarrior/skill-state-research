#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics CLI."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
import sys
from pathlib import Path
from typing import Sequence, TextIO


class UserError(Exception):
    """An input or command-line error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used for grouping")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="sum a numeric column (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="average a numeric column (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise UserError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("input CSV is empty") from None

            if not header:
                raise UserError("input CSV has no header fields")
            empty_positions = [str(i) for i, name in enumerate(header, start=1) if name == ""]
            if empty_positions:
                raise UserError(
                    "header names must be non-empty "
                    f"(empty field at position {', '.join(empty_positions)})"
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise UserError(
                    "header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise UserError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except UserError:
        raise
    except csv.Error as exc:
        raise UserError(f"malformed CSV near physical line {reader.line_num}: {exc}") from None
    except UnicodeError as exc:
        raise UserError(f"cannot decode input CSV as UTF-8: {exc}") from None
    except OSError as exc:
        raise UserError(f"cannot read {path}: {exc}") from None


def validate_columns(
    header: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> None:
    known = set(header)
    requested = [column for column, _ in filters]
    if group_by is not None:
        requested.append(group_by)
    requested.extend(sum_columns)
    requested.extend(avg_columns)
    for column in requested:
        if column not in known:
            raise UserError(f"unknown column: {column!r}")


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise UserError(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from None
    if not value.is_finite():
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def analyze(
    header: list[str],
    numbered_rows: list[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    indexes = {name: index for index, name in enumerate(header)}
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[indexes[column]] == value for column, value in filters)
    ]
    if not sum_columns and not avg_columns:
        return header, [row for _, row in filtered]

    assert group_by is not None
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in filtered:
        group = row[indexes[group_by]]
        values = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            values[column].append(
                decimal_value(row[indexes[column]], row_number, column)
            )

    output_header = [group_by]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[list[str]] = []
    for group in sorted(groups):
        values = groups[group]
        result = [group]
        result.extend(format_decimal(sum(values[column], Decimal(0))) for column in sum_columns)
        result.extend(
            format_decimal(sum(values[column], Decimal(0)) / len(values[column]))
            for column in avg_columns
        )
        output_rows.append(result)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        filters = parse_filters(args.where)
        if (args.sum_columns or args.avg_columns) and args.group_by is None:
            raise UserError("--sum and --avg require --group-by")
        if args.group_by is not None and not (args.sum_columns or args.avg_columns):
            raise UserError("--group-by requires --sum and/or --avg")
        header, rows = read_csv(Path(args.input))
        validate_columns(
            header, filters, args.group_by, args.sum_columns, args.avg_columns
        )
        output_header, output_rows = analyze(
            header,
            rows,
            filters,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
        if args.output == "json":
            emit_json(output_header, output_rows, sys.stdout)
        else:
            emit_csv(output_header, output_rows, sys.stdout)
        return 0
    except UserError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(run())

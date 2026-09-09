#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from typing import Iterable, Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or usage error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally compute grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
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
    has_aggregate = args.sum_column is not None or args.avg_column is not None
    if has_aggregate and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by is not None and not has_aggregate:
        raise CsvInsightsError("--group-by requires --sum or --avg")


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with open(path, "r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header row is required") from exc

            if not header:
                raise CsvInsightsError("header row must contain at least one column")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty (empty column at position "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique (duplicate: "
                    + ", ".join(repr(name) for name in duplicates)
                    + ")"
                )

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path!r}: {exc}") from exc


def parse_filters(raw_filters: Sequence[str], columns: set[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if column == "":
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column name must not be empty"
            )
        require_column(column, columns, "filter")
        filters.append((column, value))
    return filters


def require_column(column: str, columns: set[str], purpose: str) -> None:
    if column not in columns:
        raise CsvInsightsError(f"unknown {purpose} column: {column!r}")


def filtered_rows(
    header: Sequence[str],
    rows: Iterable[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), value) for column, value in filters]
    return [
        (number, row)
        for number, row in rows
        if all(row[index] == expected for index, expected in indexes)
    ]


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
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
    """Add finite Decimals without rounding, regardless of the default context."""
    smallest_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    largest_position = max(left.adjusted(), right.adjusted(), 0)
    with localcontext() as context:
        context.prec = max(1, largest_position - smallest_exponent + 3)
        return left + right


def decimal_text(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = header.index(group_column)
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c is not None))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for row_number, row in rows:
        group = groups.setdefault(row[group_index], {})
        for column in numeric_columns:
            value = parse_decimal(row[numeric_indexes[column]], row_number, column)
            total, count = group.get(column, (Decimal(0), 0))
            group[column] = (exact_add(total, value), count + 1)

    fields = [group_column]
    if sum_column is not None:
        fields.append(f"sum_{sum_column}")
    if avg_column is not None:
        fields.append(f"avg_{avg_column}")

    result: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values: dict[str, str] = {group_column: group_value}
        group = groups[group_value]
        if sum_column is not None:
            values[f"sum_{sum_column}"] = decimal_text(group[sum_column][0])
        if avg_column is not None:
            total, count = group[avg_column]
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits) + 28)
                average = total / Decimal(count)
            values[f"avg_{avg_column}"] = decimal_text(average)
        result.append(values)
    return fields, result


def emit_json(records: Sequence[dict[str, str]], output: TextIO) -> None:
    json.dump(records, output, ensure_ascii=False, separators=(",", ":"))
    output.write("\n")


def emit_csv(fields: Sequence[str], records: Sequence[dict[str, str]], output: TextIO) -> None:
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(records)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        validate_arguments(args)
        header, numbered_rows = read_csv(args.input)
        columns = set(header)
        filters = parse_filters(args.where, columns)
        if args.group_by is not None:
            require_column(args.group_by, columns, "group-by")
        if args.sum_column is not None:
            require_column(args.sum_column, columns, "sum")
        if args.avg_column is not None:
            require_column(args.avg_column, columns, "average")

        selected = filtered_rows(header, numbered_rows, filters)
        if args.group_by is None:
            fields = list(header)
            records = [dict(zip(header, row)) for _, row in selected]
        else:
            fields, records = aggregate(
                header, selected, args.group_by, args.sum_column, args.avg_column
            )

        if args.output == "json":
            emit_json(records, sys.stdout)
        else:
            emit_csv(fields, records, sys.stdout)
        return 0
    except CsvInsightsError as exc:
        parser.error(str(exc))
        return 2  # pragma: no cover: ArgumentParser.error exits


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except BrokenPipeError:
        raise SystemExit(1)

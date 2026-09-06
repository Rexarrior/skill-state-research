#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from collections.abc import Sequence


class CsvInsightsError(Exception):
    """An error that can be shown directly to a command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
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


def validate_header(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
    if empty_positions:
        positions = ", ".join(empty_positions)
        raise CsvInsightsError(f"header contains an empty name at column(s) {positions}")

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        names = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header contains duplicate column(s): {names}")


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        stream = open(path, "r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open {path!r}: {exc}") from exc

    try:
        with stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input has no header row") from exc
            validate_header(header)

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} field(s); "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except csv.Error as exc:
        line = getattr(reader, "line_num", 0)
        location = f" near line {line}" if line else ""
        raise CsvInsightsError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_value(text: str, record_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: numeric value is blank"
        )
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {text!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def calculation_precision(values: Sequence[Decimal]) -> int:
    """Choose enough precision that addition is exact, with room for averages."""
    if not values:
        return 28
    least_exponent = min(value.as_tuple().exponent for value in values)
    greatest_adjusted = max(value.adjusted() for value in values)
    integer_and_fraction_digits = greatest_adjusted - least_exponent + 1
    carry_digits = len(str(len(values)))
    return max(28, integer_and_fraction_digits + carry_digits + 28)


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = header.index(group_column)
    numeric_columns = list(
        dict.fromkeys(column for column in (sum_column, avg_column) if column)
    )
    numeric_indexes = {column: header.index(column) for column in numeric_columns}

    groups: dict[str, dict[str, list[Decimal]]] = {}
    for record_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            bucket[column].append(
                decimal_value(row[numeric_indexes[column]], record_number, column)
            )

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_column: group}
        all_values = [value for values in groups[group].values() for value in values]
        with localcontext() as context:
            context.prec = calculation_precision(all_values)
            if sum_column:
                total = sum(groups[group][sum_column], Decimal(0))
                result[f"sum_{sum_column}"] = decimal_string(total)
            if avg_column:
                values = groups[group][avg_column]
                average = sum(values, Decimal(0)) / Decimal(len(values))
                result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout, fieldnames=header, lineterminator="\r\n", extrasaction="raise"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CsvInsightsError("--group-by requires --sum, --avg, or both")

    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(
        column
        for column in (args.group_by, args.sum_column, args.avg_column)
        if column is not None
    )
    require_columns(header, requested_columns)

    indexes = [(header.index(column), value) for column, value in filters]
    filtered = [
        (record_number, row)
        for record_number, row in numbered_rows
        if all(row[index] == value for index, value in indexes)
    ]

    if args.group_by:
        output_header, output_rows = aggregate(
            header, filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = list(header)
        output_rows = [dict(zip(header, row)) for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_header, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        parser.exit(1, f"error: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

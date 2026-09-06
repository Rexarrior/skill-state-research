#!/usr/bin/env python3
"""Filter and aggregate CSV files using only the Python standard library."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Iterable, Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or usage error that is safe to show to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        metavar="COLUMN=VALUE",
        action="append",
        default=[],
        help="keep rows with an exact value match; may be repeated",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def parse_filters(raw_filters: Iterable[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        column, separator, value = raw_filter.partition("=")
        if not separator or not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}; expected COLUMN=VALUE"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as input_file:
            reader = csv.reader(input_file, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header:
                raise CsvInsightsError("input CSV has no header fields")
            empty_positions = [str(index) for index, name in enumerate(header, 1) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty header at column {', '.join(empty_positions)})"
                )

            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as error:
        line = reader.line_num if "reader" in locals() else 1
        raise CsvInsightsError(f"malformed CSV near line {line}: {error}") from None
    except UnicodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from None
    except OSError as error:
        raise CsvInsightsError(f"cannot read {path}: {error.strerror or error}") from None


def validate_columns(
    header: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_column: str | None,
    avg_column: str | None,
) -> None:
    known = set(header)
    requested = [column for column, _ in filters]
    requested.extend(
        column for column in (group_by, sum_column, avg_column) if column is not None
    )
    for column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")

    if (sum_column or avg_column) and group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    if group_by and (sum_column or avg_column):
        output_names = [group_by]
        if sum_column:
            output_names.append(f"sum_{sum_column}")
        if avg_column:
            output_names.append(f"avg_{avg_column}")
        if len(output_names) != len(set(output_names)):
            raise CsvInsightsError("aggregation would create duplicate output columns")


def filter_rows(
    header: Sequence[str],
    rows: Iterable[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), value) for column, value in filters]
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[index] == value for index, value in indexes)
    ]


def parse_decimal(value: str, row: int, column: str) -> Decimal:
    try:
        number = Decimal(value)
    except InvalidOperation:
        number = Decimal("NaN")
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_from_coefficient(coefficient: int, exponent: int) -> Decimal:
    if coefficient == 0:
        return Decimal(0)
    sign = 1 if coefficient < 0 else 0
    digits = tuple(int(character) for character in str(abs(coefficient)))
    return Decimal((sign, digits, exponent))


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Add finite decimals exactly, without Decimal context rounding."""
    if not values:
        return Decimal(0)
    common_exponent = min(value.as_tuple().exponent for value in values)
    total = 0
    for value in values:
        parts = value.as_tuple()
        coefficient = 0
        for digit in parts.digits:
            coefficient = coefficient * 10 + digit
        if parts.sign:
            coefficient = -coefficient
        total += coefficient * 10 ** (parts.exponent - common_exponent)
    return decimal_from_coefficient(total, common_exponent)


def decimal_average(total: Decimal, count: int) -> Decimal:
    """Return an exact terminating average, or 28 significant digits otherwise."""
    parts = total.as_tuple()
    coefficient = 0
    for digit in parts.digits:
        coefficient = coefficient * 10 + digit
    if parts.sign:
        coefficient = -coefficient

    divisor = count
    common = math.gcd(abs(coefficient), divisor)
    coefficient //= common
    divisor //= common

    twos = fives = 0
    while divisor % 2 == 0:
        divisor //= 2
        twos += 1
    while divisor % 5 == 0:
        divisor //= 5
        fives += 1
    if divisor == 1:
        scale = max(twos, fives)
        coefficient *= 2 ** (scale - twos) * 5 ** (scale - fives)
        return decimal_from_coefficient(coefficient, parts.exponent - scale)

    with localcontext() as context:
        context.prec = 28
        return total / Decimal(count)


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate_rows(
    header: Sequence[str],
    rows: Iterable[tuple[int, list[str]]],
    group_by: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = header.index(group_by)
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for record_number, row in rows:
        group = row[group_index]
        values = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column, index in numeric_indexes.items():
            values[column].append(parse_decimal(row[index], record_number, column))

    output_header = [group_by]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    result: list[dict[str, str]] = []
    for group in sorted(groups):
        values = groups[group]
        output_row = {group_by: group}
        totals = {column: exact_sum(numbers) for column, numbers in values.items()}
        if sum_column:
            output_row[f"sum_{sum_column}"] = format_decimal(totals[sum_column])
        if avg_column:
            output_row[f"avg_{avg_column}"] = format_decimal(
                decimal_average(totals[avg_column], len(values[avg_column]))
            )
        result.append(output_row)
    return output_header, result


def emit_json(rows: Iterable[dict[str, str]], output: TextIO) -> None:
    json.dump(list(rows), output, ensure_ascii=False)
    output.write("\n")


def emit_csv(header: Sequence[str], rows: Iterable[dict[str, str]], output: TextIO) -> None:
    writer = csv.DictWriter(output, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(arguments: argparse.Namespace, output: TextIO) -> None:
    filters = parse_filters(arguments.where)
    header, input_rows = read_csv(Path(arguments.input))
    validate_columns(
        header,
        filters,
        arguments.group_by,
        arguments.sum_column,
        arguments.avg_column,
    )
    filtered = filter_rows(header, input_rows, filters)

    if arguments.sum_column or arguments.avg_column:
        output_header, rows = aggregate_rows(
            header,
            filtered,
            arguments.group_by,
            arguments.sum_column,
            arguments.avg_column,
        )
    else:
        output_header = list(header)
        rows = [dict(zip(header, row)) for _, row in filtered]

    if arguments.output == "json":
        emit_json(rows, output)
    else:
        emit_csv(output_header, rows, output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        run(arguments, sys.stdout)
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

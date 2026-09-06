#!/usr/bin/env python3
"""Filter and aggregate CSV files from the command line."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that can be shown directly to the user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter CSV rows and optionally aggregate numeric columns."
    )
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CsvInsightsError("--group-by requires --sum or --avg")
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        source = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    with source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader)
        except StopIteration as exc:
            raise CsvInsightsError("input CSV is empty") from exc
        except csv.Error as exc:
            raise CsvInsightsError(f"malformed CSV header: {exc}") from exc
        except (OSError, UnicodeError) as exc:
            raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

        if not header:
            raise CsvInsightsError("CSV header must contain at least one column")
        empty_position = next((i for i, name in enumerate(header, 1) if not name), None)
        if empty_position is not None:
            raise CsvInsightsError(
                f"CSV header column {empty_position} must not be empty"
            )
        seen: set[str] = set()
        duplicate = next((name for name in header if name in seen or seen.add(name)), None)
        if duplicate is not None:
            raise CsvInsightsError(f"duplicate CSV header {duplicate!r}")

        rows: list[tuple[int, list[str]]] = []
        try:
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((row_number, row))
        except csv.Error as exc:
            raise CsvInsightsError(
                f"malformed CSV near line {reader.line_num}: {exc}"
            ) from exc
        except (OSError, UnicodeError) as exc:
            raise CsvInsightsError(f"cannot read {path}: {exc}") from exc
    return header, rows


def require_columns(header: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column {column!r}")


def filter_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    positions = [(header.index(column), value) for column, value in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[position] == value for position, value in positions)
    ]


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if not value:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def arithmetic_precision(numbers: Sequence[Decimal]) -> int:
    lowest_place = min(number.as_tuple().exponent for number in numbers)
    highest_place = max(number.adjusted() for number in numbers)
    carry_digits = len(str(len(numbers)))
    return max(28, highest_place - lowest_place + carry_digits + 2)


def decimal_total(numbers: Sequence[Decimal]) -> Decimal:
    with localcontext() as context:
        context.prec = arithmetic_precision(numbers)
        return sum(numbers, Decimal(0))


def decimal_average(numbers: Sequence[Decimal]) -> Decimal:
    with localcontext() as context:
        context.prec = arithmetic_precision(numbers)
        return sum(numbers, Decimal(0)) / Decimal(len(numbers))


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_position = header.index(group_column)
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    numeric_positions = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = groups.setdefault(
            row[group_position], {column: [] for column in numeric_columns}
        )
        for column, position in numeric_positions.items():
            group[column].append(parse_decimal(row[position], row_number, column))

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    result: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values = groups[group_value]
        output_row = OrderedDict([(group_column, group_value)])
        if sum_column:
            output_row[f"sum_{sum_column}"] = decimal_string(
                decimal_total(values[sum_column])
            )
        if avg_column:
            numbers = values[avg_column]
            output_row[f"avg_{avg_column}"] = decimal_string(decimal_average(numbers))
        result.append(output_row)
    return output_header, result


def emit_json(rows: Sequence[dict[str, str]], destination: TextIO) -> None:
    json.dump(rows, destination, ensure_ascii=False, indent=2)
    destination.write("\n")


def emit_csv(
    header: Sequence[str], rows: Sequence[dict[str, str]], destination: TextIO
) -> None:
    writer = csv.DictWriter(destination, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None, destination: TextIO = sys.stdout) -> None:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(Path(args.input))
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    numbered_rows = filter_rows(header, numbered_rows, filters)

    if args.group_by:
        output_header, output_rows = aggregate(
            header,
            numbered_rows,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
    else:
        output_header = header
        output_rows = [dict(zip(header, row)) for _, row in numbered_rows]

    if args.output == "json":
        emit_json(output_rows, destination)
    else:
        emit_csv(output_header, output_rows, destination)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

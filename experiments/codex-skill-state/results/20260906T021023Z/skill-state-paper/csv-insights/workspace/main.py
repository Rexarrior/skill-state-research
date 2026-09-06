#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


@dataclass(frozen=True)
class AggregateRow:
    group: str
    values: tuple[Decimal, ...]


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
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="sum a numeric column within each group (repeatable)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="average a numeric column within each group (repeatable)",
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
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    for position, header in enumerate(headers, start=1):
        if header == "":
            raise CsvInsightsError(f"header in column {position} is empty")
    seen: set[str] = set()
    for header in headers:
        if header in seen:
            raise CsvInsightsError(f"duplicate header: {header!r}")
        seen.add(header)


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input has no header row") from None
            validate_headers(headers)

            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append(row)
            return headers, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def filter_rows(
    headers: Sequence[str],
    rows: Sequence[list[str]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    positions = [(headers.index(column), value) for column, value in filters]
    return [
        (record_number, row)
        for record_number, row in enumerate(rows, start=2)
        if all(row[position] == value for position, value in positions)
    ]


def parse_decimal(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {record_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_text(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> list[AggregateRow]:
    group_position = headers.index(group_column)
    numeric_columns = list(sum_columns) + list(avg_columns)
    numeric_positions = [headers.index(column) for column in numeric_columns]
    groups: dict[str, list[list[Decimal]]] = {}

    parsed_rows: list[tuple[str, list[Decimal]]] = []
    maximum_digits = 1
    maximum_adjusted = 0
    for record_number, row in rows:
        numbers: list[Decimal] = []
        for column, position in zip(numeric_columns, numeric_positions):
            number = parse_decimal(row[position], record_number, column)
            numbers.append(number)
            maximum_digits = max(maximum_digits, len(number.as_tuple().digits))
            maximum_adjusted = max(maximum_adjusted, abs(number.adjusted()))
        parsed_rows.append((row[group_position], numbers))

    # Decimal addition uses the active context. This precision keeps finite input
    # sums exact while providing ample useful digits for non-terminating averages.
    precision = max(28, maximum_digits + maximum_adjusted + len(str(max(1, len(rows)))) + 4)
    with localcontext() as context:
        context.prec = precision
        for group, numbers in parsed_rows:
            slots = groups.setdefault(group, [[] for _ in numeric_columns])
            for slot, number in zip(slots, numbers):
                slot.append(number)

        result: list[AggregateRow] = []
        sum_count = len(sum_columns)
        for group in sorted(groups):
            slots = groups[group]
            values: list[Decimal] = []
            for slot in slots[:sum_count]:
                values.append(sum(slot, Decimal(0)))
            for slot in slots[sum_count:]:
                values.append(sum(slot, Decimal(0)) / Decimal(len(slot)))
            result.append(AggregateRow(group, tuple(values)))
        return result


def write_csv(headers: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)


def write_json_rows(
    headers: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO
) -> None:
    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False)
    stream.write("\n")


def write_json_aggregates(
    headers: Sequence[str], rows: Sequence[AggregateRow], stream: TextIO
) -> None:
    # json.dumps cannot serialize Decimal. Construct only the outer numeric
    # values manually; keys and group strings still go through the JSON encoder.
    objects: list[str] = []
    for row in rows:
        fields = [
            f"{json.dumps(headers[0], ensure_ascii=False)}: "
            f"{json.dumps(row.group, ensure_ascii=False)}"
        ]
        fields.extend(
            f"{json.dumps(header, ensure_ascii=False)}: {decimal_text(value)}"
            for header, value in zip(headers[1:], row.values)
        )
        objects.append("{" + ", ".join(fields) + "}")
    stream.write("[" + ", ".join(objects) + "]\n")


def run(args: argparse.Namespace) -> None:
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    headers, all_rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    if args.group_by:
        requested_columns.append(args.group_by)
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    require_columns(headers, requested_columns)

    rows = filter_rows(headers, all_rows, filters)
    if not (args.sum_columns or args.avg_columns):
        plain_rows = [row for _, row in rows]
        if args.output == "csv":
            write_csv(headers, plain_rows, sys.stdout)
        else:
            write_json_rows(headers, plain_rows, sys.stdout)
        return

    aggregate_headers = [args.group_by]
    aggregate_headers.extend(f"sum_{column}" for column in args.sum_columns)
    aggregate_headers.extend(f"avg_{column}" for column in args.avg_columns)
    aggregate_rows = aggregate(
        headers,
        rows,
        args.group_by,
        args.sum_columns,
        args.avg_columns,
    )
    if args.output == "csv":
        write_csv(
            aggregate_headers,
            [
                [row.group, *(decimal_text(value) for value in row.values)]
                for row in aggregate_rows
            ],
            sys.stdout,
        )
    else:
        write_json_aggregates(aggregate_headers, aggregate_rows, sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

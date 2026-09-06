#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, DecimalException, InvalidOperation
from pathlib import Path
from typing import TextIO


class CSVInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CSVInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        description="Filter and aggregate a CSV file.",
        allow_abbrev=False,
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to sum (repeatable)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to average (repeatable)",
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
            raise CSVInsightsError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CSVInsightsError(
                f"malformed filter {expression!r}: column name is empty"
            )
        filters.append((column, value))
    return filters


def check_columns(columns: Sequence[str], headers: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CSVInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CSVInsightsError(f"cannot open input file {str(path)!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise CSVInsightsError("input CSV is empty") from exc

            if not headers:
                raise CSVInsightsError("header row is empty")
            for position, header in enumerate(headers, start=1):
                if header == "":
                    raise CSVInsightsError(
                        f"header at column {position} is empty"
                    )
            seen: set[str] = set()
            for header in headers:
                if header in seen:
                    raise CSVInsightsError(f"duplicate header: {header!r}")
                seen.add(header)

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CSVInsightsError(
                        f"row {record_number} has {len(row)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, row))
            return headers, rows
    except csv.Error as exc:
        line = getattr(reader, "line_num", 0)
        location = f" near physical line {line}" if line else ""
        raise CSVInsightsError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CSVInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CSVInsightsError(f"cannot read input file {str(path)!r}: {exc}") from exc


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CSVInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank"
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


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def select_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(headers.index(column), value) for column, value in filters]
    return [
        (number, row)
        for number, row in rows
        if all(row[index] == expected for index, expected in indexes)
    ]


def aggregate(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(group_column)
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    numeric_indexes = {column: headers.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    try:
        for row_number, row in rows:
            group = row[group_index]
            values = groups.setdefault(group, {column: [] for column in numeric_columns})
            for column in numeric_columns:
                values[column].append(
                    decimal_value(row[numeric_indexes[column]], row_number, column)
                )

        output_headers = [group_column]
        output_headers.extend(f"sum_{column}" for column in sum_columns)
        output_headers.extend(f"avg_{column}" for column in avg_columns)
        output_rows: list[list[str]] = []
        for group in sorted(groups):
            values = groups[group]
            output = [group]
            for column in sum_columns:
                output.append(decimal_string(sum(values[column], Decimal(0))))
            for column in avg_columns:
                total = sum(values[column], Decimal(0))
                output.append(decimal_string(total / Decimal(len(values[column]))))
            output_rows.append(output)
        return output_headers, output_rows
    except DecimalException as exc:
        raise CSVInsightsError(f"decimal arithmetic failed: {exc}") from exc


def write_output(
    output_format: str,
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
    stream: TextIO,
) -> None:
    if output_format == "json":
        objects = [dict(zip(headers, row)) for row in rows]
        json.dump(objects, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)
    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise CSVInsightsError("--sum and --avg require --group-by")

    headers, numbered_rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    if args.group_by is not None:
        requested_columns.append(args.group_by)
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    check_columns(requested_columns, headers)
    filtered = select_rows(headers, numbered_rows, filters)

    if args.sum_columns or args.avg_columns:
        output_headers, output_rows = aggregate(
            headers,
            filtered,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_headers = list(headers)
        output_rows = [row for _, row in filtered]
    write_output(args.output, output_headers, output_rows, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CSVInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

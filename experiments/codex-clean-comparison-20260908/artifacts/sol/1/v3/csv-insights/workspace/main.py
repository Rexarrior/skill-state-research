#!/usr/bin/env python3
"""Dependency-free command-line analytics for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence


class CsvInsightsError(Exception):
    """An input or usage error suitable for display to a CLI user."""


def fail(message: str) -> NoReturn:
    raise CsvInsightsError(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
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
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        stream = open(Path(path), "r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        fail(f"cannot open input file {path!r}: {exc}")

    try:
        with stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                fail("input is empty; a header row is required")
            except csv.Error as exc:
                fail(f"malformed CSV header: {exc}")

            if not header:
                fail("header row is empty")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if name == ""]
            if empty_positions:
                fail(f"header names must be non-empty (column {', '.join(empty_positions)})")
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                fail(f"duplicate header name(s): {', '.join(repr(x) for x in duplicates)}")

            rows: list[tuple[int, list[str]]] = []
            try:
                for record_number, row in enumerate(reader, start=2):
                    if len(row) != len(header):
                        fail(
                            f"row {record_number} has {len(row)} fields; "
                            f"expected {len(header)}"
                        )
                    rows.append((record_number, row))
            except csv.Error as exc:
                fail(f"malformed CSV near record {len(rows) + 2}: {exc}")
    except UnicodeError as exc:
        fail(f"input is not valid UTF-8: {exc}")
    except OSError as exc:
        fail(f"could not read input file {path!r}: {exc}")

    return header, rows


def column_index(header: list[str], name: str, option: str) -> int:
    try:
        return header.index(name)
    except ValueError:
        fail(f"unknown column for {option}: {name!r}")


def parse_filters(header: list[str], raw_filters: list[str]) -> list[tuple[int, str]]:
    filters: list[tuple[int, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            fail(f"malformed --where filter {expression!r}; expected COLUMN=VALUE")
        name, value = expression.split("=", 1)
        if not name:
            fail(f"malformed --where filter {expression!r}; column is empty")
        filters.append((column_index(header, name, "--where"), value))
    return filters


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        fail(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        fail(f"row {row_number}, column {column!r}: invalid numeric value {value!r}")
    if not number.is_finite():
        fail(f"row {row_number}, column {column!r}: invalid numeric value {value!r}")
    return number


def format_decimal(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    header: list[str],
    rows: list[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = column_index(header, group_column, "--group-by")
    sum_index = column_index(header, sum_column, "--sum") if sum_column else None
    avg_index = column_index(header, avg_column, "--avg") if avg_column else None

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")
    if len(set(output_header)) != len(output_header):
        fail("aggregate output column names are not unique")

    groups: dict[str, dict[str, Decimal | int]] = {}
    for record_number, row in rows:
        key = row[group_index]
        stats = groups.setdefault(
            key, {"sum": Decimal(0), "avg_sum": Decimal(0), "avg_count": 0}
        )
        if sum_index is not None and sum_column is not None:
            stats["sum"] = stats["sum"] + decimal_value(
                row[sum_index], record_number, sum_column
            )
        if avg_index is not None and avg_column is not None:
            stats["avg_sum"] = stats["avg_sum"] + decimal_value(
                row[avg_index], record_number, avg_column
            )
            stats["avg_count"] = stats["avg_count"] + 1

    result: list[dict[str, str]] = []
    for key in sorted(groups):
        stats = groups[key]
        item = {group_column: key}
        if sum_column:
            item[f"sum_{sum_column}"] = format_decimal(stats["sum"])
        if avg_column:
            average = stats["avg_sum"] / stats["avg_count"]
            item[f"avg_{avg_column}"] = format_decimal(average)
        result.append(item)
    return output_header, result


def emit_json(rows: list[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def emit_csv(header: list[str], rows: list[dict[str, str]]) -> None:
    writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    header, numbered_rows = read_csv(args.input)
    filters = parse_filters(header, args.where)
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[index] == value for index, value in filters)
    ]

    if args.sum_column or args.avg_column:
        output_header, output_rows = aggregate(
            header,
            filtered,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
    else:
        if args.group_by:
            column_index(header, args.group_by, "--group-by")
        output_header = header
        output_rows = [dict(zip(header, row)) for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_header, output_rows)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

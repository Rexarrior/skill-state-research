#!/usr/bin/env python3
"""Dependency-free command-line analytics for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be presented to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        self.exit(2, f"error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        description="Filter and aggregate an RFC-4180-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows with an exact value match; may be repeated",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column must not be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty") from exc

            if not header:
                raise CsvInsightsError("input CSV has no header")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty "
                    f"(empty field at position {', '.join(empty_positions)})"
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
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def require_column(column: str, header: Sequence[str], option: str) -> int:
    try:
        return header.index(column)
    except ValueError as exc:
        raise CsvInsightsError(f"unknown column {column!r} for {option}") from exc


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value in row {row_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value in row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value in row {row_number}, column {column!r}: {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        return "0"
    return text


def filtered_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexed = [(require_column(name, header, "--where"), value) for name, value in filters]
    return [
        (number, row)
        for number, row in rows
        if all(row[index] == value for index, value in indexed)
    ]


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = require_column(group_column, header, "--group-by")
    sum_index = require_column(sum_column, header, "--sum") if sum_column else None
    avg_index = require_column(avg_column, header, "--avg") if avg_column else None
    groups: dict[str, dict[str, Decimal | int]] = {}

    for row_number, row in rows:
        group = row[group_index]
        values = groups.setdefault(
            group, {"sum": Decimal(0), "avg_sum": Decimal(0), "avg_count": 0}
        )
        if sum_column is not None and sum_index is not None:
            values["sum"] = values["sum"] + decimal_value(
                row[sum_index], row_number, sum_column
            )
        if avg_column is not None and avg_index is not None:
            values["avg_sum"] = values["avg_sum"] + decimal_value(
                row[avg_index], row_number, avg_column
            )
            values["avg_count"] = values["avg_count"] + 1

    output_header = [group_column]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    result: list[dict[str, str]] = []
    for group in sorted(groups):
        values = groups[group]
        record = {group_column: group}
        if sum_column is not None:
            record[f"sum_{sum_column}"] = decimal_string(values["sum"])
        if avg_column is not None:
            average = values["avg_sum"] / values["avg_count"]
            record[f"avg_{avg_column}"] = decimal_string(average)
        result.append(record)
    return output_header, result


def write_output(
    output_format: str,
    header: Sequence[str],
    records: Sequence[dict[str, str]],
    destination: TextIO,
) -> None:
    if output_format == "json":
        json.dump(records, destination, ensure_ascii=False, indent=2)
        destination.write("\n")
        return
    writer = csv.DictWriter(destination, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(records)


def run(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")

    filters = parse_filters(args.where)
    header, rows = read_csv(Path(args.input))
    rows = filtered_rows(header, rows, filters)

    if args.group_by:
        output_header, records = aggregate(
            header, rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = header
        records = [dict(zip(header, row)) for _, row in rows]
    write_output(args.output, output_header, records, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

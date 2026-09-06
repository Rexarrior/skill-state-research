#!/usr/bin/env python3
"""A small dependency-free CSV filtering and aggregation command line tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable


class CsvInsightsError(Exception):
    """An expected input or command-line error."""


def parse_filter(text: str) -> tuple[str, str]:
    """Parse COLUMN=VALUE, allowing values themselves to contain equals signs."""
    if "=" not in text:
        raise argparse.ArgumentTypeError(
            f"malformed filter {text!r}; expected COLUMN=VALUE"
        )
    column, value = text.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError(
            f"malformed filter {text!r}; column name cannot be empty"
        )
    return column, value


def decimal_string(value: Decimal) -> str:
    """Return the shortest ordinary decimal representation without exponent form."""
    if value == 0:
        return "0"
    normalized = value.normalize()
    text = format(normalized, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            # ``strict`` makes malformed quoting (for example an unclosed
            # quoted field) a csv.Error instead of silently accepting it.
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not headers:
                raise CsvInsightsError("CSV header row is empty")
            if any(not header for header in headers):
                raise CsvInsightsError("CSV headers must be non-empty")
            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "CSV headers must be unique: " + ", ".join(duplicates)
                )

            rows: list[tuple[int, dict[str, str]]] = []
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(fields)} fields; expected {len(headers)}"
                    )
                rows.append((row_number, dict(zip(headers, fields))))
            return headers, rows
    except FileNotFoundError:
        raise CsvInsightsError(f"input file not found: {path}") from None
    except IsADirectoryError:
        raise CsvInsightsError(f"input path is a directory: {path}") from None
    except UnicodeDecodeError as error:
        raise CsvInsightsError(f"input is not valid UTF-8: {error}") from None
    except csv.Error as error:
        raise CsvInsightsError(f"malformed CSV: {error}") from None
    except OSError as error:
        raise CsvInsightsError(f"cannot read input file: {error}") from None


def validate_columns(headers: Iterable[str], columns: Iterable[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column}")


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if not value:
        raise CsvInsightsError(f"blank numeric value at row {row_number}, column {column}")
    try:
        result = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"invalid numeric value {value!r} at row {row_number}, column {column}"
        ) from None
    if not result.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value {value!r} at row {row_number}, column {column}"
        )
    return result


def aggregate(
    rows: list[tuple[int, dict[str, str]]], group_by: str, sums: list[str], averages: list[str]
) -> list[dict[str, str]]:
    values: dict[str, dict[str, Decimal | int]] = defaultdict(dict)
    for row_number, row in rows:
        group = row[group_by]
        bucket = values[group]
        bucket["__count__"] = int(bucket.get("__count__", 0)) + 1
        for column in set(sums) | set(averages):
            numeric = parse_decimal(row[column], row_number, column)
            bucket[column] = Decimal(bucket.get(column, Decimal(0))) + numeric

    result: list[dict[str, str]] = []
    for group in sorted(values):
        bucket = values[group]
        record = {group_by: group}
        for column in sums:
            record[f"sum_{column}"] = decimal_string(Decimal(bucket[column]))
        for column in averages:
            record[f"avg_{column}"] = decimal_string(
                Decimal(bucket[column]) / int(bucket["__count__"])
            )
        result.append(record)
    return result


def write_output(records: list[dict[str, str]], headers: list[str], output: str) -> None:
    if output == "json":
        json.dump(records, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Filter and aggregate an RFC-4180 CSV file.")
    parser.add_argument("input", type=Path, metavar="INPUT.csv")
    parser.add_argument("--where", action="append", type=parse_filter, default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sums", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="averages", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if (args.sums or args.averages) and not args.group_by:
        parser.error("--sum and --avg require --group-by")

    try:
        headers, rows = read_csv(args.input)
        validate_columns(headers, [column for column, _ in args.where])
        validate_columns(headers, [column for column in (args.group_by, *args.sums, *args.averages) if column])
        filtered = [
            (number, row)
            for number, row in rows
            if all(row[column] == value for column, value in args.where)
        ]
        if args.group_by:
            output_headers = [args.group_by] + [f"sum_{column}" for column in args.sums] + [
                f"avg_{column}" for column in args.averages
            ]
            records = aggregate(filtered, args.group_by, args.sums, args.averages)
        else:
            output_headers = headers
            records = [row for _, row in filtered]
        write_output(records, output_headers, args.output)
        return 0
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

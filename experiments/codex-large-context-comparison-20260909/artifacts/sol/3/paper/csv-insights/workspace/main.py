#!/usr/bin/env python3
"""CSV Insights: a small, dependency-free CSV analytics command line tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


class SingleColumnAction(argparse.Action):
    """Store an option once and report repeated occurrences as usage errors."""

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: str,
        option_string: str | None = None,
    ) -> None:
        if getattr(namespace, self.dest, None) is not None:
            parser.error(f"{option_string} may only be specified once")
        setattr(namespace, self.dest, values)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-4180-style CSV file."
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
        "--sum", dest="sum_column", action=SingleColumnAction, metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_column", action=SingleColumnAction, metavar="COLUMN"
    )
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def fail(message: str) -> NoReturn:
    raise CsvInsightsError(message)


def validate_header(header: list[str] | None) -> list[str]:
    if header is None:
        fail("input is empty; a header row is required")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
    if empty_positions:
        fail(f"header contains an empty column name at position {', '.join(empty_positions)}")
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        fail(f"header contains duplicate column name(s): {', '.join(duplicates)}")
    return header


def parse_filters(raw_filters: list[str], columns: set[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            fail(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        column, value = expression.split("=", 1)
        if not column:
            fail(f"malformed filter {expression!r}; column name is empty")
        if column not in columns:
            fail(f"unknown column in --where: {column!r}")
        filters.append((column, value))
    return filters


def validate_arguments(args: argparse.Namespace, header: list[str]) -> None:
    columns = set(header)
    if (args.sum_column or args.avg_column) and not args.group_by:
        fail("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        fail("--group-by requires --sum, --avg, or both")
    for option, column in (
        ("--group-by", args.group_by),
        ("--sum", args.sum_column),
        ("--avg", args.avg_column),
    ):
        if column is not None and column not in columns:
            fail(f"unknown column for {option}: {column!r}")


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


def decimal_text(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def read_and_process(stream: TextIO, args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    reader = csv.reader(stream, strict=True)
    try:
        header = validate_header(next(reader, None))
        validate_arguments(args, header)
        filters = parse_filters(args.where, set(header))
        indexes = {name: index for index, name in enumerate(header)}

        if not args.group_by:
            output_rows: list[dict[str, str]] = []
            for row_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    fail(
                        f"row {row_number}: expected {len(header)} fields, found {len(row)}"
                    )
                if all(row[indexes[column]] == value for column, value in filters):
                    output_rows.append(dict(zip(header, row)))
            return header, output_rows

        # Each group stores [sum total, sum count, avg total, avg count]. Counts
        # for sum and average are separate to keep the representation explicit.
        groups: dict[str, list[Decimal | int]] = {}
        for row_number, row in enumerate(reader, start=2):
            if len(row) != len(header):
                fail(f"row {row_number}: expected {len(header)} fields, found {len(row)}")
            if not all(row[indexes[column]] == value for column, value in filters):
                continue

            group = row[indexes[args.group_by]]
            state = groups.setdefault(group, [Decimal(0), 0, Decimal(0), 0])
            if args.sum_column:
                value = decimal_value(row[indexes[args.sum_column]], row_number, args.sum_column)
                state[0] += value
                state[1] += 1
            if args.avg_column:
                value = decimal_value(row[indexes[args.avg_column]], row_number, args.avg_column)
                state[2] += value
                state[3] += 1

        output_header = [args.group_by]
        if args.sum_column:
            output_header.append(f"sum_{args.sum_column}")
        if args.avg_column:
            output_header.append(f"avg_{args.avg_column}")

        output_rows = []
        for group in sorted(groups):
            state = groups[group]
            result = {args.group_by: group}
            if args.sum_column:
                result[f"sum_{args.sum_column}"] = decimal_text(state[0])
            if args.avg_column:
                result[f"avg_{args.avg_column}"] = decimal_text(state[2] / state[3])
            output_rows.append(result)
        return output_header, output_rows
    except csv.Error as exc:
        fail(f"malformed CSV near line {reader.line_num}: {exc}")


def emit(header: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(
        sys.stdout, fieldnames=header, lineterminator="\r\n", extrasaction="raise"
    )
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        with Path(args.input).open("r", encoding="utf-8", newline="") as stream:
            header, rows = read_and_process(stream, args)
        emit(header, rows, args.output)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError) as exc:
        print(f"error: cannot read {args.input!r}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

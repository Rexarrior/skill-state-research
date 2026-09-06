#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV analytics CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


class StoreOnce(argparse.Action):
    """Store an option value, rejecting repeated occurrences."""

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: str,
        option_string: str | None = None,
    ) -> None:
        if getattr(namespace, self.dest, None) is not None:
            raise CsvInsightsError(f"{option_string} may be specified only once")
        setattr(namespace, self.dest, values)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", action=StoreOnce)
    parser.add_argument(
        "--sum", dest="sum_column", metavar="COLUMN", action=StoreOnce
    )
    parser.add_argument(
        "--avg", dest="avg_column", metavar="COLUMN", action=StoreOnce
    )
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters: list[tuple[str, str]] = []
    for expression in args.where:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: column must not be empty"
            )
        filters.append((column, value))
    args.filters = filters
    return args


def read_csv(source: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with source.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty") from exc

            if not header:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty column(s): "
                    + ", ".join(empty_positions)
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique; duplicate(s): "
                    + ", ".join(repr(name) for name in duplicates)
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
        raise CsvInsightsError(f"cannot read {source}: {exc}") from exc


def column_indexes(header: list[str], names: Sequence[str | None]) -> dict[str, int]:
    indexes = {name: index for index, name in enumerate(header)}
    for name in names:
        if name is not None and name not in indexes:
            raise CsvInsightsError(f"unknown column: {name!r}")
    return indexes


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
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


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals without rounding to the ambient context precision."""
    left_tuple = left.as_tuple()
    right_tuple = right.as_tuple()
    common_exponent = min(left_tuple.exponent, right_tuple.exponent)
    left_digits = len(left_tuple.digits) + left_tuple.exponent - common_exponent
    right_digits = len(right_tuple.digits) + right_tuple.exponent - common_exponent
    with localcontext() as context:
        context.prec = max(left_digits, right_digits) + 1
        return left + right


def analyze(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    header, numbered_rows = read_csv(args.input)
    referenced = [name for name, _ in args.filters]
    referenced.extend((args.group_by, args.sum_column, args.avg_column))
    indexes = column_indexes(header, referenced)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[indexes[column]] == value for column, value in args.filters)
    ]

    if not (args.sum_column or args.avg_column):
        return header, [dict(zip(header, row)) for _, row in filtered]

    group_index = indexes[args.group_by]
    groups: dict[str, dict[str, object]] = {}
    numeric_columns = [
        column for column in (args.sum_column, args.avg_column) if column is not None
    ]
    for row_number, row in filtered:
        values = {
            column: parse_decimal(row[indexes[column]], row_number, column)
            for column in numeric_columns
        }
        group = row[group_index]
        state = groups.setdefault(
            group,
            {"count": 0, "sums": {column: Decimal(0) for column in numeric_columns}},
        )
        state["count"] = int(state["count"]) + 1
        sums = state["sums"]
        assert isinstance(sums, dict)
        for column, value in values.items():
            sums[column] = exact_add(sums[column], value)

    result_header = [args.group_by]
    if args.sum_column:
        result_header.append(f"sum_{args.sum_column}")
    if args.avg_column:
        result_header.append(f"avg_{args.avg_column}")

    results: list[dict[str, str]] = []
    with localcontext() as context:
        context.prec = 28
        for group in sorted(groups):
            state = groups[group]
            sums = state["sums"]
            assert isinstance(sums, dict)
            output = {args.group_by: group}
            if args.sum_column:
                output[f"sum_{args.sum_column}"] = decimal_string(
                    sums[args.sum_column]
                )
            if args.avg_column:
                average = sums[args.avg_column] / int(state["count"])
                output[f"avg_{args.avg_column}"] = decimal_string(average)
            results.append(output)
    return result_header, results


def write_output(
    output_format: str,
    header: list[str],
    rows: list[dict[str, str]],
    stream: TextIO,
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        return
    writer = csv.DictWriter(stream, fieldnames=header, extrasaction="raise")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        header, rows = analyze(args)
        write_output(args.output, header, rows, sys.stdout)
        return 0
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files using only the Python standard library."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path


class CliError(Exception):
    """An expected input or command-line error."""


def parse_filter(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("filter must have the form COLUMN=VALUE")
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError("filter column must not be empty")
    return column, expected


def read_csv(filename: str) -> tuple[list[str], list[dict[str, str]]]:
    try:
        with Path(filename).open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CliError("input CSV is empty")
            if not headers or any(header == "" for header in headers):
                raise CliError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise CliError("CSV headers must be unique")

            rows = []
            for row_number, values in enumerate(reader, start=2):
                if len(values) != len(headers):
                    raise CliError(
                        f"row {row_number} has {len(values)} fields; expected {len(headers)}"
                    )
                rows.append(dict(zip(headers, values)))
            return headers, rows
    except OSError as error:
        raise CliError(f"cannot read input file: {error}") from error
    except csv.Error as error:
        raise CliError(f"malformed CSV: {error}") from error


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CliError(f"invalid numeric value at row {row_number}, column {column}: blank")
    try:
        result = Decimal(value)
    except InvalidOperation:
        raise CliError(f"invalid numeric value at row {row_number}, column {column}: {value!r}")
    if not result.is_finite():
        raise CliError(f"invalid numeric value at row {row_number}, column {column}: {value!r}")
    return result


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def output_rows(headers: list[str], rows: list[dict[str, str]], kind: str) -> None:
    if kind == "json":
        print(json.dumps([dict((header, row[header]) for header in headers) for row in rows], ensure_ascii=False))
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Filter and aggregate a CSV file.")
    parser.add_argument("input", help="input CSV file")
    parser.add_argument("--where", action="append", default=[], type=parse_filter, metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")

    try:
        headers, rows = read_csv(args.input)
        requested = [column for column, _ in args.where]
        requested += [column for column in (args.group_by, args.sum_column, args.avg_column) if column]
        for column in requested:
            if column not in headers:
                raise CliError(f"unknown column: {column}")

        filtered = [row for row in rows if all(row[column] == expected for column, expected in args.where)]
        if not args.group_by:
            output_rows(headers, filtered, args.output)
            return 0

        groups: OrderedDict[str, dict[str, Decimal | int]] = OrderedDict()
        for input_index, row in enumerate(rows, start=2):
            if not all(row[column] == expected for column, expected in args.where):
                continue
            key = row[args.group_by]
            state = groups.setdefault(key, {"count": 0})
            state["count"] = int(state["count"]) + 1
            if args.sum_column:
                state["sum"] = state.get("sum", Decimal(0)) + decimal_value(row[args.sum_column], input_index, args.sum_column)
            if args.avg_column:
                state["avg_total"] = state.get("avg_total", Decimal(0)) + decimal_value(row[args.avg_column], input_index, args.avg_column)

        result_headers = [args.group_by]
        if args.sum_column:
            result_headers.append(f"sum_{args.sum_column}")
        if args.avg_column:
            result_headers.append(f"avg_{args.avg_column}")
        result_rows = []
        for key in sorted(groups):
            state = groups[key]
            result: dict[str, str] = {args.group_by: key}
            if args.sum_column:
                result[f"sum_{args.sum_column}"] = decimal_text(state["sum"])
            if args.avg_column:
                result[f"avg_{args.avg_column}"] = decimal_text(state["avg_total"] / int(state["count"]))
            result_rows.append(result)
        output_rows(result_headers, result_rows, args.output)
        return 0
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

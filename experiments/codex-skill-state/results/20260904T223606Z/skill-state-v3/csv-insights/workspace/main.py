#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files without external dependencies."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence


class InputError(ValueError):
    """An invalid command argument or CSV input."""


def column_name(value: str) -> str:
    if not value:
        raise argparse.ArgumentTypeError("column names must not be empty")
    return value


def parse_filter(value: str) -> tuple[str, str]:
    if value.count("=") != 1:
        raise argparse.ArgumentTypeError(
            f"malformed filter {value!r}; expected COLUMN=VALUE"
        )
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError(
            f"malformed filter {value!r}; column name must not be empty"
        )
    return column, expected


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument("--where", action="append", default=[], type=parse_filter,
                        metavar="COLUMN=VALUE", help="keep rows matching an exact value")
    parser.add_argument("--group-by", type=column_name, metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", type=column_name, metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", type=column_name, metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


def read_csv(filename: str) -> tuple[list[str], list[dict[str, str]]]:
    try:
        with Path(filename).open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise InputError("input CSV is empty")
            if not headers or any(not name for name in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")

            rows: list[dict[str, str]] = []
            for row_number, values in enumerate(reader, start=2):
                if len(values) != len(headers):
                    raise InputError(
                        f"row {row_number} has {len(values)} fields; expected {len(headers)}"
                    )
                rows.append(dict(zip(headers, values)))
            return headers, rows
    except OSError as exc:
        raise InputError(f"cannot read input file {filename!r}: {exc}") from exc
    except csv.Error as exc:
        raise InputError(f"malformed CSV: {exc}") from exc


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    for name in columns:
        if name not in headers:
            raise InputError(f"unknown column: {name!r}")


def decimal_cell(value: str, row_number: int, column: str) -> Decimal:
    if not value:
        raise InputError(f"invalid numeric value at row {row_number}, column {column!r}: blank")
    try:
        result = Decimal(value)
    except InvalidOperation:
        result = Decimal("NaN")
    if not result.is_finite():
        raise InputError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return result


def decimal_text(value: Decimal) -> str:
    """Return fixed-point decimal text without needless trailing zeroes."""
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def filtered(rows: Sequence[dict[str, str]], filters: Sequence[tuple[str, str]]) -> list[dict[str, str]]:
    return [row for row in rows if all(row[column] == expected for column, expected in filters)]


def aggregate(rows: Sequence[dict[str, str]], args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    assert args.group_by
    buckets: dict[str, tuple[Decimal, Decimal, int]] = {}
    for index, row in enumerate(rows, start=2):
        total_sum, total_avg, count = buckets.get(row[args.group_by], (Decimal(0), Decimal(0), 0))
        if args.sum_column:
            total_sum += decimal_cell(row[args.sum_column], index, args.sum_column)
        if args.avg_column:
            total_avg += decimal_cell(row[args.avg_column], index, args.avg_column)
            count += 1
        buckets[row[args.group_by]] = total_sum, total_avg, count

    fields = [args.group_by]
    if args.sum_column:
        fields.append(f"sum_{args.sum_column}")
    if args.avg_column:
        fields.append(f"avg_{args.avg_column}")
    result: list[dict[str, str]] = []
    for group in sorted(buckets):
        total_sum, total_avg, count = buckets[group]
        item = {args.group_by: group}
        if args.sum_column:
            item[f"sum_{args.sum_column}"] = decimal_text(total_sum)
        if args.avg_column:
            item[f"avg_{args.avg_column}"] = decimal_text(total_avg / count)
        result.append(item)
    return fields, result


def write_output(fields: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        headers, rows = read_csv(args.input)
        require_columns(headers, [column for column, _ in args.where])
        if args.group_by:
            require_columns(headers, [item for item in (args.group_by, args.sum_column, args.avg_column) if item])
        selected = filtered(rows, args.where)
        if args.group_by:
            fields, result = aggregate(selected, args)
        else:
            fields, result = headers, selected
        write_output(fields, result, args.output)
        return 0
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

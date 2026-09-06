#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path


def parse_filter(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("filters must have the form COLUMN=VALUE")
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError("filter column must not be empty")
    return column, expected


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Filter and aggregate CSV data.")
    parser.add_argument("input", type=Path, metavar="INPUT.csv")
    parser.add_argument("--where", action="append", type=parse_filter, default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source)
            try:
                headers = next(reader)
            except StopIteration:
                raise ValueError("input CSV is empty")
            if not headers or any(not header for header in headers):
                raise ValueError("CSV headers must be non-empty")
            duplicates = {header for header in headers if headers.count(header) > 1}
            if duplicates:
                raise ValueError(f"CSV headers must be unique (duplicate: {sorted(duplicates)[0]!r})")

            rows = []
            for line_number, values in enumerate(reader, start=2):
                if len(values) != len(headers):
                    raise ValueError(
                        f"row {line_number} has {len(values)} fields; expected {len(headers)}"
                    )
                rows.append((line_number, dict(zip(headers, values))))
            return headers, rows
    except OSError as error:
        raise ValueError(f"cannot read {path}: {error}") from error
    except csv.Error as error:
        raise ValueError(f"malformed CSV: {error}") from error


def require_columns(columns: list[str], headers: list[str]) -> None:
    for column in columns:
        if column and column not in headers:
            raise ValueError(f"unknown column: {column}")


def decimal_value(value: str, line_number: int, column: str) -> Decimal:
    if not value:
        raise ValueError(f"invalid numeric value at row {line_number}, column {column!r}: blank")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(
            f"invalid numeric value at row {line_number}, column {column!r}: {value!r}"
        ) from error
    if not result.is_finite():
        raise ValueError(f"invalid numeric value at row {line_number}, column {column!r}: {value!r}")
    return result


def format_decimal(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def aggregate(rows, group_by: str, sum_column: str | None, avg_column: str | None):
    groups: dict[str, list] = {}
    for line_number, row in rows:
        bucket = groups.setdefault(row[group_by], [Decimal(0), Decimal(0), 0])
        if sum_column:
            bucket[0] += decimal_value(row[sum_column], line_number, sum_column)
        if avg_column:
            bucket[1] += decimal_value(row[avg_column], line_number, avg_column)
            bucket[2] += 1

    results = []
    for group, (sum_value, avg_total, avg_count) in sorted(groups.items()):
        result = {group_by: group}
        if sum_column:
            result[f"sum_{sum_column}"] = format_decimal(sum_value)
        if avg_column:
            result[f"avg_{avg_column}"] = format_decimal(avg_total / avg_count)
        results.append(result)
    return results


def write_output(rows: list[dict[str, str]], headers: list[str], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        headers, numbered_rows = read_csv(args.input)
        require_columns([column for column, _ in args.where] + [args.group_by, args.sum_column, args.avg_column], headers)
        filtered = [
            (line_number, row)
            for line_number, row in numbered_rows
            if all(row[column] == expected for column, expected in args.where)
        ]
        if args.group_by:
            rows = aggregate(filtered, args.group_by, args.sum_column, args.avg_column)
            output_headers = [args.group_by]
            if args.sum_column:
                output_headers.append(f"sum_{args.sum_column}")
            if args.avg_column:
                output_headers.append(f"avg_{args.avg_column}")
        else:
            rows = [row for _, row in filtered]
            output_headers = headers
        write_output(rows, output_headers, args.output)
        return 0
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

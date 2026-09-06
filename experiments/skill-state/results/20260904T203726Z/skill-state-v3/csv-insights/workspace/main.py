#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files."""

import argparse
import csv
import json
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation


def fail(message):
    raise ValueError(message)


def column_name(value):
    if not value:
        raise argparse.ArgumentTypeError("column name must not be empty")
    return value


def parse_filter(value):
    if "=" not in value:
        raise argparse.ArgumentTypeError(
            f"malformed filter {value!r}; expected COLUMN=VALUE"
        )
    column, expected = value.split("=", 1)
    if not column:
        raise argparse.ArgumentTypeError(
            f"malformed filter {value!r}; column name must not be empty"
        )
    return column, expected


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="input CSV file")
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


def read_csv(path):
    try:
        with open(path, "r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                fail("input CSV is empty")
            if not headers or any(not header for header in headers):
                fail("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                fail("CSV headers must be unique")
            rows = []
            for row_number, values in enumerate(reader, start=2):
                if len(values) != len(headers):
                    fail(
                        f"row {row_number} has {len(values)} fields; expected {len(headers)}"
                    )
                rows.append((row_number, dict(zip(headers, values))))
            return headers, rows
    except OSError as exc:
        fail(f"cannot read input file: {exc}")
    except csv.Error as exc:
        fail(f"malformed CSV: {exc}")


def validate_columns(headers, args):
    requested = [column for column, _ in args.where]
    requested.extend(value for value in (args.group_by, args.sum_column, args.avg_column) if value)
    for column in requested:
        if column not in headers:
            fail(f"unknown column: {column}")


def format_decimal(value):
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def number(value, row_number, column):
    if not value:
        fail(f"invalid numeric value at row {row_number}, column {column}: blank")
    try:
        result = Decimal(value)
    except InvalidOperation:
        fail(f"invalid numeric value at row {row_number}, column {column}: {value!r}")
    if not result.is_finite():
        fail(f"invalid numeric value at row {row_number}, column {column}: {value!r}")
    return result


def build_results(headers, rows, args):
    filtered = [row for row in rows if all(row[1][key] == value for key, value in args.where)]
    if not args.group_by:
        return headers, [row for _, row in filtered]

    output_headers = [args.group_by]
    if args.sum_column:
        output_headers.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_headers.append(f"avg_{args.avg_column}")
    groups = defaultdict(lambda: {"sum": Decimal(0), "avg_total": Decimal(0), "avg_count": 0})
    for row_number, row in filtered:
        group = groups[row[args.group_by]]
        if args.sum_column:
            group["sum"] += number(row[args.sum_column], row_number, args.sum_column)
        if args.avg_column:
            group["avg_total"] += number(row[args.avg_column], row_number, args.avg_column)
            group["avg_count"] += 1
    results = []
    for key in sorted(groups):
        group = groups[key]
        result = {args.group_by: key}
        if args.sum_column:
            result[f"sum_{args.sum_column}"] = format_decimal(group["sum"])
        if args.avg_column:
            result[f"avg_{args.avg_column}"] = format_decimal(group["avg_total"] / group["avg_count"])
        results.append(result)
    return output_headers, results


def write_results(headers, rows, output):
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def main(argv=None):
    try:
        args = parse_args(argv)
        headers, rows = read_csv(args.input)
        validate_columns(headers, args)
        output_headers, results = build_results(headers, rows, args)
        write_results(output_headers, results, args.output)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Dependency-free CSV filtering and Decimal aggregation."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, localcontext


class InputError(ValueError):
    """An actionable error in the input or requested operation."""


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        parser.error("--sum and --avg require --group-by")
    args.filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        args.filters.append((column, value))
    return args


def numeric(cell, row_number, column):
    # Decimal also accepts underscores and non-finite values; neither is a
    # numeric measurement. Permit whitespace, signs, fractions, and exponents.
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", cell.strip()):
        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}")
    try:
        value = Decimal(cell.strip())
        if not value.is_finite():
            raise ValueError
        return value
    except (DecimalException, ValueError):
        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}") from None


def exact_add(left, right):
    """Reserve enough precision for every input digit and a possible carry."""
    with localcontext() as context:
        context.prec = max(28, max(left.adjusted(), right.adjusted())
                           - min(left.as_tuple().exponent, right.as_tuple().exponent) + 2)
        return left + right


def decimal_string(value):
    if value == 0:
        return "0"
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def analyze(args):
    aggregates = [("sum", args.sum_column), ("avg", args.avg_column)]
    aggregates = [(operation, column) for operation, column in aggregates if column is not None]
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        headers = next(reader, None)
        if not headers or any(header == "" for header in headers):
            raise InputError("CSV must contain non-empty headers")
        if len(set(headers)) != len(headers):
            raise InputError("CSV headers must be unique")
        requested = [column for column, _ in args.filters]
        requested += [column for _, column in aggregates]
        if args.group_by is not None:
            requested.append(args.group_by)
        for column in requested:
            if column not in headers:
                raise InputError(f"unknown column {column!r}")

        output_headers = headers
        if aggregates:
            output_headers = [args.group_by] + [f"{op}_{col}" for op, col in aggregates]
            if len(set(output_headers)) != len(output_headers):
                raise InputError("aggregation output column names must be unique")
        rows = []
        groups = {}
        for row_number, fields in enumerate(reader, start=2):
            if len(fields) != len(headers):
                raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
            row = dict(zip(headers, fields))
            if not all(row[column] == value for column, value in args.filters):
                continue
            if not aggregates:
                rows.append(row)
                continue
            group = groups.setdefault(row[args.group_by], {"count": 0, "totals": {}})
            group["count"] += 1
            for column in dict.fromkeys(column for _, column in aggregates):
                value = numeric(row[column], row_number, column)
                try:
                    group["totals"][column] = exact_add(group["totals"].get(column, Decimal(0)), value)
                except (DecimalException, ValueError, OverflowError):
                    raise InputError(f"row {row_number}, column {column!r}: numeric value exceeds supported Decimal range") from None

        for key in sorted(groups):
            group = groups[key]
            row = {args.group_by: key}
            for operation, column in aggregates:
                value = group["totals"][column]
                if operation == "avg":
                    with localcontext() as context:
                        context.prec = max(28, len(value.as_tuple().digits) + len(str(group["count"])))
                        value = value / Decimal(group["count"])
                row[f"{operation}_{column}"] = decimal_string(value)
            rows.append(row)
        return output_headers, rows


def main(argv=None):
    args = parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            # Prevent newline translation from doubling CRLF on Windows.
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(newline="")
            writer = csv.DictWriter(sys.stdout, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
        return 0
    except (InputError, OSError, UnicodeError, csv.Error, DecimalException) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

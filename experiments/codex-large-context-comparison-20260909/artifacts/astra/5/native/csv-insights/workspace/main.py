#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """An actionable error in the input or query."""


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        parser.error("--sum and --avg require --group-by")
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))
    args.filters = filters
    return args


def numeric(cell, row, column):
    try:
        if not cell.strip():
            raise ValueError("blank value")
        value = Decimal(cell)
        if not value.is_finite():
            raise ValueError("non-finite value")
        return value
    except (ValueError, DecimalException) as error:
        raise InputError(
            f"row {row}, column {column!r}: invalid numeric value {cell!r}"
        ) from error


def exact_add(left, right):
    """Allow enough precision for every aligned digit, including a carry."""
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    with localcontext() as context:
        context.prec = max(28, left.adjusted() - exponent + 2, right.adjusted() - exponent + 2)
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def decimal_string(value):
    if value.is_zero():
        return "0"
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def average(total, count):
    with localcontext() as context:
        context.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return total / Decimal(count)


def analyze(args):
    # newline='' lets csv handle embedded newlines without translating them.
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers:
                raise InputError("input must contain a non-empty header row")
            if any(header == "" for header in headers):
                raise InputError("headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("headers must be unique")

            requested = [column for column, _ in args.filters]
            requested += [args.group_by, args.sum_column, args.avg_column]
            for column in requested:
                if column is not None and column not in headers:
                    raise InputError(f"unknown column {column!r}")

            aggregations = []
            if args.sum_column is not None:
                aggregations.append(("sum", args.sum_column))
            if args.avg_column is not None:
                aggregations.append(("avg", args.avg_column))
            output_headers = (
                [args.group_by] + [f"{operation}_{column}" for operation, column in aggregations]
                if aggregations else headers
            )
            if len(set(output_headers)) != len(output_headers):
                raise InputError("group column conflicts with a generated aggregate column name")

            rows = []
            groups = {}
            numeric_columns = {column for _, column in aggregations}
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(
                        f"row {row_number}: expected {len(headers)} fields, got {len(cells)}"
                    )
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if not aggregations:
                    rows.append(row)
                    continue
                values = {column: numeric(row[column], row_number, column) for column in numeric_columns}
                key = row[args.group_by]
                if key not in groups:
                    groups[key] = ({column: Decimal(0) for column in numeric_columns}, 0)
                totals, count = groups[key]
                for column, value in values.items():
                    totals[column] = exact_add(totals[column], value)
                groups[key] = (totals, count + 1)

            for key in sorted(groups):
                totals, count = groups[key]
                row = {args.group_by: key}
                for operation, column in aggregations:
                    value = totals[column] if operation == "sum" else average(totals[column], count)
                    row[f"{operation}_{column}"] = decimal_string(value)
                rows.append(row)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from error


def main(argv=None):
    args = arguments(argv)
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
        return 0
    except (OSError, UnicodeError, InputError, DecimalException) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

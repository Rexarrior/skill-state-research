#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Context, Decimal, DecimalException, localcontext


class InputError(ValueError):
    """An invalid input file or query."""


def arguments(argv=None):
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
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))
    args.filters = filters
    return args


def number(cell, row, column):
    try:
        if not cell.strip():
            raise ValueError("blank value")
        value = Decimal(cell)
        if not value.is_finite():
            raise ValueError("non-finite value")
        return value
    except (DecimalException, ValueError) as exc:
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {cell!r}") from exc


def exact_add(left, right):
    # Align every digit of both operands and allow room for a carry. Decimal's
    # default 28-digit context would otherwise silently round large sums.
    if not left:
        return right
    if not right:
        return left
    precision = max(left.adjusted(), right.adjusted()) - min(
        left.as_tuple().exponent, right.as_tuple().exponent
    ) + 2
    with localcontext(Context(prec=max(28, precision))) as context:
        context.Emax = max(context.Emax, left.adjusted() + 1, right.adjusted() + 1)
        context.Emin = min(context.Emin, left.as_tuple().exponent, right.as_tuple().exponent)
        return left + right


def decimal_text(value):
    if not value:
        return "0"
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def analyze(args):
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers:
                raise InputError("input must contain a non-empty header row")
            if any(header == "" for header in headers):
                raise InputError("header names must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("header names must be unique")
            requested = [column for column, _ in args.filters]
            requested += [args.group_by, args.sum_column, args.avg_column]
            for column in requested:
                if column is not None and column not in headers:
                    raise InputError(f"unknown column: {column!r}")

            output_headers = headers
            metrics = [("sum", args.sum_column), ("avg", args.avg_column)]
            metrics = [(operation, column) for operation, column in metrics if column is not None]
            if args.group_by is not None:
                output_headers = [args.group_by] + [f"{op}_{col}" for op, col in metrics]
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group and aggregate output column names collide")

            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(column for _, column in metrics))
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(
                        f"row {row_number}: expected {len(headers)} fields, got {len(cells)}"
                    )
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                if key not in groups:
                    groups[key] = [0, {column: Decimal(0) for column in numeric_columns}]
                group = groups[key]
                group[0] += 1
                for column in numeric_columns:
                    value = number(row[column], row_number, column)
                    group[1][column] = exact_add(group[1][column], value)
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from exc

    if args.group_by is not None:
        for key in sorted(groups):
            count, totals = groups[key]
            row = {args.group_by: key}
            for operation, column in metrics:
                value = totals[column]
                if operation == "avg":
                    with localcontext(Context(prec=28)):
                        value = value / Decimal(count)
                row[f"{operation}_{column}"] = decimal_text(value)
            rows.append(row)
    return output_headers, rows


def main(argv=None):
    args = arguments(argv)
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

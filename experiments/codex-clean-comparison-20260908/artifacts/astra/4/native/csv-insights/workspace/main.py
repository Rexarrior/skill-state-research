#!/usr/bin/env python3
"""Dependency-free CSV filtering and Decimal aggregation."""

import argparse
import csv
import json
import sys
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """An actionable error in input data or requested columns."""


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
    args.filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        args.filters.append((column, value))
    return args


def decimal_string(value):
    if value == 0:
        return "0"
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def exact_add(left, right):
    # Reserve enough significant digits for both operands and a possible carry.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def numeric(cell, row_number, column):
    try:
        value = Decimal(cell)
        if not value.is_finite():
            raise ValueError("non-finite number")
        return value
    except (DecimalException, ValueError):
        raise InputError(
            f"row {row_number}, column {column!r}: invalid numeric value {cell!r}"
        ) from None


def analyze(args):
    with open(args.input, "r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(header == "" for header in headers):
                raise InputError("CSV must have non-empty headers")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")

            requested = [column for column, _ in args.filters]
            requested += [column for column in
                          (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")

            aggregate = args.group_by is not None
            output_headers = headers
            if aggregate:
                output_headers = [args.group_by]
                if args.sum_column is not None:
                    output_headers.append(f"sum_{args.sum_column}")
                if args.avg_column is not None:
                    output_headers.append(f"avg_{args.avg_column}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group column conflicts with an aggregate output column")

            rows = []
            groups = {}
            numeric_columns = set(column for column in
                                  (args.sum_column, args.avg_column) if column is not None)
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(
                        f"row {row_number}: expected {len(headers)} fields, got {len(fields)}"
                    )
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if not aggregate:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                totals, count = groups.get(key, ({column: Decimal(0) for column in numeric_columns}, 0))
                for column in numeric_columns:
                    value = numeric(row[column], row_number, column)
                    try:
                        totals[column] = exact_add(totals[column], value)
                    except (DecimalException, ValueError, OverflowError):
                        raise InputError(
                            f"row {row_number}, column {column!r}: numeric value exceeds supported range"
                        ) from None
                groups[key] = (totals, count + 1)

            for key in sorted(groups):
                totals, count = groups[key]
                row = {args.group_by: key}
                if args.sum_column is not None:
                    row[f"sum_{args.sum_column}"] = decimal_string(totals[args.sum_column])
                if args.avg_column is not None:
                    total = totals[args.avg_column]
                    with localcontext() as context:
                        context.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                        context.Emax = MAX_EMAX
                        context.Emin = MIN_EMIN
                        average = total / Decimal(count)
                    row[f"avg_{args.avg_column}"] = decimal_string(average)
                rows.append(row)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {error}") from None


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
    except (InputError, OSError, UnicodeError, DecimalException) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped Decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext, MAX_EMAX, MIN_EMIN


class InputError(ValueError):
    """A user-facing data or query error."""


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
    return args


def decimal_text(value):
    if not value:
        return "0"
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def exact_add(left, right):
    """Allow every input digit and one carry digit, regardless of context."""
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def numeric(cell, row, column):
    try:
        number = Decimal(cell)
    except InvalidOperation:
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {cell!r}") from None
    if not number.is_finite():
        raise InputError(f"row {row}, column {column!r}: numeric value must be finite")
    return number


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise InputError("CSV must have non-empty headers")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            referenced = [column for column, _ in filters]
            referenced += [column for column in (args.group_by, args.sum_column, args.avg_column)
                           if column is not None]
            for column in referenced:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")

            operations = [("sum", args.sum_column), ("avg", args.avg_column)]
            operations = [(operation, column) for operation, column in operations if column is not None]
            output_headers = headers if args.group_by is None else (
                [args.group_by] + [f"{operation}_{column}" for operation, column in operations]
            )
            if len(set(output_headers)) != len(output_headers):
                raise InputError("aggregate output column names conflict with the group column")

            rows = []
            groups = {}
            numeric_columns = {column for _, column in operations}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if any(row[column] != value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                if key not in groups:
                    groups[key] = [0, dict.fromkeys(numeric_columns, Decimal(0))]
                group = groups[key]
                group[0] += 1
                for column in numeric_columns:
                    group[1][column] = exact_add(group[1][column], numeric(row[column], row_number, column))

            for key in sorted(groups):
                count, totals = groups[key]
                result = {args.group_by: key}
                for operation, column in operations:
                    value = totals[column]
                    if operation == "avg":
                        with localcontext() as context:
                            # Division by an integer can add fractional digits.
                            # This also preserves exact terminating averages.
                            context.prec = max(28, len(value.as_tuple().digits) + count.bit_length())
                            context.Emax = MAX_EMAX
                            context.Emin = MIN_EMIN
                            value = value / Decimal(count)
                    result[f"{operation}_{column}"] = decimal_text(value)
                rows.append(result)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {error}") from error


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
    except (InputError, OSError, UnicodeError, ArithmeticError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

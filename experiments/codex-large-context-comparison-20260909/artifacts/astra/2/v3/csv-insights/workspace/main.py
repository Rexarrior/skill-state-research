#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """An actionable error in the input data or requested columns."""


def decimal_text(value):
    if value.is_zero():
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Allow every integer and fractional digit plus a possible carry.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        return left + right


def parser():
    result = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    result.add_argument("input", metavar="INPUT.csv")
    result.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    result.add_argument("--group-by", metavar="COLUMN")
    result.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    result.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    result.add_argument("--output", choices=("json", "csv"), default="json")
    return result


def analyze(args):
    filters = []
    for condition in args.where:
        column, separator, value = condition.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {condition!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(header == "" for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")

            columns = headers
            aggregates = [(f"{operation}_{column}", column, operation)
                          for operation, column in (("sum", args.sum_column), ("avg", args.avg_column))
                          if column is not None]
            if args.group_by is not None:
                columns = [args.group_by] + [name for name, _, _ in aggregates]
                if len(set(columns)) != len(columns):
                    raise InputError("group column conflicts with an aggregate output column")
            rows = []
            groups = {}
            for row_number, values in enumerate(reader, start=2):
                if len(values) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(values)}")
                row = dict(zip(headers, values))
                if any(row[column] != value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                totals, count = groups.get(key, ([Decimal(0) for _ in aggregates], 0))
                for index, (_, column, _) in enumerate(aggregates):
                    cell = row[column]
                    try:
                        number = Decimal(cell)
                    except InvalidOperation:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}") from None
                    if not number.is_finite():
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}")
                    totals[index] = exact_add(totals[index], number)
                groups[key] = (totals, count + 1)
            for key in sorted(groups):
                totals, count = groups[key]
                row = {args.group_by: key}
                for (name, _, operation), total in zip(aggregates, totals):
                    if operation == "avg":
                        with localcontext() as context:
                            context.prec = max(28, len(total.as_tuple().digits))
                            total = total / Decimal(count)
                    row[name] = decimal_text(total)
                rows.append(row)
            return columns, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {error}") from None


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    if args.group_by is None and (args.sum_column is not None or args.avg_column is not None):
        cli.error("--sum and --avg require --group-by")
    try:
        columns, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=columns, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, ArithmeticError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

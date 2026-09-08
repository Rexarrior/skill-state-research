#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """Invalid input data or column selection."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Cover both operands' full fixed-point width, plus a carry digit.
    precision = max(left.adjusted(), right.adjusted()) - min(
        left.as_tuple().exponent, right.as_tuple().exponent
    ) + 2
    with localcontext() as ctx:
        ctx.prec = max(28, precision)
        return left + right


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
    for item in args.where:
        column, separator, value = item.partition("=")
        if not separator or not column:
            parser.error(f"malformed filter {item!r}: expected COLUMN=VALUE")
        filters.append((column, value))
    args.filters = filters
    return args


def analyze(args):
    with open(args.input, encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(header == "" for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(headers) != len(set(headers)):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in args.filters]
            requested += [column for column in
                          (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column: {column!r}")
            aggregating = args.sum_column is not None or args.avg_column is not None
            result_headers = [args.group_by] if aggregating else headers.copy()
            for operation, column in (("sum", args.sum_column), ("avg", args.avg_column)):
                if column is not None:
                    result_headers.append(f"{operation}_{column}")
            if len(result_headers) != len(set(result_headers)):
                raise InputError("group column conflicts with an aggregate output column")
            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(column for column in
                                                 (args.sum_column, args.avg_column)
                                                 if column is not None))
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if not aggregating:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                if key not in groups:
                    groups[key] = [0, {column: Decimal(0) for column in numeric_columns}]
                group = groups[key]
                group[0] += 1
                for column in numeric_columns:
                    try:
                        number = Decimal(row[column])
                        if not number.is_finite():
                            raise InvalidOperation
                    except (InvalidOperation, ValueError):
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}") from None
                    group[1][column] = exact_add(group[1][column], number)
            for key in sorted(groups):
                count, totals = groups[key]
                row = {args.group_by: key}
                if args.sum_column is not None:
                    row[f"sum_{args.sum_column}"] = decimal_text(totals[args.sum_column])
                if args.avg_column is not None:
                    total = totals[args.avg_column]
                    with localcontext() as ctx:
                        ctx.prec = max(28, len(total.as_tuple().digits) + len(str(count)) + 28)
                        average = total / Decimal(count)
                    row[f"avg_{args.avg_column}"] = decimal_text(average)
                rows.append(row)
            return result_headers, rows
        except csv.Error as exc:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {exc}") from None


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
    except (InputError, OSError, UnicodeError, ArithmeticError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

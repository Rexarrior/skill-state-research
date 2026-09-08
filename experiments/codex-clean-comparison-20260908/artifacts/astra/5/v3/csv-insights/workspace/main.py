#!/usr/bin/env python3
"""Dependency-free CSV filtering and decimal aggregation."""
import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """Invalid CSV data or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Reserve enough digits to align both operands and retain a carry.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        return left + right


def number(cell, row_number, column):
    try:
        value = Decimal(cell)
    except InvalidOperation:
        raise InputError(f"row {row_number}, column {column!r}: invalid numeric cell {cell!r}") from None
    if not value.is_finite():
        raise InputError(f"row {row_number}, column {column!r}: numeric cell must be finite")
    return value


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
            if not headers or any(header == "" for header in headers):
                raise InputError("CSV must have non-empty headers")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            aggregating = args.sum is not None or args.avg is not None
            output_headers = headers if not aggregating else [args.group_by]
            if aggregating:
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group column conflicts with an aggregate output column")
            results, groups = [], {}
            numeric_columns = set(column for column in (args.sum, args.avg) if column is not None)
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(cells)}")
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if not aggregating:
                    results.append(row)
                    continue
                totals, count = groups.get(row[args.group_by], ({column: Decimal(0) for column in numeric_columns}, 0))
                for column in numeric_columns:
                    totals[column] = exact_add(totals[column], number(row[column], row_number, column))
                groups[row[args.group_by]] = (totals, count + 1)
            for group, (totals, count) in sorted(groups.items()):
                result = {args.group_by: group}
                if args.sum is not None:
                    result[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
                if args.avg is not None:
                    total = totals[args.avg]
                    with localcontext() as context:
                        context.prec = max(28, len(total.as_tuple().digits))
                        result[f"avg_{args.avg}"] = decimal_text(total / Decimal(count))
                results.append(result)
            return output_headers, results
        except csv.Error as error:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {error}") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", metavar="COLUMN")
    parser.add_argument("--avg", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        parser.error("--sum and --avg require --group-by")
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

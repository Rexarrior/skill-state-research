#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys


class InputError(ValueError):
    """Invalid CSV content or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_sum(values):
    # Enough precision to align every coefficient and accommodate carry digits.
    if not values:
        return Decimal(0)
    lowest = min(value.as_tuple().exponent for value in values)
    highest = max(value.adjusted() for value in values)
    with localcontext() as context:
        context.prec = max(28, highest - lowest + 1 + len(str(len(values))))
        return sum(values, Decimal(0))


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}: expected COLUMN=VALUE")
        filters.append((column, value))
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column: {column!r}")
            aggregate = args.sum is not None or args.avg is not None
            output_headers = headers
            if aggregate:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group and aggregate output column names collide")
            rows = []
            groups = {}
            for row_number, cells in enumerate(reader, 2):
                if len(cells) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(cells)}")
                row = dict(zip(headers, cells))
                if any(row[column] != value for column, value in filters):
                    continue
                if not aggregate:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {})
                for column in dict.fromkeys(c for c in (args.sum, args.avg) if c is not None):
                    try:
                        value = Decimal(row[column])
                        if not value.is_finite():
                            raise InvalidOperation
                    except InvalidOperation:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}") from None
                    group.setdefault(column, []).append(value)
            if aggregate:
                for key in sorted(groups):
                    group = groups[key]
                    result = {args.group_by: key}
                    if args.sum is not None:
                        result[f"sum_{args.sum}"] = decimal_text(exact_sum(group[args.sum]))
                    if args.avg is not None:
                        values = group[args.avg]
                        total = exact_sum(values)
                        with localcontext() as context:
                            context.prec = max(28, len(total.as_tuple().digits) + len(str(len(values))))
                            result[f"avg_{args.avg}"] = decimal_text(total / Decimal(len(values)))
                    rows.append(result)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
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

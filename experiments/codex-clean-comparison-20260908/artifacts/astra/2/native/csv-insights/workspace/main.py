#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """An actionable input or configuration error."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    """Supply sufficient precision to add finite decimals without rounding."""
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    digits = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, digits)
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def numeric_cell(value, row_number, column):
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        raise InputError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise InputError(
            f"row {row_number}, column {column!r}: numeric value must be finite"
        )
    return number


def analyze(args):
    aggregating = args.sum is not None or args.avg is not None
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with open(args.input, "r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not column for column in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")

            output_headers = headers
            if aggregating:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group and aggregate output column names collide")

            rows = []
            groups = {}
            numeric_columns = set(column for column in (args.sum, args.avg)
                                  if column is not None)
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(
                        f"row {row_number}: expected {len(headers)} fields, got {len(fields)}"
                    )
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if not aggregating:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                if key not in groups:
                    groups[key] = [0, dict.fromkeys(numeric_columns, Decimal(0))]
                group = groups[key]
                group[0] += 1
                for column in numeric_columns:
                    number = numeric_cell(row[column], row_number, column)
                    group[1][column] = exact_add(group[1][column], number)
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None

    if aggregating:
        for key in sorted(groups):
            count, totals = groups[key]
            row = {args.group_by: key}
            if args.sum is not None:
                row[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
            if args.avg is not None:
                total = totals[args.avg]
                with localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits))
                    context.Emax = MAX_EMAX
                    context.Emin = MIN_EMIN
                    row[f"avg_{args.avg}"] = decimal_text(total / Decimal(count))
            rows.append(row)
    return output_headers, rows


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
            json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
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

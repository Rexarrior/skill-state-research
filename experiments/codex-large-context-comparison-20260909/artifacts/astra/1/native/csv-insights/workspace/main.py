#!/usr/bin/env python3
"""Filter and aggregate CSV files using only the Python standard library."""

import argparse
import csv
import decimal
import json
import sys


class InputError(ValueError):
    """A user-facing input or schema error."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Decimal's default precision can silently round even an addition.
    places = min(left.as_tuple().exponent, right.as_tuple().exponent)
    digits = max(left.adjusted(), right.adjusted()) - places + 2
    with decimal.localcontext() as context:
        context.prec = max(28, digits)
        context.Emax = decimal.MAX_EMAX
        context.Emin = decimal.MIN_EMIN
        return left + right


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
            parser.error(f"malformed filter {expression!r}: expected COLUMN=VALUE")
        args.filters.append((column, value))
    return args


def analyze(args):
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in args.filters]
            requested += [args.group_by, args.sum_column, args.avg_column]
            for column in requested:
                if column is not None and column not in headers:
                    raise InputError(f"unknown column {column!r}")

            output_headers = headers
            if args.group_by is not None:
                output_headers = [args.group_by]
                if args.sum_column is not None:
                    output_headers.append(f"sum_{args.sum_column}")
                if args.avg_column is not None:
                    output_headers.append(f"avg_{args.avg_column}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group column conflicts with an aggregate output column")

            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(
                column for column in (args.sum_column, args.avg_column) if column is not None
            ))
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(
                        f"row {row_number}: expected {len(headers)} fields, got {len(fields)}"
                    )
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                totals, count = groups.setdefault(
                    row[args.group_by], ({column: decimal.Decimal(0) for column in numeric_columns}, 0)
                )
                for column in numeric_columns:
                    try:
                        number = decimal.Decimal(row[column])
                        if not number.is_finite():
                            raise decimal.InvalidOperation
                    except decimal.InvalidOperation:
                        raise InputError(
                            f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}"
                        ) from None
                    totals[column] = exact_add(totals[column], number)
                groups[row[args.group_by]] = (totals, count + 1)
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None

    if args.group_by is not None:
        for group in sorted(groups):
            totals, count = groups[group]
            row = {args.group_by: group}
            if args.sum_column is not None:
                row[f"sum_{args.sum_column}"] = decimal_text(totals[args.sum_column])
            if args.avg_column is not None:
                total = totals[args.avg_column]
                with decimal.localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits))
                    context.Emax = decimal.MAX_EMAX
                    context.Emin = decimal.MIN_EMIN
                    average = total / decimal.Decimal(count)
                row[f"avg_{args.avg_column}"] = decimal_text(average)
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
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, decimal.DecimalException) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

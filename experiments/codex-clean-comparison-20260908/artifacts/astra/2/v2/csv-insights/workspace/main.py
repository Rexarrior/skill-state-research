#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped Decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """An invalid CSV or query."""


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def numeric(value, row, column):
    text = value.strip()
    if not NUMBER.fullmatch(text):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {value!r}")
    try:
        result = Decimal(text)
        if not result.is_finite():
            raise InvalidOperation
        return result
    except InvalidOperation as exc:
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {value!r}") from exc


def add_exact(left, right):
    # Preserve all integer and fractional places even beyond the default context.
    precision = max(left.adjusted(), right.adjusted()) - min(
        left.as_tuple().exponent, right.as_tuple().exponent
    ) + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        return left + right


def decimal_text(value):
    if value.is_zero():
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def analyze(args):
    aggregate = args.sum is not None or args.avg is not None
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with open(args.input, "r", encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not name for name in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested.extend(c for c in (args.group_by, args.sum, args.avg) if c is not None)
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            output_headers = headers
            if aggregate:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group column conflicts with an aggregate output column")
            rows = []
            groups = {}
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(
                        f"row {row_number}: expected {len(headers)} fields, got {len(cells)}"
                    )
                row = dict(zip(headers, cells))
                if any(row[column] != value for column, value in filters):
                    continue
                if not aggregate:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                totals, count = groups.get(key, ({}, 0))
                for column in dict.fromkeys(c for c in (args.sum, args.avg) if c is not None):
                    value = numeric(row[column], row_number, column)
                    totals[column] = add_exact(totals.get(column, Decimal(0)), value)
                groups[key] = (totals, count + 1)
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from exc

    if aggregate:
        for key in sorted(groups):
            totals, count = groups[key]
            row = {args.group_by: key}
            if args.sum is not None:
                row[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
            if args.avg is not None:
                total = totals[args.avg]
                with localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                    average = total / Decimal(count)
                row[f"avg_{args.avg}"] = decimal_text(average)
            rows.append(row)
    return output_headers, rows


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
            # newline='' prevents platform newline translation of CSV's CRLF.
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(newline="")
            writer = csv.DictWriter(sys.stdout, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, ArithmeticError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

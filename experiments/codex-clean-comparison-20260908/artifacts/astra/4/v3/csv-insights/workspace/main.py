#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, localcontext


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


class InputError(ValueError):
    """An invalid table or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Reserve every integer/fractional place plus one possible carry.
    lowest = min(left.as_tuple().exponent, right.as_tuple().exponent)
    highest = max(left.adjusted(), right.adjusted())
    with localcontext() as context:
        context.prec = max(28, highest - lowest + 2)
        context.Emax = max(context.Emax, highest + 2)
        context.Emin = min(context.Emin, lowest)
        return left + right


def numeric(cell, row_number, column):
    text = cell.strip()
    if not NUMBER.fullmatch(text):
        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}")
    try:
        value = Decimal(text)
    except ArithmeticError as exc:
        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}") from exc
    if not value.is_finite():
        raise InputError(f"row {row_number}, column {column!r}: numeric value must be finite")
    return value


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        raise InputError("--sum and --avg require --group-by")

    with open(args.input, encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers:
                raise InputError("input must contain a non-empty header")
            if any(header == "" for header in headers):
                raise InputError("headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            output_headers = headers if args.group_by is None else [args.group_by]
            if args.sum is not None:
                output_headers = output_headers + [f"sum_{args.sum}"]
            if args.avg is not None:
                output_headers = output_headers + [f"avg_{args.avg}"]
            if len(set(output_headers)) != len(output_headers):
                raise InputError("generated aggregation column conflicts with group column")

            rows = []
            groups = {}
            measures = list(dict.fromkeys(column for column in (args.sum, args.avg) if column is not None))
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(cells)}")
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                totals, count = groups.get(key, ({column: Decimal(0) for column in measures}, 0))
                for column in measures:
                    value = numeric(row[column], row_number, column)
                    try:
                        totals[column] = exact_add(totals[column], value)
                    except (ArithmeticError, ValueError) as exc:
                        raise InputError(f"row {row_number}, column {column!r}: numeric value exceeds supported decimal range") from exc
                groups[key] = totals, count + 1
        except csv.Error as exc:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc

    if args.group_by is not None:
        for key in sorted(groups):
            totals, count = groups[key]
            result = {args.group_by: key}
            if args.sum is not None:
                result[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
            if args.avg is not None:
                total = totals[args.avg]
                with localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                    context.Emax = max(context.Emax, total.adjusted() + 2)
                    context.Emin = min(context.Emin, total.as_tuple().exponent - len(str(count)))
                    result[f"avg_{args.avg}"] = decimal_text(total / Decimal(count))
            rows.append(result)
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
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            # Disable newline translation to preserve CSV CRLF and embedded newlines.
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(newline="")
            writer = csv.DictWriter(sys.stdout, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, ArithmeticError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

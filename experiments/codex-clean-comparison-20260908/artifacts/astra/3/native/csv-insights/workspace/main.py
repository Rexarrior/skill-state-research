#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """An error in the input data or requested columns."""


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def decimal_text(value):
    if not value:
        return "0"
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def exact_add(left, right):
    # Align both coefficients without rounding, including a possible carry.
    with localcontext() as ctx:
        ctx.prec = max(1, max(left.adjusted(), right.adjusted())
                       - min(left.as_tuple().exponent, right.as_tuple().exponent) + 2)
        ctx.Emax, ctx.Emin = MAX_EMAX, MIN_EMIN
        return left + right


def average(total, count):
    with localcontext() as ctx:
        # Enough precision for terminating quotients; recurring quotients have
        # at least 28 significant digits, rounded half to even.
        ctx.prec = max(28, len(total.as_tuple().digits) + 4 * len(str(count)) + 2)
        ctx.Emax, ctx.Emin = MAX_EMAX, MIN_EMIN
        return total / Decimal(count)


def numeric(cell, row_number, column):
    text = cell.strip()
    try:
        if not NUMBER.fullmatch(text):
            raise ValueError
        value = Decimal(text)
        if not value.is_finite():
            raise ValueError
        return value
    except (ValueError, DecimalException):
        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}") from None


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
            if not headers:
                raise InputError("input must contain a non-empty header")
            if any(not header.strip() for header in headers):
                raise InputError("headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("headers must be unique")
            requested = [column for column, _ in filters]
            requested.extend(column for column in (args.group_by, args.sum, args.avg)
                             if column is not None)
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")

            aggregating = args.sum is not None or args.avg is not None
            output_headers = headers
            if args.group_by is not None:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group and aggregate output column names conflict")

            rows, groups = [], {}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                state = groups.setdefault(key, {"count": 0, "sum": Decimal(0), "avg": Decimal(0)})
                state["count"] += 1
                if aggregating:
                    for operation in ("sum", "avg"):
                        column = getattr(args, operation)
                        if column is not None:
                            value = numeric(row[column], row_number, column)
                            try:
                                state[operation] = exact_add(state[operation], value)
                            except DecimalException as exc:
                                raise InputError(f"row {row_number}, column {column!r}: decimal arithmetic failed: {exc}") from None
            for key in sorted(groups):
                state = groups[key]
                result = {args.group_by: key}
                if args.sum is not None:
                    result[f"sum_{args.sum}"] = decimal_text(state["sum"])
                if args.avg is not None:
                    result[f"avg_{args.avg}"] = decimal_text(average(state["avg"], state["count"]))
                rows.append(result)
            return output_headers, rows
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from None


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
    except (InputError, OSError, UnicodeError, DecimalException) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Dependency-free CSV filtering and Decimal aggregation."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, localcontext


class InputError(ValueError):
    """An invalid CSV input or column selection."""


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def decimal_text(value):
    if value == 0:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Reserve every significant place plus a carry, independent of context precision.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = max(context.Emax, left.adjusted() + 2, right.adjusted() + 2)
        context.Emin = min(context.Emin, exponent)
        return left + right


def numeric(value, row, column):
    stripped = value.strip()
    if not NUMBER.fullmatch(stripped):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {value!r}")
    try:
        number = Decimal(stripped)
        if not number.is_finite():
            raise ValueError("non-finite number")
        return number
    except (DecimalException, ValueError) as exc:
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {value!r}") from exc


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
            header = next(reader, None)
            if not header or any(name == "" for name in header):
                raise InputError("CSV must have a non-empty header with non-empty column names")
            if len(set(header)) != len(header):
                raise InputError("CSV header contains duplicate column names")
            requested = [column for column, _ in filters]
            requested.extend(column for column in (args.group_by, args.sum, args.avg) if column is not None)
            for column in requested:
                if column not in header:
                    raise InputError(f"unknown column {column!r}")

            fields = header
            if args.group_by is not None:
                fields = [args.group_by]
                fields += [f"{operation}_{column}" for operation, column in (("sum", args.sum), ("avg", args.avg)) if column is not None]
                if len(set(fields)) != len(fields):
                    raise InputError("group column conflicts with an aggregate output column")
            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(column for column in (args.sum, args.avg) if column is not None))
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(header):
                    raise InputError(f"row {row_number}: expected {len(header)} fields, got {len(cells)}")
                row = dict(zip(header, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {"count": 0, "totals": {column: Decimal(0) for column in numeric_columns}})
                group["count"] += 1
                for column in numeric_columns:
                    value = numeric(row[column], row_number, column)
                    try:
                        group["totals"][column] = exact_add(group["totals"][column], value)
                    except (DecimalException, ValueError, OverflowError) as exc:
                        raise InputError(f"row {row_number}, column {column!r}: numeric value exceeds supported range") from exc
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from exc

    if args.group_by is not None:
        for key in sorted(groups):
            group = groups[key]
            row = {args.group_by: key}
            if args.sum is not None:
                row[f"sum_{args.sum}"] = decimal_text(group["totals"][args.sum])
            if args.avg is not None:
                total = group["totals"][args.avg]
                with localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits) + len(str(group["count"])))
                    context.Emax = max(context.Emax, total.adjusted() + 2)
                    context.Emin = min(context.Emin, total.as_tuple().exponent)
                    average = total / Decimal(group["count"])
                row[f"avg_{args.avg}"] = decimal_text(average)
            rows.append(row)
    return fields, rows


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
        fields, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=fields, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException, ValueError, OverflowError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

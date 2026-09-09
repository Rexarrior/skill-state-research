#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""
import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """A useful, user-facing input error."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def numeric(cell, row, column):
    # Decimal itself accepts underscores and non-finite values; CSV numbers do not.
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", cell.strip()):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {cell!r}")
    try:
        value = Decimal(cell.strip())
        if not value.is_finite():
            raise ValueError()
        return value
    except (DecimalException, ValueError):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {cell!r}") from None


def aggregate(values, average=False):
    # Allow every input digit plus enough carry digits for an exact sum.
    nonzero = [v for v in values if v]
    precision = 28
    if nonzero:
        precision = max(precision, max(v.adjusted() for v in nonzero)
                        - min(v.as_tuple().exponent for v in nonzero)
                        + len(str(len(values))) + 1)
    with localcontext() as context:
        context.prec = precision
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        total = sum(values, Decimal(0))
        return decimal_text(total / Decimal(len(values)) if average else total)


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
            if not headers or any(not name.strip() for name in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [c for c in (args.group_by, args.sum, args.avg) if c is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            rows = []
            groups = {}
            for row_number, fields in enumerate(reader, 2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {})
                for column in dict.fromkeys(c for c in (args.sum, args.avg) if c is not None):
                    group.setdefault(column, []).append(numeric(row[column], row_number, column))
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from None
    if args.group_by is None:
        return headers, rows
    output_headers = [args.group_by]
    for operation, column in (("sum", args.sum), ("avg", args.avg)):
        if column is not None:
            output_headers.append(f"{operation}_{column}")
    if len(set(output_headers)) != len(output_headers):
        raise InputError("group column conflicts with an aggregate output column")
    for key in sorted(groups):
        row = {args.group_by: key}
        for operation, column in (("sum", args.sum), ("avg", args.avg)):
            if column is not None:
                row[f"{operation}_{column}"] = aggregate(groups[key][column], operation == "avg")
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
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    """Allow every aligned digit plus a carry, independent of default precision."""
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    digits = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, digits)
        return left + right


def numeric(value, row_number, column):
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError):
        raise ValueError(f"row {row_number}, column {column!r}: invalid numeric value {value!r}") from None
    if not value.strip() or not result.is_finite():
        raise ValueError(f"row {row_number}, column {column!r}: expected a finite number, got {value!r}")
    return result


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise ValueError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        raise ValueError("--sum and --avg require --group-by")

    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise ValueError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise ValueError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
            for column in requested:
                if column not in headers:
                    raise ValueError(f"unknown column {column!r}")
            output_headers = headers
            if args.group_by is not None:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise ValueError("generated aggregate column conflicts with group column")
            rows = []
            groups = {}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise ValueError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {"count": 0, "sum": Decimal(0), "avg": Decimal(0)})
                group["count"] += 1
                for operation in ("sum", "avg"):
                    column = getattr(args, operation)
                    if column is not None:
                        group[operation] = exact_add(group[operation], numeric(row[column], row_number, column))
        except csv.Error as error:
            raise ValueError(f"malformed CSV near line {reader.line_num}: {error}") from None

    if args.group_by is not None:
        for key in sorted(groups):
            group = groups[key]
            row = {args.group_by: key}
            if args.sum is not None:
                row[f"sum_{args.sum}"] = decimal_text(group["sum"])
            if args.avg is not None:
                with localcontext() as context:
                    context.prec = max(28, len(group["avg"].as_tuple().digits))
                    average = group["avg"] / Decimal(group["count"])
                row[f"avg_{args.avg}"] = decimal_text(average)
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
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (OSError, UnicodeError, ValueError, ArithmeticError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

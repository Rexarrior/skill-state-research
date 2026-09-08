#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, DecimalException, localcontext


class InputError(ValueError):
    """An input or query cannot be processed."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def add_exact(left, right):
    # Preserve all places, including when magnitudes differ by many digits.
    with localcontext() as context:
        context.prec = max(
            left.adjusted(), right.adjusted()
        ) - min(left.as_tuple().exponent, right.as_tuple().exponent) + 2
        return left + right


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
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
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        args.filters.append((column, value))
    return args


def analyze(args):
    with open(args.input, "r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader, None)
            if not header or any(column == "" for column in header):
                raise InputError("CSV headers must be non-empty")
            if len(set(header)) != len(header):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in args.filters]
            requested += [column for column in
                          (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in header:
                    raise InputError(f"unknown column {column!r}")

            output_header = header
            if args.group_by is not None:
                output_header = [args.group_by]
                if args.sum_column is not None:
                    output_header.append(f"sum_{args.sum_column}")
                if args.avg_column is not None:
                    output_header.append(f"avg_{args.avg_column}")
                if len(set(output_header)) != len(output_header):
                    raise InputError("group column conflicts with an aggregate output column")

            rows = []
            groups = {}
            numeric_columns = set(column for column in
                                  (args.sum_column, args.avg_column)
                                  if column is not None)
            # Row numbers count CSV records; the header is row 1.
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(header):
                    raise InputError(
                        f"row {row_number}: expected {len(header)} fields, got {len(fields)}"
                    )
                row = dict(zip(header, fields))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                values = {}
                for column in numeric_columns:
                    try:
                        value = Decimal(row[column])
                        if not value.is_finite():
                            raise ValueError("non-finite number")
                    except (DecimalException, ValueError):
                        raise InputError(
                            f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}"
                        ) from None
                    values[column] = value
                key = row[args.group_by]
                totals, count = groups.get(key, ({column: Decimal(0) for column in numeric_columns}, 0))
                for column, value in values.items():
                    try:
                        totals[column] = add_exact(totals[column], value)
                    except (DecimalException, ValueError, OverflowError):
                        raise InputError(
                            f"row {row_number}, column {column!r}: numeric value exceeds supported range"
                        ) from None
                groups[key] = (totals, count + 1)

            for key in sorted(groups):
                totals, count = groups[key]
                result = {args.group_by: key}
                if args.sum_column is not None:
                    result[f"sum_{args.sum_column}"] = decimal_text(totals[args.sum_column])
                if args.avg_column is not None:
                    total = totals[args.avg_column]
                    with localcontext() as context:
                        context.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                        average = total / Decimal(count)
                    result[f"avg_{args.avg_column}"] = decimal_text(average)
                rows.append(result)
            return output_header, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None


def main(argv=None):
    args = parse_args(argv)
    try:
        header, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

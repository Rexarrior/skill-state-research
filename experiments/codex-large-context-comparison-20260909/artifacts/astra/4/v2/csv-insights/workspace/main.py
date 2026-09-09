#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import decimal
import json
import sys
from pathlib import Path


class InputError(ValueError):
    """An invalid input file or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_sum(values):
    # Align every coefficient at the smallest exponent, allowing carry digits.
    exponent = min(v.as_tuple().exponent for v in values)
    width = max(len(v.as_tuple().digits) + v.as_tuple().exponent - exponent
                for v in values)
    with decimal.localcontext() as context:
        context.prec = max(28, width + len(str(len(values))) + 1)
        context.Emax = decimal.MAX_EMAX
        context.Emin = decimal.MIN_EMIN
        return sum(values, decimal.Decimal(0))


def average(total, count):
    # Terminating quotients are exact; repeating quotients use at least 28 digits.
    with decimal.localcontext() as context:
        context.prec = max(28, len(total.as_tuple().digits) + len(str(count)) * 4)
        context.Emax = decimal.MAX_EMAX
        context.Emin = decimal.MIN_EMIN
        return total / decimal.Decimal(count)


def query(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with Path(args.input).open("r", encoding="utf-8", newline="") as source:
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
            requested += [column for column in (args.group_by, args.sum, args.avg)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column: {column!r}")
            numeric_columns = list(dict.fromkeys(
                column for column in (args.sum, args.avg) if column is not None))
            result = []
            groups = {}
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, "
                                     f"found {len(cells)}")
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    result.append(row)
                    continue
                group = groups.setdefault(row[args.group_by],
                                          {column: [] for column in numeric_columns})
                for column in numeric_columns:
                    try:
                        number = decimal.Decimal(row[column])
                        if not number.is_finite():
                            raise decimal.InvalidOperation
                    except (decimal.InvalidOperation, ValueError):
                        raise InputError(f"row {row_number}, column {column!r}: "
                                         f"invalid numeric value {row[column]!r}") from None
                    group[column].append(number)
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from error

    if args.group_by is None:
        return headers, result
    output_headers = [args.group_by]
    if args.sum is not None:
        output_headers.append(f"sum_{args.sum}")
    if args.avg is not None:
        output_headers.append(f"avg_{args.avg}")
    if len(set(output_headers)) != len(output_headers):
        raise InputError("group column conflicts with a generated aggregation column")
    for key in sorted(groups):
        row = {args.group_by: key}
        totals = {column: exact_sum(values) for column, values in groups[key].items()}
        if args.sum is not None:
            row[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
        if args.avg is not None:
            row[f"avg_{args.avg}"] = decimal_text(
                average(totals[args.avg], len(groups[key][args.avg])))
        result.append(row)
    return output_headers, result


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
        headers, rows = query(args)
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

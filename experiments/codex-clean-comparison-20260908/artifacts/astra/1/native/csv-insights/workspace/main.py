"""Dependency-free CSV filtering and grouped Decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, localcontext, MAX_EMAX, MIN_EMIN


class InputError(ValueError):
    """An invalid input or query."""


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def number(value, row, column):
    value = value.strip()
    try:
        if not NUMBER.fullmatch(value):
            raise ValueError
        result = Decimal(value)
        if not result.is_finite():
            raise ValueError
        return result
    except (ValueError, DecimalException):
        raise InputError(f"row {row}, column {column!r}: invalid numeric cell {value!r}") from None


def add_exact(left, right):
    """Reserve every integer and fractional digit, plus a possible carry."""
    places = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - places + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def decimal_text(value):
    if value.is_zero():
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


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
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        args.filters.append((column, value))
    return args


def analyze(args):
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header.strip() for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in args.filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            metrics = [(kind, column) for kind, column in
                       (("sum", args.sum_column), ("avg", args.avg_column)) if column is not None]
            output_headers = (headers if args.group_by is None else
                              [args.group_by] + [f"{kind}_{column}" for kind, column in metrics])
            if len(set(output_headers)) != len(output_headers):
                raise InputError("group column conflicts with an aggregate output column")
            results = []
            groups = {}
            numeric_columns = list(dict.fromkeys(column for _, column in metrics))
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(cells)}")
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    results.append(row)
                    continue
                key = row[args.group_by]
                if key not in groups:
                    groups[key] = [0, {column: Decimal(0) for column in numeric_columns}]
                group = groups[key]
                group[0] += 1
                for column in numeric_columns:
                    group[1][column] = add_exact(group[1][column], number(row[column], row_number, column))
            for key in sorted(groups):
                count, totals = groups[key]
                row = {args.group_by: key}
                for kind, column in metrics:
                    value = totals[column]
                    if kind == "avg":
                        with localcontext() as context:
                            context.prec = max(28, len(value.as_tuple().digits) + len(str(count)))
                            context.Emax = MAX_EMAX
                            context.Emin = MIN_EMIN
                            value = value / Decimal(count)
                    row[f"{kind}_{column}"] = decimal_text(value)
                results.append(row)
            return output_headers, results
        except csv.Error as error:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {error}") from None


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
        return 0
    except (InputError, OSError, UnicodeError, DecimalException, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

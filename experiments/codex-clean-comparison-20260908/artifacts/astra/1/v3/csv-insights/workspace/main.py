"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, localcontext, MAX_EMAX, MIN_EMIN


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def plain(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Preserve all decimal places, including widely separated magnitudes.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as ctx:
        ctx.prec = max(28, precision)
        ctx.Emax = MAX_EMAX
        ctx.Emin = MIN_EMIN
        return left + right


def numeric(text, row, column):
    try:
        stripped = text.strip()
        if not NUMBER.fullmatch(stripped):
            raise ValueError
        value = Decimal(stripped)
        if not value.is_finite():
            raise ValueError
        return value
    except (ValueError, DecimalException):
        raise ValueError(f"row {row}, column {column!r}: invalid numeric value {text!r}") from None


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise ValueError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        raise ValueError("--sum and --avg require --group-by")

    with open(args.input, encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not name.strip() for name in headers):
                raise ValueError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise ValueError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
            for column in requested:
                if column not in headers:
                    raise ValueError(f"unknown column {column!r}")
            fields = headers if args.group_by is None else [args.group_by]
            if args.group_by is not None:
                fields += [f"{operation}_{column}" for operation, column in
                           (("sum", args.sum), ("avg", args.avg)) if column is not None]
                if len(fields) != len(set(fields)):
                    raise ValueError("aggregate output column conflicts with group column")
            results = []
            groups = {}
            numeric_columns = set(column for column in (args.sum, args.avg) if column is not None)
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise ValueError(f"row {row_number}: expected {len(headers)} fields, got {len(cells)}")
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    results.append(row)
                    continue
                key = row[args.group_by]
                totals, count = groups.get(key, ({column: Decimal(0) for column in numeric_columns}, 0))
                for column in numeric_columns:
                    totals[column] = exact_add(totals[column], numeric(row[column], row_number, column))
                groups[key] = (totals, count + 1)
            for key in sorted(groups):
                totals, count = groups[key]
                result = {args.group_by: key}
                if args.sum is not None:
                    result[f"sum_{args.sum}"] = plain(totals[args.sum])
                if args.avg is not None:
                    total = totals[args.avg]
                    with localcontext() as ctx:
                        ctx.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                        ctx.Emax = MAX_EMAX
                        ctx.Emin = MIN_EMIN
                        result[f"avg_{args.avg}"] = plain(total / Decimal(count))
                results.append(result)
            return fields, results
        except csv.Error as error:
            raise ValueError(f"malformed CSV near physical line {reader.line_num}: {error}") from None


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
        fields, results = analyze(args)
        if args.output == "json":
            json.dump(results, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=fields, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(results)
    except (OSError, UnicodeError, ValueError, DecimalException) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

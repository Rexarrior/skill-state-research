"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys


class InputError(ValueError):
    """An actionable input validation error."""


def decimal_text(value):
    if value == 0:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_sum(values):
    if not values:
        return Decimal(0)
    low = min(value.as_tuple().exponent for value in values)
    high = max(value.adjusted() for value in values)
    with localcontext() as context:
        context.prec = max(28, high - low + 1 + len(str(len(values))))
        context.Emax = max(context.Emax, high + len(str(len(values))))
        context.Emin = min(context.Emin, low)
        return sum(values, Decimal(0))


def numeric(text, row, column):
    try:
        value = Decimal(text)
    except (InvalidOperation, ValueError):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {text!r}") from None
    if not value.is_finite():
        raise InputError(f"row {row}, column {column!r}: numeric value must be finite")
    return value


def analyze(args):
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
            if not headers or any(not header for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested.extend(column for column in (args.group_by, args.sum, args.avg) if column is not None)
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(column for column in (args.sum, args.avg) if column is not None))
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                else:
                    group = groups.setdefault(row[args.group_by], {column: [] for column in numeric_columns})
                    for column in numeric_columns:
                        group[column].append(numeric(row[column], row_number, column))
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None

    if args.group_by is None:
        return headers, rows
    output_headers = [args.group_by]
    if args.sum is not None:
        output_headers.append(f"sum_{args.sum}")
    if args.avg is not None:
        output_headers.append(f"avg_{args.avg}")
    if len(set(output_headers)) != len(output_headers):
        raise InputError("group column conflicts with an aggregate output column")
    results = []
    for key in sorted(groups):
        result = {args.group_by: key}
        totals = {column: exact_sum(values) for column, values in groups[key].items()}
        if args.sum is not None:
            result[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
        if args.avg is not None:
            total = totals[args.avg]
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits))
                context.Emax = max(context.Emax, total.adjusted())
                context.Emin = min(context.Emin, total.as_tuple().exponent)
                average = total / Decimal(len(groups[key][args.avg]))
            result[f"avg_{args.avg}"] = decimal_text(average)
        results.append(result)
    return output_headers, results


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
            print(json.dumps(rows, ensure_ascii=False))
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, ArithmeticError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

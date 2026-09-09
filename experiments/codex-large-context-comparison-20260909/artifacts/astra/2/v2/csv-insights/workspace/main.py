"""Dependency-free CSV filtering and grouped Decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """A user-facing input validation error."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Align all significant digits before adding, including a possible carry.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted()) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        return left + right


def number(cell, row, column):
    # Decimal accepts underscores and special values; neither is a numeric CSV cell.
    text = cell.strip()
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {cell!r}")
    try:
        value = Decimal(text)
        if not value.is_finite():
            raise InvalidOperation
        return value
    except InvalidOperation as exc:
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {cell!r}") from exc


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
            if not headers or any(not header.strip() for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested.extend(column for column in (args.group_by, args.sum, args.avg) if column is not None)
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            output_headers = headers
            if args.group_by is not None:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group and aggregate output column names collide")

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
                    continue
                key = row[args.group_by]
                totals, count = groups.get(key, ({column: Decimal(0) for column in numeric_columns}, 0))
                for column in numeric_columns:
                    totals[column] = exact_add(totals[column], number(row[column], row_number, column))
                groups[key] = totals, count + 1
        except csv.Error as exc:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc

    if args.group_by is not None:
        for key in sorted(groups):
            totals, count = groups[key]
            row = {args.group_by: key}
            if args.sum is not None:
                row[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
            if args.avg is not None:
                with localcontext() as context:
                    # Preserve large exact inputs; repeating quotients get at least 28 digits.
                    context.prec = max(28, len(totals[args.avg].as_tuple().digits) + len(str(count)))
                    average = totals[args.avg] / Decimal(count)
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
    except (InputError, OSError, UnicodeError, ArithmeticError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

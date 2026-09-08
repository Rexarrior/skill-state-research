"""Dependency-free CSV filtering and grouped decimal analytics."""
import argparse
import csv
import json
import re
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class InputError(ValueError):
    pass


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def add_exact(left, right):
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted(), 0) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        return left + right


def average(total, count):
    # Terminating averages retain every digit; recurring averages use at least
    # 28 significant digits with Decimal's default round-half-even rule.
    divisor = count
    twos = fives = 0
    while divisor % 2 == 0:
        divisor //= 2
        twos += 1
    while divisor % 5 == 0:
        divisor //= 5
        fives += 1
    with localcontext() as context:
        context.prec = max(28, len(total.as_tuple().digits) + max(twos, fives))
        return total / Decimal(count)


def parser():
    result = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    result.add_argument("input", metavar="INPUT.csv", type=Path)
    result.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    result.add_argument("--group-by", metavar="COLUMN")
    result.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    result.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    result.add_argument("--output", choices=("json", "csv"), default="json")
    return result


def analyze(args):
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise InputError("--sum and --avg require --group-by")
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}: expected COLUMN=VALUE")
        filters.append((column, value))

    with args.input.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers:
                raise InputError("input must contain a non-empty header")
            if any(not header.strip() for header in headers):
                raise InputError("headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("headers must be unique")
            referenced = [column for column, _ in filters]
            referenced += [column for column in (args.group_by, args.sum_column, args.avg_column) if column is not None]
            for column in referenced:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            output_headers = headers if args.group_by is None else [args.group_by]
            if args.sum_column is not None:
                output_headers.append(f"sum_{args.sum_column}")
            if args.avg_column is not None:
                output_headers.append(f"avg_{args.avg_column}")
            if len(set(output_headers)) != len(output_headers):
                raise InputError("group column conflicts with an aggregate output column")
            rows = []
            groups = {}
            numeric_columns = set(column for column in (args.sum_column, args.avg_column) if column is not None)
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
                    cell = row[column].strip()
                    try:
                        if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", cell):
                            raise InvalidOperation
                        number = Decimal(cell)
                        if not number.is_finite():
                            raise InvalidOperation
                        totals[column] = add_exact(totals[column], number)
                    except (InvalidOperation, OverflowError, ValueError) as exc:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}") from exc
                groups[key] = (totals, count + 1)
            if args.group_by is not None:
                for key in sorted(groups):
                    totals, count = groups[key]
                    result = {args.group_by: key}
                    if args.sum_column is not None:
                        result[f"sum_{args.sum_column}"] = decimal_text(totals[args.sum_column])
                    if args.avg_column is not None:
                        result[f"avg_{args.avg_column}"] = decimal_text(average(totals[args.avg_column], count))
                    rows.append(result)
            return output_headers, rows
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from exc


def main(argv=None):
    arguments = parser().parse_args(argv)
    try:
        headers, rows = analyze(arguments)
        if arguments.output == "json":
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

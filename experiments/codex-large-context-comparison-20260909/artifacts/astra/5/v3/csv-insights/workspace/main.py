"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, localcontext


class InputError(ValueError):
    """Invalid CSV contents or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Cover every place from the lowest exponent to the highest digit,
    # including a possible carry, rather than rounding sums at 28 digits.
    low = min(left.as_tuple().exponent, right.as_tuple().exponent)
    high = max(left.adjusted(), right.adjusted())
    with localcontext() as context:
        context.prec = max(28, high - low + 2)
        return left + right


def number(cell, row, column):
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", cell.strip()):
        raise InputError(f"row {row}, column {column!r}: invalid numeric cell {cell!r}")
    try:
        value = Decimal(cell.strip())
        if not value.is_finite():
            raise ValueError()
        return value
    except (DecimalException, ValueError) as exc:
        raise InputError(f"row {row}, column {column!r}: invalid numeric cell {cell!r}") from exc


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with open(args.input, encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        header = next(reader, None)
        if not header or any(not column for column in header):
            raise InputError("CSV headers must be non-empty")
        if len(set(header)) != len(header):
            raise InputError("CSV headers must be unique")
        requested = [column for column, _ in filters]
        requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
        for column in requested:
            if column not in header:
                raise InputError(f"unknown column {column!r}")
        columns = {column: index for index, column in enumerate(header)}
        numeric_columns = list(dict.fromkeys(column for column in (args.sum, args.avg) if column is not None))
        output_header = header if args.group_by is None else [args.group_by]
        if args.sum is not None:
            output_header += [f"sum_{args.sum}"]
        if args.avg is not None:
            output_header += [f"avg_{args.avg}"]
        if len(set(output_header)) != len(output_header):
            raise InputError("group column conflicts with generated aggregate column name")
        rows = []
        groups = {}
        for row_number, row in enumerate(reader, 2):
            if len(row) != len(header):
                raise InputError(f"row {row_number}: expected {len(header)} fields, got {len(row)}")
            if any(row[columns[column]] != value for column, value in filters):
                continue
            if args.group_by is None:
                rows.append(dict(zip(header, row)))
                continue
            key = row[columns[args.group_by]]
            count, totals = groups.setdefault(key, [0, {column: Decimal(0) for column in numeric_columns}])
            for column in numeric_columns:
                value = number(row[columns[column]], row_number, column)
                try:
                    totals[column] = exact_add(totals[column], value)
                except (DecimalException, ValueError, OverflowError) as exc:
                    raise InputError(f"row {row_number}, column {column!r}: numeric value exceeds supported decimal range") from exc
            groups[key][0] = count + 1
        for key in sorted(groups):
            count, totals = groups[key]
            result = {args.group_by: key}
            if args.sum is not None:
                result[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
            if args.avg is not None:
                with localcontext() as context:
                    context.prec = max(28, len(totals[args.avg].as_tuple().digits))
                    result[f"avg_{args.avg}"] = decimal_text(totals[args.avg] / Decimal(count))
            rows.append(result)
        return output_header, rows


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
        header, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, csv.Error, DecimalException) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

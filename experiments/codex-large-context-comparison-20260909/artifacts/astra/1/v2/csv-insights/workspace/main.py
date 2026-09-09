"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
from decimal import Decimal, DecimalException, localcontext
import json
import re
import sys


class InputError(ValueError):
    """Invalid CSV data or column selection."""


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_add(left, right):
    # Align both coefficients without rounding, including a possible carry.
    exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    precision = max(left.adjusted(), right.adjusted(), 0) - exponent + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = max(context.Emax, left.adjusted() + 2, right.adjusted() + 2)
        context.Emin = min(context.Emin, exponent)
        return left + right


def arguments(argv):
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
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            parser.error(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))
    args.filters = filters
    return args


def analyze(args):
    with open(args.input, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader, None)
            if not header or any(not name for name in header):
                raise InputError("CSV headers must be non-empty")
            if len(set(header)) != len(header):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in args.filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in header:
                    raise InputError(f"unknown column {column!r}")
            output_header = header if args.group_by is None else [args.group_by]
            metrics = [(prefix, column) for prefix, column in
                       (("sum", args.sum_column), ("avg", args.avg_column)) if column is not None]
            output_header = output_header + [f"{prefix}_{column}" for prefix, column in metrics]
            if len(set(output_header)) != len(output_header):
                raise InputError("group and aggregate output column names collide")
            rows = []
            groups = {}
            for row_number, values in enumerate(reader, start=2):
                if len(values) != len(header):
                    raise InputError(f"row {row_number}: expected {len(header)} fields, got {len(values)}")
                row = dict(zip(header, values))
                if not all(row[column] == value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                group = row[args.group_by]
                totals, count = groups.setdefault(group, ({}, 0))
                for column in dict.fromkeys(column for _, column in metrics):
                    raw = row[column].strip()
                    try:
                        if not NUMBER.fullmatch(raw):
                            raise ValueError("not a finite decimal")
                        value = Decimal(raw)
                        totals[column] = exact_add(totals.get(column, Decimal(0)), value)
                    except (ValueError, DecimalException, OverflowError) as exc:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}") from exc
                groups[group] = (totals, count + 1)
        except csv.Error as exc:
            raise InputError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc
    if args.group_by is not None:
        for group in sorted(groups):
            totals, count = groups[group]
            result = {args.group_by: group}
            for prefix, column in metrics:
                value = totals[column]
                if prefix == "avg":
                    with localcontext() as context:
                        context.prec = max(28, len(value.as_tuple().digits) + len(str(count)))
                        context.Emax = max(context.Emax, value.adjusted() + 2)
                        context.Emin = min(context.Emin, value.as_tuple().exponent - len(str(count)))
                        value = value / Decimal(count)
                result[f"{prefix}_{column}"] = decimal_text(value)
            rows.append(result)
    return output_header, rows


def main(argv=None):
    args = arguments(argv)
    try:
        header, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException, OverflowError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

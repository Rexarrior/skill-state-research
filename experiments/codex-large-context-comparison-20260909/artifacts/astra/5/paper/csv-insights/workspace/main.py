"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import decimal
import json
import sys
from pathlib import Path


class InputError(ValueError):
    """An invalid CSV document or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_sum(values):
    if not values:
        return decimal.Decimal(0)
    # Include all fractional places, integer places, and potential carry digits.
    low = min(v.as_tuple().exponent for v in values)
    high = max(v.adjusted() for v in values)
    with decimal.localcontext() as ctx:
        ctx.prec = max(28, high - low + len(str(len(values))) + 2)
        ctx.Emax = decimal.MAX_EMAX
        ctx.Emin = decimal.MIN_EMIN
        return sum(values, decimal.Decimal(0))


def average(total, count):
    # Preserve terminating averages exactly; recurring averages use at least
    # 28 significant digits, with extra precision for large input values.
    with decimal.localcontext() as ctx:
        ctx.prec = max(28, len(total.as_tuple().digits) + len(str(count)) + 2)
        ctx.Emax = decimal.MAX_EMAX
        ctx.Emin = decimal.MIN_EMIN
        return total / decimal.Decimal(count)


def read_results(args):
    filters = []
    for expression in args.where:
        if "=" not in expression or not expression.split("=", 1)[0]:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append(expression.split("=", 1))

    with Path(args.input).open("r", encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers:
                raise InputError("input must contain a header")
            if any(not name for name in headers):
                raise InputError("headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("headers must be unique")
            requested = [c for c, _ in filters]
            requested += [c for c in (args.group_by, args.sum, args.avg) if c is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            aggregating = args.sum is not None or args.avg is not None
            output_headers = [args.group_by] if aggregating else headers[:]
            if args.sum is not None:
                output_headers.append(f"sum_{args.sum}")
            if args.avg is not None:
                output_headers.append(f"avg_{args.avg}")
            if len(set(output_headers)) != len(output_headers):
                raise InputError("aggregation output column names collide")
            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(c for c in (args.sum, args.avg) if c is not None))
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(cells)}")
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if not aggregating:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {c: [] for c in numeric_columns})
                for column in numeric_columns:
                    try:
                        number = decimal.Decimal(row[column])
                        if not number.is_finite():
                            raise decimal.InvalidOperation
                    except decimal.InvalidOperation:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}") from None
                    group[column].append(number)
            if aggregating:
                for key in sorted(groups):
                    values = groups[key]
                    result = {args.group_by: key}
                    if args.sum is not None:
                        result[f"sum_{args.sum}"] = decimal_text(exact_sum(values[args.sum]))
                    if args.avg is not None:
                        numbers = values[args.avg]
                        result[f"avg_{args.avg}"] = decimal_text(average(exact_sum(numbers), len(numbers)))
                    rows.append(result)
            return output_headers, rows
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from None


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
        headers, rows = read_results(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, decimal.DecimalException) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

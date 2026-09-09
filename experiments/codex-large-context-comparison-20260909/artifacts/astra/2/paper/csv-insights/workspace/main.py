"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """An actionable error in the input file or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


class Total:
    """Accumulate Decimal coefficients exactly, independent of context precision."""

    def __init__(self):
        self.coefficient = 0
        self.exponent = 0
        self.count = 0

    def add(self, value):
        sign, digits, exponent = value.as_tuple()
        coefficient = 0
        for digit in digits:
            coefficient = coefficient * 10 + digit
        if sign:
            coefficient = -coefficient
        common = min(self.exponent, exponent)
        self.coefficient = (self.coefficient * 10 ** (self.exponent - common)
                            + coefficient * 10 ** (exponent - common))
        self.exponent = common
        self.count += 1

    def value(self):
        parts = Decimal(self.coefficient).as_tuple()
        return Decimal((parts.sign, parts.digits, self.exponent))

    def average(self):
        # Preserve terminating averages exactly; use 28 significant digits otherwise.
        divisor = self.count
        from math import gcd
        divisor //= gcd(abs(self.coefficient), divisor)
        twos = fives = 0
        while divisor % 2 == 0:
            divisor //= 2
            twos += 1
        while divisor % 5 == 0:
            divisor //= 5
            fives += 1
        precision = 28
        if divisor == 1:
            precision = max(28, len(Decimal(self.coefficient).as_tuple().digits)
                            + max(twos, fives) + 1)
        with localcontext() as context:
            context.prec = precision
            return self.value() / Decimal(self.count)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("input", metavar="INPUT.csv")
    result.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    result.add_argument("--group-by", metavar="COLUMN")
    result.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    result.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    result.add_argument("--output", choices=("json", "csv"), default="json")
    return result


def analyze(args):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}: expected COLUMN=VALUE")
        filters.append((column, value))
    aggregate = args.sum_column is not None or args.avg_column is not None
    if aggregate and args.group_by is None:
        raise InputError("--sum and --avg require --group-by")

    with open(args.input, encoding="utf-8", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(header == "" for header in headers):
                raise InputError("CSV headers must be non-empty")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested.extend(column for column in
                             (args.group_by, args.sum_column, args.avg_column)
                             if column is not None)
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column: {column!r}")
            metrics = [("sum", args.sum_column), ("avg", args.avg_column)]
            metrics = [(operation, column) for operation, column in metrics if column is not None]
            output_headers = ([args.group_by] + [f"{op}_{col}" for op, col in metrics]
                              if aggregate else headers)
            if len(set(output_headers)) != len(output_headers):
                raise InputError("aggregation output column names collide with the group column")
            rows = []
            groups = {}
            for row_number, values in enumerate(reader, start=2):
                if len(values) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(values)}")
                row = dict(zip(headers, values))
                if not all(row[column] == value for column, value in filters):
                    continue
                if not aggregate:
                    rows.append(row)
                    continue
                totals = groups.setdefault(row[args.group_by], {column: Total() for _, column in metrics})
                for column, total in totals.items():
                    cell = row[column]
                    try:
                        number = Decimal(cell)
                    except InvalidOperation:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}") from None
                    if not number.is_finite():
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {cell!r}")
                    total.add(number)
            if aggregate:
                for group in sorted(groups):
                    row = {args.group_by: group}
                    for operation, column in metrics:
                        total = groups[group][column]
                        value = total.value() if operation == "sum" else total.average()
                        row[f"{operation}_{column}"] = decimal_text(value)
                    rows.append(row)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
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

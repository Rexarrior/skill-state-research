"""Dependency-free CSV filtering and decimal aggregation CLI."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """An invalid input table or query."""


def decimal_text(value):
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def exact_sum(values):
    # Enough precision for aligned coefficients plus any carry from addition.
    lowest = min(value.as_tuple().exponent for value in values)
    highest = max(value.adjusted() for value in values)
    with localcontext() as context:
        context.prec = max(28, highest - lowest + 1 + len(str(len(values))))
        return sum(values, Decimal(0))


def analyze(args):
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        raise InputError("--sum and --avg require --group-by")
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
            requested.extend(column for column in (args.group_by, args.sum, args.avg)
                             if column is not None)
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            output_headers = headers if args.group_by is None else [args.group_by]
            metrics = [(operation, column) for operation, column in
                       (("sum", args.sum), ("avg", args.avg)) if column is not None]
            if args.group_by is not None:
                output_headers += [f"{operation}_{column}" for operation, column in metrics]
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("aggregate output column names collide with group column")
            rows = []
            groups = {}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if any(row[column] != value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                bucket = groups.setdefault(row[args.group_by], {column: [] for _, column in metrics})
                for column in bucket:
                    try:
                        number = Decimal(row[column])
                        if not number.is_finite():
                            raise InvalidOperation
                    except InvalidOperation:
                        raise InputError(f"row {row_number}, column {column!r}: invalid numeric value {row[column]!r}") from None
                    bucket[column].append(number)
            if args.group_by is not None:
                for group, bucket in sorted(groups.items()):
                    row = {args.group_by: group}
                    for operation, column in metrics:
                        total = exact_sum(bucket[column])
                        if operation == "avg":
                            with localcontext() as context:
                                context.prec = max(28, len(total.as_tuple().digits))
                                total = total / Decimal(len(bucket[column]))
                        row[f"{operation}_{column}"] = decimal_text(total)
                    rows.append(row)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f"malformed CSV near line {reader.line_num}: {error}") from None


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

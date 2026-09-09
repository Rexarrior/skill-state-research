#!/usr/bin/env python3
"""Dependency-free CSV filtering and decimal aggregation."""
import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    pass


def decimal_text(value):
    if not value:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def exact_sum(values):
    if not values:
        return Decimal(0)
    lowest = min(v.as_tuple().exponent for v in values)
    highest = max(v.adjusted() for v in values)
    with localcontext() as context:
        context.prec = max(28, highest - lowest + len(str(len(values))) + 2)
        return sum(values, Decimal(0))


def analyze(args):
    filters = []
    for expression in args.where:
        if '=' not in expression or not expression.split('=', 1)[0]:
            raise InputError(f'malformed filter {expression!r}; expected COLUMN=VALUE')
        filters.append(expression.split('=', 1))
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        raise InputError('--sum and --avg require --group-by')
    with open(args.input, encoding='utf-8', newline='') as source:
        reader = csv.reader(source, strict=True)
        headers = next(reader, None)
        if not headers or any(not header for header in headers):
            raise InputError('headers must be non-empty')
        if len(set(headers)) != len(headers):
            raise InputError('headers must be unique')
        requested = [column for column, _ in filters]
        requested += [c for c in (args.group_by, args.sum, args.avg) if c is not None]
        for column in requested:
            if column not in headers:
                raise InputError(f'unknown column: {column!r}')
        aggregated = args.sum is not None or args.avg is not None
        output_headers = headers
        if aggregated:
            output_headers = [args.group_by]
            if args.sum is not None:
                output_headers.append('sum_' + args.sum)
            if args.avg is not None:
                output_headers.append('avg_' + args.avg)
            if len(set(output_headers)) != len(output_headers):
                raise InputError('aggregation output column names collide')
        rows = []
        groups = {}
        for number, cells in enumerate(reader, start=2):
            if len(cells) != len(headers):
                raise InputError(f'row {number}: expected {len(headers)} fields, got {len(cells)}')
            row = dict(zip(headers, cells))
            if any(row[column] != value for column, value in filters):
                continue
            if not aggregated:
                rows.append(row)
                continue
            numeric = {}
            for column in dict.fromkeys(c for c in (args.sum, args.avg) if c is not None):
                try:
                    value = Decimal(row[column])
                    if not value.is_finite():
                        raise InvalidOperation
                except InvalidOperation:
                    raise InputError(f'row {number}, column {column!r}: invalid numeric value {row[column]!r}') from None
                numeric[column] = value
            group = groups.setdefault(row[args.group_by], {c: [] for c in numeric})
            for column, value in numeric.items():
                group[column].append(value)
        if aggregated:
            for key in sorted(groups):
                group = groups[key]
                row = {args.group_by: key}
                if args.sum is not None:
                    row['sum_' + args.sum] = decimal_text(exact_sum(group[args.sum]))
                if args.avg is not None:
                    values = group[args.avg]
                    total = exact_sum(values)
                    with localcontext() as context:
                        context.prec = max(28, len(total.as_tuple().digits) + len(str(len(values))) + 2)
                        row['avg_' + args.avg] = decimal_text(total / Decimal(len(values)))
                rows.append(row)
        return output_headers, rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('input', metavar='INPUT.csv')
    parser.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    parser.add_argument('--group-by', metavar='COLUMN')
    parser.add_argument('--sum', metavar='COLUMN')
    parser.add_argument('--avg', metavar='COLUMN')
    parser.add_argument('--output', choices=('json', 'csv'), default='json')
    args = parser.parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, csv.Error, ArithmeticError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Dependency-free CSV filtering and decimal aggregation."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, DecimalException, localcontext


class InputError(ValueError):
    """A useful input validation error."""


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', metavar='INPUT.csv')
    parser.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    parser.add_argument('--group-by', metavar='COLUMN')
    parser.add_argument('--sum', dest='sum_column', metavar='COLUMN')
    parser.add_argument('--avg', dest='avg_column', metavar='COLUMN')
    parser.add_argument('--output', choices=('json', 'csv'), default='json')
    args = parser.parse_args(argv)
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        parser.error('--sum and --avg require --group-by')
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition('=')
        if not separator or not column:
            parser.error(f'malformed filter {expression!r}; expected COLUMN=VALUE')
        filters.append((column, value))
    args.filters = filters
    return args


def numeric(value, row, column):
    # Decimal accepts underscores and special values; CSV numbers should not.
    if not re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', value.strip()):
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {value!r}')
    try:
        number = Decimal(value)
        if not number.is_finite():
            raise ValueError()
        return number
    except (DecimalException, ValueError):
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {value!r}') from None


def decimal_text(number):
    if not number:
        return '0'
    text = format(number, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def total(values):
    # Align every coefficient to the smallest exponent, with room for carry.
    exponent = min(value.as_tuple().exponent for value in values)
    precision = max(len(value.as_tuple().digits) + value.as_tuple().exponent - exponent
                    for value in values) + len(str(len(values))) + 1
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = max(context.Emax, max(value.adjusted() for value in values) + len(str(len(values))) + 1)
        context.Emin = min(context.Emin, exponent)
        return sum(values, Decimal(0)), context.prec


def analyze(args):
    with open(args.input, encoding='utf-8-sig', newline='') as source:
        reader = csv.reader(source, strict=True)
        try:
            header = next(reader, None)
            if not header or any(not name for name in header):
                raise InputError('CSV headers must be non-empty')
            if len(set(header)) != len(header):
                raise InputError('CSV headers must be unique')
            requested = [column for column, _ in args.filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in header:
                    raise InputError(f'unknown column {column!r}')
            output_header = header
            if args.group_by is not None:
                output_header = [args.group_by]
                if args.sum_column is not None:
                    output_header.append('sum_' + args.sum_column)
                if args.avg_column is not None:
                    output_header.append('avg_' + args.avg_column)
                if len(set(output_header)) != len(output_header):
                    raise InputError('group and aggregate output column names collide')
            rows = []
            groups = {}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(header):
                    raise InputError(f'row {row_number}: expected {len(header)} fields, got {len(fields)}')
                record = dict(zip(header, fields))
                if not all(record[column] == value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    rows.append(record)
                    continue
                bucket = groups.setdefault(record[args.group_by], {})
                for column in dict.fromkeys(c for c in (args.sum_column, args.avg_column) if c is not None):
                    bucket.setdefault(column, []).append(numeric(record[column], row_number, column))
            if args.group_by is not None:
                for group, bucket in sorted(groups.items()):
                    record = {args.group_by: group}
                    if args.sum_column is not None:
                        summed, _ = total(bucket[args.sum_column])
                        record['sum_' + args.sum_column] = decimal_text(summed)
                    if args.avg_column is not None:
                        values = bucket[args.avg_column]
                        summed, precision = total(values)
                        with localcontext() as context:
                            context.prec = precision
                            context.Emax = max(context.Emax, summed.adjusted() + 1)
                            context.Emin = min(context.Emin, summed.as_tuple().exponent - len(str(len(values))))
                            record['avg_' + args.avg_column] = decimal_text(summed / Decimal(len(values)))
                    rows.append(record)
            return output_header, rows
        except csv.Error as error:
            raise InputError(f'malformed CSV near line {reader.line_num}: {error}') from None


def main(argv=None):
    args = arguments(argv)
    try:
        header, rows = analyze(args)
        if args.output == 'json':
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException, OverflowError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

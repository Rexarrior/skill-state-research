#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, InvalidOperation, localcontext


class InputError(ValueError):
    """An invalid CSV input or query."""


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('input', metavar='INPUT.csv')
    parser.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    parser.add_argument('--group-by', metavar='COLUMN')
    parser.add_argument('--sum', dest='sum_column', metavar='COLUMN')
    parser.add_argument('--avg', dest='avg_column', metavar='COLUMN')
    parser.add_argument('--output', choices=('json', 'csv'), default='json')
    args = parser.parse_args(argv)
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        parser.error('--sum and --avg require --group-by')
    return args


def checked_lines(source):
    """Reject stray quotes that csv.reader otherwise accepts in unquoted fields."""
    state = 'start'
    for line_number, line in enumerate(source, 1):
        for char in line:
            if state == 'quoted':
                if char == '"':
                    state = 'closed'
            elif state == 'closed':
                if char == '"':
                    state = 'quoted'
                elif char == ',':
                    state = 'start'
                elif char in '\r\n':
                    state = 'start'
                else:
                    raise InputError(f'malformed CSV at line {line_number}: character after closing quote')
            elif char == '"':
                if state != 'start':
                    raise InputError(f'malformed CSV at line {line_number}: quote in unquoted field')
                state = 'quoted'
            elif char == ',' or char in '\r\n':
                state = 'start'
            else:
                state = 'unquoted'
        yield line
    if state == 'quoted':
        raise InputError('malformed CSV: unterminated quoted field')


def load(path):
    with open(path, encoding='utf-8-sig', newline='') as source:
        reader = csv.reader(checked_lines(source), strict=True)
        header = next(reader, None)
        if not header or any(name == '' for name in header):
            raise InputError('CSV headers must be non-empty')
        if len(set(header)) != len(header):
            raise InputError('CSV headers must be unique')
        rows = []
        for row_number, values in enumerate(reader, 2):
            if len(values) != len(header):
                raise InputError(f'row {row_number}: expected {len(header)} fields, got {len(values)}')
            rows.append((row_number, dict(zip(header, values))))
    return header, rows


NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')


def number(value, row, column):
    text = value.strip()
    if not NUMBER.fullmatch(text):
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {value!r}')
    try:
        result = Decimal(text)
        if not result.is_finite():
            raise InvalidOperation
        return result
    except InvalidOperation:
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {value!r}') from None


def decimal_text(value):
    if value == 0:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def aggregate(values, average=False):
    # Align all coefficients and allow enough carry digits for an exact sum.
    low = min(value.as_tuple().exponent for value in values)
    high = max(value.adjusted() for value in values)
    with localcontext() as context:
        context.prec = max(28, high - low + 1 + len(str(len(values))))
        context.Emax = max(context.Emax, high + len(str(len(values))))
        context.Emin = min(context.Emin, low)
        total = sum(values, Decimal(0))
        if average:
            total /= Decimal(len(values))
        return decimal_text(total)


def query(args, header, rows):
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition('=')
        if not separator or not column:
            raise InputError(f'malformed filter {expression!r}: expected COLUMN=VALUE')
        filters.append((column, value))
    columns = [column for column, _ in filters]
    columns += [column for column in (args.group_by, args.sum_column, args.avg_column) if column is not None]
    for column in columns:
        if column not in header:
            raise InputError(f'unknown column {column!r}')
    selected = [(index, row) for index, row in rows if all(row[column] == value for column, value in filters)]
    if args.sum_column is None and args.avg_column is None:
        return header, [row for _, row in selected]

    operations = [(prefix, column) for prefix, column in [('sum', args.sum_column), ('avg', args.avg_column)] if column is not None]
    output_header = [args.group_by] + [f'{prefix}_{column}' for prefix, column in operations]
    if len(set(output_header)) != len(output_header):
        raise InputError('group column conflicts with an aggregate output column')
    groups = {}
    for index, row in selected:
        group = groups.setdefault(row[args.group_by], {column: [] for _, column in operations})
        for column in group:
            group[column].append(number(row[column], index, column))
    result = []
    for key in sorted(groups):
        record = {args.group_by: key}
        for prefix, column in operations:
            record[f'{prefix}_{column}'] = aggregate(groups[key][column], average=prefix == 'avg')
        result.append(record)
    return output_header, result


def main(argv=None):
    args = arguments(argv)
    try:
        header, rows = load(args.input)
        output_header, result = query(args, header, rows)
        if args.output == 'json':
            print(json.dumps(result, ensure_ascii=False))
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=output_header, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(result)
    except (InputError, OSError, UnicodeError, csv.Error, InvalidOperation, OverflowError, ValueError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import io
import json
import re
import sys
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """An invalid CSV document or analytics request."""


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


def validate_quotes(text):
    """Reject misplaced quotes, which csv.reader(strict=True) can accept."""
    state = 'start'
    line = 1
    for char in text:
        if state == 'quoted':
            if char == '"':
                state = 'closed'
        elif state == 'closed':
            if char == '"':
                state = 'quoted'
            elif char == ',' or char in '\r\n':
                state = 'start'
            else:
                raise InputError(f'malformed CSV near line {line}: character after closing quote')
        elif char == '"':
            if state != 'start':
                raise InputError(f'malformed CSV near line {line}: quote in unquoted field')
            state = 'quoted'
        elif char == ',' or char in '\r\n':
            state = 'start'
        else:
            state = 'unquoted'
        if char == '\n':
            line += 1
    if state == 'quoted':
        raise InputError(f'malformed CSV near line {line}: unterminated quoted field')


def load(path):
    with open(path, encoding='utf-8-sig', newline='') as source:
        text = source.read()
    validate_quotes(text)
    reader = csv.reader(io.StringIO(text, newline=''), strict=True)
    try:
        headers = next(reader, None)
        if not headers or any(not header for header in headers):
            raise InputError('CSV headers must be non-empty')
        if len(set(headers)) != len(headers):
            raise InputError('CSV headers must be unique')
        rows = []
        for number, row in enumerate(reader, start=2):
            if len(row) != len(headers):
                raise InputError(f'row {number}: expected {len(headers)} fields, got {len(row)}')
            rows.append((number, dict(zip(headers, row))))
        return headers, rows
    except csv.Error as exc:
        raise InputError(f'malformed CSV near line {reader.line_num}: {exc}') from exc


NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')


def numeric(value, row, column):
    stripped = value.strip()
    try:
        if not NUMBER.fullmatch(stripped):
            raise ValueError('not a finite decimal')
        number = Decimal(stripped)
        if not number.is_finite():
            raise ValueError('not a finite decimal')
        return number
    except (ValueError, DecimalException) as exc:
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {value!r}') from exc


def plain(number):
    if number.is_zero():
        return '0'
    result = format(number, 'f')
    return result.rstrip('0').rstrip('.') if '.' in result else result


def aggregate(values, average=False):
    # Align every input coefficient before summing; leave room for carries.
    nonzero = [value for value in values if value]
    precision = 28
    if nonzero:
        precision = max(precision, max(v.adjusted() for v in nonzero)
                        - min(v.as_tuple().exponent for v in nonzero)
                        + len(str(len(values))) + 2)
    with localcontext() as context:
        context.prec = precision
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        total = sum(values, Decimal(0))
        if average:
            total /= Decimal(len(values))
        return plain(total)


def analyze(args):
    headers, rows = load(args.input)
    filters = []
    for item in args.where:
        column, separator, value = item.partition('=')
        if not separator or not column:
            raise InputError(f'malformed filter {item!r}; expected COLUMN=VALUE')
        filters.append((column, value))
    requested = [column for column, _ in filters]
    requested += [args.group_by, args.sum_column, args.avg_column]
    for column in requested:
        if column is not None and column not in headers:
            raise InputError(f'unknown column {column!r}')
    selected = [(number, row) for number, row in rows
                if all(row[column] == value for column, value in filters)]
    if args.group_by is None:
        return headers, [row for _, row in selected]

    metrics = [(f'sum_{args.sum_column}', args.sum_column, False)] if args.sum_column is not None else []
    if args.avg_column is not None:
        metrics.append((f'avg_{args.avg_column}', args.avg_column, True))
    output_headers = [args.group_by] + [name for name, _, _ in metrics]
    if len(set(output_headers)) != len(output_headers):
        raise InputError('group column conflicts with an aggregate output column name')
    groups = {}
    for number, row in selected:
        group = groups.setdefault(row[args.group_by], {column: [] for _, column, _ in metrics})
        for column in group:
            group[column].append(numeric(row[column], number, column))
    result = []
    for key in sorted(groups):
        row = {args.group_by: key}
        for name, column, average in metrics:
            row[name] = aggregate(groups[key][column], average)
        result.append(row)
    return output_headers, result


def main(argv=None):
    args = arguments(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            output = json.dumps(rows, ensure_ascii=False, indent=2) + '\n'
        else:
            buffer = io.StringIO(newline='')
            writer = csv.DictWriter(buffer, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
            output = buffer.getvalue()
        sys.stdout.write(output)
        return 0
    except (InputError, OSError, UnicodeError, DecimalException) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

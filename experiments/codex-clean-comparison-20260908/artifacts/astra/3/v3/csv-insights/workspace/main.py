#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped Decimal analytics."""
import argparse
import csv
import decimal
import json
import sys
from pathlib import Path


class InputError(ValueError):
    """An actionable input validation error."""


def parser():
    result = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    result.add_argument('input', type=Path, metavar='INPUT.csv')
    result.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    result.add_argument('--group-by', metavar='COLUMN')
    result.add_argument('--sum', dest='sum_column', metavar='COLUMN')
    result.add_argument('--avg', dest='avg_column', metavar='COLUMN')
    result.add_argument('--output', choices=('json', 'csv'), default='json')
    return result


def number(cell, row_number, column):
    try:
        value = decimal.Decimal(cell)
    except decimal.InvalidOperation:
        raise InputError(f'row {row_number}, column {column!r}: invalid numeric cell {cell!r}') from None
    if not value.is_finite():
        raise InputError(f'row {row_number}, column {column!r}: numeric cell must be finite, got {cell!r}')
    return value


def total(values):
    # Cover the full coefficient span, plus carry digits, without float conversion.
    nonzero = [value for value in values if value]
    if not nonzero:
        return decimal.Decimal(0)
    low = min(value.as_tuple().exponent for value in nonzero)
    high = max(value.adjusted() for value in nonzero)
    with decimal.localcontext() as context:
        context.prec = max(28, high - low + 1 + len(str(len(nonzero))))
        context.Emax = decimal.MAX_EMAX
        context.Emin = decimal.MIN_EMIN
        return sum(nonzero, decimal.Decimal(0))


def plain(value):
    if not value:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def analyze(args):
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise InputError('--sum and --avg require --group-by')
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition('=')
        if not separator or not column:
            raise InputError(f'malformed filter {expression!r}; expected COLUMN=VALUE')
        filters.append((column, value))

    with args.input.open('r', encoding='utf-8-sig', newline='') as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not column.strip() for column in headers):
                raise InputError('CSV headers must be non-empty')
            if len(headers) != len(set(headers)):
                raise InputError('CSV headers must be unique')
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f'unknown column {column!r}')
            aggregating = args.sum_column is not None or args.avg_column is not None
            output_headers = [args.group_by] if aggregating else headers
            if aggregating:
                output_headers += [f'{operation}_{column}' for operation, column in
                                   (('sum', args.sum_column), ('avg', args.avg_column)) if column is not None]
                if len(output_headers) != len(set(output_headers)):
                    raise InputError('group column conflicts with an aggregate output column')
            rows = []
            groups = {}
            numeric_columns = {column for column in (args.sum_column, args.avg_column) if column is not None}
            for row_number, cells in enumerate(reader, start=2):
                if len(cells) != len(headers):
                    raise InputError(f'row {row_number}: expected {len(headers)} fields, got {len(cells)}')
                row = dict(zip(headers, cells))
                if not all(row[column] == value for column, value in filters):
                    continue
                if not aggregating:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {column: [] for column in numeric_columns})
                for column in numeric_columns:
                    group[column].append(number(row[column], row_number, column))
            for key in sorted(groups):
                group = groups[key]
                row = {args.group_by: key}
                if args.sum_column is not None:
                    row[f'sum_{args.sum_column}'] = plain(total(group[args.sum_column]))
                if args.avg_column is not None:
                    values = group[args.avg_column]
                    summed = total(values)
                    with decimal.localcontext() as context:
                        context.prec = max(28, len(summed.as_tuple().digits))
                        context.Emax = decimal.MAX_EMAX
                        context.Emin = decimal.MIN_EMIN
                        average = summed / decimal.Decimal(len(values))
                    row[f'avg_{args.avg_column}'] = plain(average)
                rows.append(row)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f'malformed CSV near physical line {reader.line_num}: {error}') from None


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, decimal.DecimalException) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

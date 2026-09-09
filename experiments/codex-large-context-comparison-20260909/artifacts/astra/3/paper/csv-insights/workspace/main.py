#!/usr/bin/env python3
"""Dependency-free CSV filtering and grouped Decimal analytics."""
import argparse
import csv
import decimal
import io
import json
import sys
from pathlib import Path


class InputError(ValueError):
    pass


def plain(value):
    if not value:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def exact_add(left, right):
    # Align every coefficient digit, with one extra digit for a carry.
    low = min(left.as_tuple().exponent, right.as_tuple().exponent)
    high = max(left.adjusted(), right.adjusted())
    with decimal.localcontext() as ctx:
        ctx.prec = max(28, high - low + 2)
        ctx.Emax = decimal.MAX_EMAX
        ctx.Emin = decimal.MIN_EMIN
        return left + right


def number(text, row, column):
    try:
        result = decimal.Decimal(text)
        if not result.is_finite():
            raise decimal.InvalidOperation
        return result
    except decimal.InvalidOperation:
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {text!r}') from None


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('input', type=Path, metavar='INPUT.csv')
    cli.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    cli.add_argument('--group-by', metavar='COLUMN')
    cli.add_argument('--sum', dest='sum_column', metavar='COLUMN')
    cli.add_argument('--avg', dest='avg_column', metavar='COLUMN')
    cli.add_argument('--output', choices=('json', 'csv'), default='json')
    return cli


def analyze(args):
    filters = []
    for expression in args.where:
        column, sep, value = expression.partition('=')
        if not sep or not column:
            raise InputError(f'malformed filter {expression!r}; expected COLUMN=VALUE')
        filters.append((column, value))
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise InputError('--sum and --avg require --group-by')

    with args.input.open(encoding='utf-8', newline='') as stream:
        reader = csv.reader(stream, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise InputError('CSV headers must be non-empty')
            if len(set(headers)) != len(headers):
                raise InputError('CSV headers must be unique')
            requested = [column for column, _ in filters]
            requested += [c for c in (args.group_by, args.sum_column, args.avg_column) if c is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f'unknown column {column!r}')
            output_headers = headers if args.group_by is None else [args.group_by]
            if args.sum_column is not None:
                output_headers.append('sum_' + args.sum_column)
            if args.avg_column is not None:
                output_headers.append('avg_' + args.avg_column)
            if len(set(output_headers)) != len(output_headers):
                raise InputError('group and aggregate output column names collide')
            rows = []
            groups = {}
            numeric_columns = set(c for c in (args.sum_column, args.avg_column) if c is not None)
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f'row {row_number}: expected {len(headers)} fields, got {len(fields)}')
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                totals, count = groups.setdefault(row[args.group_by], ({c: decimal.Decimal(0) for c in numeric_columns}, 0))
                for column in numeric_columns:
                    totals[column] = exact_add(totals[column], number(row[column], row_number, column))
                groups[row[args.group_by]] = (totals, count + 1)
        except csv.Error as exc:
            raise InputError(f'malformed CSV near line {reader.line_num}: {exc}') from None

    if args.group_by is not None:
        for group, (totals, count) in sorted(groups.items()):
            row = {args.group_by: group}
            if args.sum_column is not None:
                row['sum_' + args.sum_column] = plain(totals[args.sum_column])
            if args.avg_column is not None:
                total = totals[args.avg_column]
                with decimal.localcontext() as ctx:
                    ctx.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                    ctx.Emax = decimal.MAX_EMAX
                    ctx.Emin = decimal.MIN_EMIN
                    row['avg_' + args.avg_column] = plain(total / decimal.Decimal(count))
            rows.append(row)
    return output_headers, rows


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            result = json.dumps(rows, ensure_ascii=False) + '\n'
        else:
            buffer = io.StringIO(newline='')
            writer = csv.DictWriter(buffer, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
            result = buffer.getvalue()
        sys.stdout.write(result)
    except (InputError, OSError, UnicodeError, decimal.DecimalException, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

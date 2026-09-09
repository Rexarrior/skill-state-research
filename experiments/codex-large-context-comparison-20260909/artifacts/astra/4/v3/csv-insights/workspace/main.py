"""Dependency-free CSV filtering and decimal aggregation."""
import argparse
import csv
import json
import re
import sys
from decimal import Decimal, localcontext


class InputError(ValueError):
    """Invalid CSV data or query."""


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('input', metavar='INPUT.csv')
    result.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    result.add_argument('--group-by', metavar='COLUMN')
    result.add_argument('--sum', dest='sum_column', metavar='COLUMN')
    result.add_argument('--avg', dest='avg_column', metavar='COLUMN')
    result.add_argument('--output', choices=('json', 'csv'), default='json')
    return result


def plain(value):
    if value.is_zero():
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def numeric(cell, row, column):
    # Accept finite decimal literals, including scientific notation.
    if not re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', cell.strip()):
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {cell!r}')
    try:
        value = Decimal(cell.strip())
    except Exception as exc:
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {cell!r}') from exc
    return value


def aggregate(values, average=False):
    # Allow enough precision to sum every coefficient exactly, including carries.
    low = min(value.as_tuple().exponent for value in values)
    high = max(value.adjusted() for value in values)
    with localcontext() as context:
        context.prec = max(28, high - low + 1 + len(str(len(values))))
        total = sum(values, Decimal(0))
        if average:
            total /= Decimal(len(values))
        return plain(total)


def query(args):
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise InputError('--sum and --avg require --group-by')
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition('=')
        if not separator or not column:
            raise InputError(f'malformed filter {expression!r}; expected COLUMN=VALUE')
        filters.append((column, value))
    with open(args.input, encoding='utf-8', newline='') as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header.strip() for header in headers):
                raise InputError('CSV headers must be non-empty')
            if len(set(headers)) != len(headers):
                raise InputError('CSV headers must be unique')
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f'unknown column {column!r}')
            rows = []
            groups = {}
            numeric_columns = list(dict.fromkeys(column for column in (args.sum_column, args.avg_column) if column is not None))
            for number, fields in enumerate(reader, 2):
                if len(fields) != len(headers):
                    raise InputError(f'row {number}: expected {len(headers)} fields, got {len(fields)}')
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                else:
                    group = groups.setdefault(row[args.group_by], {column: [] for column in numeric_columns})
                    for column in numeric_columns:
                        group[column].append(numeric(row[column], number, column))
        except csv.Error as exc:
            raise InputError(f'malformed CSV near line {reader.line_num}: {exc}') from exc
    if args.group_by is None:
        return headers, rows
    output_headers = [args.group_by]
    for prefix, column in (('sum_', args.sum_column), ('avg_', args.avg_column)):
        if column is not None:
            output_headers.append(prefix + column)
    if len(set(output_headers)) != len(output_headers):
        raise InputError('group column conflicts with generated aggregate column name')
    for key in sorted(groups):
        row = {args.group_by: key}
        if args.sum_column is not None:
            row['sum_' + args.sum_column] = aggregate(groups[key][args.sum_column])
        if args.avg_column is not None:
            row['avg_' + args.avg_column] = aggregate(groups[key][args.avg_column], average=True)
        rows.append(row)
    return output_headers, rows


def main(argv=None):
    argument_parser = parser()
    args = argument_parser.parse_args(argv)
    try:
        headers, rows = query(args)
        if args.output == 'json':
            sys.stdout.write(json.dumps(rows, ensure_ascii=False) + '\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, ArithmeticError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

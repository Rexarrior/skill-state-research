"""Dependency-free CSV filtering and grouped decimal analytics."""
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
    lowest = min(value.as_tuple().exponent for value in values)
    highest = max(value.adjusted() for value in values)
    with localcontext() as context:
        context.prec = max(28, highest - lowest + len(str(len(values))) + 2)
        context.Emax = max(context.Emax, highest + len(str(len(values))) + 2)
        context.Emin = min(context.Emin, lowest)
        return sum(values, Decimal(0))


def parse_args(argv=None):
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
    args.filters = []
    for condition in args.where:
        column, separator, value = condition.partition('=')
        if not separator or not column:
            parser.error(f'malformed filter {condition!r}; expected COLUMN=VALUE')
        args.filters.append((column, value))
    return args


def analyze(args):
    with open(args.input, encoding='utf-8-sig', newline='') as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise InputError('headers must be non-empty')
            if len(set(headers)) != len(headers):
                raise InputError('headers must be unique')
            requested = [column for column, _ in args.filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f'unknown column: {column!r}')
            output_headers = headers if args.group_by is None else [args.group_by]
            if args.group_by is not None:
                output_headers += [f'{operation}_{column}' for operation, column in
                                   [('sum', args.sum_column), ('avg', args.avg_column)] if column is not None]
                if len(set(output_headers)) != len(output_headers):
                    raise InputError('group column conflicts with an aggregate output column')
            rows = []
            groups = {}
            numeric_columns = set(column for column in (args.sum_column, args.avg_column) if column is not None)
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f'row {row_number}: expected {len(headers)} fields, got {len(fields)}')
                row = dict(zip(headers, fields))
                if any(row[column] != value for column, value in args.filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {column: [] for column in numeric_columns})
                for column in numeric_columns:
                    try:
                        value = Decimal(row[column])
                        if not value.is_finite():
                            raise InvalidOperation
                    except InvalidOperation:
                        raise InputError(f'row {row_number}, column {column!r}: invalid numeric value {row[column]!r}') from None
                    group[column].append(value)
            for key in sorted(groups):
                result = {args.group_by: key}
                for operation, column in [('sum', args.sum_column), ('avg', args.avg_column)]:
                    if column is None:
                        continue
                    values = groups[key][column]
                    value = exact_sum(values)
                    if operation == 'avg':
                        with localcontext() as context:
                            context.prec = max(28, len(value.as_tuple().digits) + len(str(len(values))))
                            context.Emax = max(context.Emax, value.adjusted() + 2)
                            context.Emin = min(context.Emin, value.as_tuple().exponent)
                            value /= Decimal(len(values))
                    result[f'{operation}_{column}'] = decimal_text(value)
                rows.append(result)
            return output_headers, rows
        except csv.Error as error:
            raise InputError(f'malformed CSV near line {reader.line_num}: {error}') from None


def main(argv=None):
    args = parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (OSError, UnicodeError, InputError, ArithmeticError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

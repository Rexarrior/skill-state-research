"""Dependency-free CSV filtering and grouped Decimal analytics."""
import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('input', metavar='INPUT.csv')
    result.add_argument('--where', action='append', default=[], metavar='COLUMN=VALUE')
    result.add_argument('--group-by', metavar='COLUMN')
    result.add_argument('--sum', dest='sum_column', metavar='COLUMN')
    result.add_argument('--avg', dest='avg_column', metavar='COLUMN')
    result.add_argument('--output', choices=('json', 'csv'), default='json')
    return result


def decimal_text(value):
    if not value:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def aggregate(values, average=False):
    # Align all coefficients and reserve carry digits to keep addition exact.
    exponent = min(value.as_tuple().exponent for value in values)
    digits = max(len(value.as_tuple().digits) + value.as_tuple().exponent - exponent
                 for value in values)
    with localcontext() as context:
        context.prec = max(28, digits + len(str(len(values))) + 2)
        total = sum(values, Decimal(0))
        if average:
            total /= Decimal(len(values))
        return decimal_text(total)


def analyze(args):
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise ValueError('--sum and --avg require --group-by')
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition('=')
        if not separator or not column:
            raise ValueError(f'malformed filter {expression!r}: expected COLUMN=VALUE')
        filters.append((column, value))

    with open(args.input, encoding='utf-8', newline='') as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header for header in headers):
                raise ValueError('headers must be non-empty')
            if len(set(headers)) != len(headers):
                raise ValueError('headers must be unique')
            required = [column for column, _ in filters]
            required.extend(column for column in (args.group_by, args.sum_column, args.avg_column)
                            if column is not None)
            for column in required:
                if column not in headers:
                    raise ValueError(f'unknown column {column!r}')
            numeric_columns = list(dict.fromkeys(column for column in
                                   (args.sum_column, args.avg_column) if column is not None))
            rows = []
            groups = {}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise ValueError(f'row {row_number}: expected {len(headers)} fields, got {len(fields)}')
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
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
                        raise ValueError(f'row {row_number}, column {column!r}: invalid numeric value {row[column]!r}') from None
                    group[column].append(value)
        except csv.Error as error:
            raise ValueError(f'malformed CSV near line {reader.line_num}: {error}') from None

    if args.group_by is None:
        return headers, rows
    output_headers = [args.group_by]
    operations = []
    for prefix, column in (('sum', args.sum_column), ('avg', args.avg_column)):
        if column is not None:
            name = f'{prefix}_{column}'
            if name in output_headers:
                raise ValueError(f'aggregate output column {name!r} conflicts with group column')
            output_headers.append(name)
            operations.append((name, column, prefix == 'avg'))
    for key in sorted(groups):
        row = {args.group_by: key}
        for name, column, average in operations:
            row[name] = aggregate(groups[key][column], average)
        rows.append(row)
    return output_headers, rows


def main(argv=None):
    argument_parser = parser()
    args = argument_parser.parse_args(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (OSError, UnicodeError, ValueError, ArithmeticError) as error:
        argument_parser.exit(2, f'error: {error}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""Dependency-free CSV filtering and grouped decimal analytics."""

import argparse
import csv
import json
import sys
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext


class InputError(ValueError):
    """An invalid input or query."""


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
    return args


def number(text, row, column):
    try:
        value = Decimal(text)
        if not value.is_finite():
            raise ValueError()
        return value
    except (DecimalException, ValueError):
        raise InputError(f'row {row}, column {column!r}: invalid numeric value {text!r}') from None


def exact_sum(values):
    # Enough precision to preserve all fractional places, integer places and carries.
    nonzero = [value for value in values if value]
    if not nonzero:
        return Decimal(0)
    lowest = min(value.as_tuple().exponent for value in nonzero)
    highest = max(value.adjusted() for value in nonzero)
    with localcontext() as context:
        context.prec = max(28, highest - lowest + 1 + len(str(len(nonzero))))
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return sum(nonzero, Decimal(0))


def decimal_text(value):
    if not value:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def analyze(args):
    with open(args.input, encoding='utf-8-sig', newline='') as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(header == '' for header in headers):
                raise InputError('CSV header must contain non-empty column names')
            if len(set(headers)) != len(headers):
                raise InputError('CSV header contains duplicate column names')
            filters = []
            for expression in args.where:
                column, separator, value = expression.partition('=')
                if not separator or not column:
                    raise InputError(f'malformed filter {expression!r}; expected COLUMN=VALUE')
                filters.append((column, value))
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum_column, args.avg_column)
                          if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f'unknown column {column!r}')
            numeric_columns = list(dict.fromkeys(column for column in
                                   (args.sum_column, args.avg_column) if column is not None))
            aggregate = bool(numeric_columns)
            output_headers = [args.group_by] if aggregate else headers
            if args.sum_column is not None:
                output_headers.append('sum_' + args.sum_column)
            if args.avg_column is not None:
                output_headers.append('avg_' + args.avg_column)
            if len(set(output_headers)) != len(output_headers):
                raise InputError('generated aggregate column conflicts with group column')
            rows = []
            groups = {}
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f'row {row_number}: expected {len(headers)} fields, got {len(fields)}')
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if not aggregate:
                    rows.append(row)
                    continue
                group = groups.setdefault(row[args.group_by], {column: [] for column in numeric_columns})
                for column in numeric_columns:
                    group[column].append(number(row[column], row_number, column))
        except csv.Error as exc:
            raise InputError(f'malformed CSV near line {reader.line_num}: {exc}') from None
    if aggregate:
        for key in sorted(groups):
            result = {args.group_by: key}
            totals = {column: exact_sum(values) for column, values in groups[key].items()}
            if args.sum_column is not None:
                result['sum_' + args.sum_column] = decimal_text(totals[args.sum_column])
            if args.avg_column is not None:
                total = totals[args.avg_column]
                count = len(groups[key][args.avg_column])
                with localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits) + len(str(count)))
                    context.Emax = MAX_EMAX
                    context.Emin = MIN_EMIN
                    average = total / Decimal(count)
                result['avg_' + args.avg_column] = decimal_text(average)
            rows.append(result)
    return output_headers, rows


def main(argv=None):
    args = arguments(argv)
    try:
        headers, rows = analyze(args)
        if args.output == 'json':
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, DecimalException) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

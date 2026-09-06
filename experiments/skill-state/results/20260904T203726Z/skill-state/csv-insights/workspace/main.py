#!/usr/bin/env python3
"""Filter and aggregate RFC-4180 CSV files."""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation


def fail(message):
    raise ValueError(message)


def parse_filter(value):
    if "=" not in value:
        fail("malformed filter {!r}; expected COLUMN=VALUE".format(value))
    column, expected = value.split("=", 1)
    if not column:
        fail("malformed filter {!r}; column name is empty".format(value))
    return column, expected


def read_csv(path):
    try:
        with open(path, "r", newline="", encoding="utf-8-sig") as source:
            rows = list(csv.reader(source))
    except (OSError, UnicodeError, csv.Error) as error:
        fail("cannot read CSV {!r}: {}".format(path, error))

    if not rows:
        fail("CSV input is empty")
    headers = rows[0]
    if not headers or any(not header for header in headers):
        fail("CSV headers must be non-empty")
    if len(set(headers)) != len(headers):
        fail("CSV headers must be unique")

    records = []
    for number, row in enumerate(rows[1:], start=2):
        if len(row) != len(headers):
            fail("row {} has {} fields; expected {}".format(number, len(row), len(headers)))
        records.append(dict(zip(headers, row)))
    return headers, records


def decimal_value(value, row_number, column):
    if not value:
        fail("row {}, column {!r}: numeric value is blank".format(row_number, column))
    try:
        result = Decimal(value)
    except InvalidOperation:
        fail("row {}, column {!r}: invalid numeric value {!r}".format(row_number, column, value))
    if not result.is_finite():
        fail("row {}, column {!r}: numeric value must be finite".format(row_number, column))
    return result


def format_decimal(value):
    value = value.normalize()
    if value == 0:
        return "0"
    return format(value, "f")


def process(headers, records, filters, group_by=None, sum_column=None, avg_column=None):
    requested = [column for column, _ in filters]
    requested += [column for column in (group_by, sum_column, avg_column) if column]
    for column in requested:
        if column not in headers:
            fail("unknown column {!r}".format(column))

    filtered = [record for record in records if all(record[column] == expected for column, expected in filters)]
    if not group_by:
        return headers, filtered

    groups = {}
    for row_number, record in enumerate(records, start=2):
        if not all(record[column] == expected for column, expected in filters):
            continue
        key = record[group_by]
        group = groups.setdefault(key, {"sum": Decimal(0), "avg_total": Decimal(0), "avg_count": 0})
        if sum_column:
            group["sum"] += decimal_value(record[sum_column], row_number, sum_column)
        if avg_column:
            group["avg_total"] += decimal_value(record[avg_column], row_number, avg_column)
            group["avg_count"] += 1

    output_headers = [group_by]
    if sum_column:
        output_headers.append("sum_" + sum_column)
    if avg_column:
        output_headers.append("avg_" + avg_column)
    output = []
    for key in sorted(groups):
        group = groups[key]
        row = {group_by: key}
        if sum_column:
            row["sum_" + sum_column] = format_decimal(group["sum"])
        if avg_column:
            row["avg_" + avg_column] = format_decimal(group["avg_total"] / group["avg_count"])
        output.append(row)
    return output_headers, output


def main(argv=None):
    parser = argparse.ArgumentParser(description="Filter and aggregate CSV files.")
    parser.add_argument("input", metavar="INPUT.csv", nargs="?")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    parser.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.self_test:
        import unittest

        class CSVInsightsTests(unittest.TestCase):
            def test_filters_and_decimal_aggregation(self):
                headers = ["team", "amount", "count"]
                records = [
                    {"team": "b", "amount": "1.20", "count": "2"},
                    {"team": "a", "amount": "2.30", "count": "4"},
                    {"team": "b", "amount": "3.40", "count": "6"},
                ]
                columns, rows = process(headers, records, [], "team", "amount", "count")
                self.assertEqual(columns, ["team", "sum_amount", "avg_count"])
                self.assertEqual(rows, [
                    {"team": "a", "sum_amount": "2.3", "avg_count": "4"},
                    {"team": "b", "sum_amount": "4.6", "avg_count": "4"},
                ])

            def test_rejects_invalid_numeric_value_with_original_row(self):
                with self.assertRaisesRegex(ValueError, "row 3, column 'amount'"):
                    process(
                        ["kind", "amount"],
                        [{"kind": "skip", "amount": "1"}, {"kind": "keep", "amount": "bad"}],
                        [("kind", "keep")], "kind", "amount"
                    )

        return 0 if unittest.TextTestRunner(verbosity=0).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(CSVInsightsTests)
        ).wasSuccessful() else 1

    if args.input is None:
        parser.error("the following arguments are required: INPUT.csv")
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    try:
        filters = [parse_filter(value) for value in args.where]
        headers, records = read_csv(args.input)
        output_headers, output = process(
            headers, records, filters, args.group_by, args.sum_column, args.avg_column
        )
    except ValueError as error:
        parser.error(str(error))

    if args.output == "json":
        json.dump(output, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=output_headers, lineterminator="\n")
        writer.writeheader()
        writer.writerows(output)


if __name__ == "__main__":
    main()

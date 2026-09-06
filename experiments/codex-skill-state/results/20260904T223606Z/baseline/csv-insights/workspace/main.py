#!/usr/bin/env python3
"""A small, dependency-free CSV filtering and aggregation command-line tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from typing import Iterable


class CsvInsightsError(Exception):
    """An expected input or command-line error."""


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Filter and aggregate an RFC-4180 CSV file.")
    parser.add_argument("input", metavar="INPUT.csv", help="CSV input file (is never modified)")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE",
                        help="Exact-match filter; may be supplied more than once")
    parser.add_argument("--group-by", metavar="COLUMN", help="Column used to form aggregate groups")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="Numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="Numeric column to average")
    parser.add_argument("--output", choices=("json", "csv"), default="json",
                        help="Output format (default: json)")
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        # newline='' is required by the csv module, particularly for embedded newlines.
        with open(path, "r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty; a header row is required")
            if not headers:
                raise CsvInsightsError("header row must contain at least one non-empty column")
            if any(header == "" for header in headers):
                raise CsvInsightsError("CSV headers must be non-empty")
            duplicates = sorted({header for header in headers if headers.count(header) > 1})
            if duplicates:
                raise CsvInsightsError("CSV headers must be unique (duplicate: %s)" % ", ".join(duplicates))

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append((record_number, row))
            return headers, rows
    except OSError as exc:
        raise CsvInsightsError(f"cannot read input file {path!r}: {exc.strerror or exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input file is not valid UTF-8: {exc}") from exc
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV: {exc}") from exc


def require_column(column: str, headers: list[str], option: str) -> None:
    if column not in headers:
        raise CsvInsightsError(f"unknown column for {option}: {column!r}")


def parse_filters(raw_filters: list[str], headers: list[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(f"malformed filter {raw_filter!r}; expected COLUMN=VALUE")
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(f"malformed filter {raw_filter!r}; column cannot be empty")
        require_column(column, headers, "--where")
        filters.append((column, value))
    return filters


def filter_rows(headers: list[str], rows: Iterable[tuple[int, list[str]]],
                filters: list[tuple[str, str]]) -> list[tuple[int, list[str]]]:
    positions = {header: index for index, header in enumerate(headers)}
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[positions[column]] == value for column, value in filters)
    ]


def decimal_cell(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"blank numeric value at row {record_number}, column {column!r}")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value {value!r} at row {record_number}, column {column!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value {value!r} at row {record_number}, column {column!r}"
        )
    return number


def decimal_text(number: Decimal) -> str:
    """Return a non-exponent, minimal representation without turning it into a float."""
    if number.is_zero():
        return "0"
    return format(number.normalize(), "f")


def aggregate(headers: list[str], rows: Iterable[tuple[int, list[str]]], group_by: str,
              sum_column: str | None, avg_column: str | None) -> tuple[list[str], list[dict[str, object]]]:
    positions = {header: index for index, header in enumerate(headers)}
    # OrderedDict makes calculation deterministic; results are explicitly sorted below.
    groups: OrderedDict[str, dict[str, object]] = OrderedDict()
    for record_number, row in rows:
        group = row[positions[group_by]]
        state = groups.setdefault(group, {"count": 0, "sum": Decimal(0), "avg": Decimal(0)})
        state["count"] = int(state["count"]) + 1
        if sum_column:
            state["sum"] = state["sum"] + decimal_cell(row[positions[sum_column]], record_number, sum_column)  # type: ignore[operator]
        if avg_column:
            state["avg"] = state["avg"] + decimal_cell(row[positions[avg_column]], record_number, avg_column)  # type: ignore[operator]

    output_headers = [group_by]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")
    output: list[dict[str, object]] = []
    for group in sorted(groups):
        state = groups[group]
        item: dict[str, object] = {group_by: group}
        if sum_column:
            item[f"sum_{sum_column}"] = state["sum"]
        if avg_column:
            item[f"avg_{avg_column}"] = state["avg"] / int(state["count"])  # type: ignore[operator]
        output.append(item)
    return output_headers, output


def write_json(rows: list[dict[str, object]], headers: list[str]) -> None:
    # json.dumps cannot preserve Decimal.  Serialize each Decimal as a JSON number
    # from its exact decimal spelling, never via a binary float.
    objects = []
    for row in rows:
        parts = []
        for header in headers:
            value = row[header]
            encoded = decimal_text(value) if isinstance(value, Decimal) else json.dumps(value, ensure_ascii=False)
            parts.append(f"{json.dumps(header, ensure_ascii=False)}:{encoded}")
        objects.append("{" + ",".join(parts) + "}")
    sys.stdout.write("[" + ",".join(objects) + "]\n")


def write_csv(rows: list[dict[str, object]], headers: list[str]) -> None:
    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(headers)
    for row in rows:
        writer.writerow([decimal_text(value) if isinstance(value, Decimal) else value for value in (row[h] for h in headers)])


def run(argv: list[str] | None = None) -> None:
    args = parse_arguments(argv)
    headers, source_rows = read_csv(args.input)
    filters = parse_filters(args.where, headers)
    for column, option in ((args.group_by, "--group-by"), (args.sum_column, "--sum"), (args.avg_column, "--avg")):
        if column:
            require_column(column, headers, option)
    selected_rows = filter_rows(headers, source_rows, filters)

    has_aggregation = args.sum_column is not None or args.avg_column is not None
    if has_aggregation:
        generated_columns = [args.group_by]
        if args.sum_column:
            generated_columns.append(f"sum_{args.sum_column}")
        if args.avg_column:
            generated_columns.append(f"avg_{args.avg_column}")
        if len(set(generated_columns)) != len(generated_columns):
            raise CsvInsightsError(
                "aggregation output columns would not be unique; choose a different --group-by column"
            )
        output_headers, output_rows = aggregate(
            headers, selected_rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [dict(zip(headers, row)) for _, row in selected_rows]

    if args.output == "json":
        write_json(output_rows, output_headers)
    else:
        write_csv(output_rows, output_headers)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

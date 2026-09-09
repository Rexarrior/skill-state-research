#!/usr/bin/env python3
"""CSV Insights: filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class CSVInsightsError(Exception):
    """An error that should be presented to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CSVInsightsError(message)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate CSV data.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    return parser


def parse_filters(values: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise CSVInsightsError(
                f"malformed filter {value!r}: expected COLUMN=VALUE"
            )
        column, expected = value.split("=", 1)
        if not column:
            raise CSVInsightsError(
                f"malformed filter {value!r}: column name must not be empty"
            )
        filters.append((column, expected))
    return filters


def validate_headers(headers: list[str] | None) -> list[str]:
    if headers is None:
        raise CSVInsightsError("input is empty: a header row is required")
    for index, header in enumerate(headers, start=1):
        if header == "":
            raise CSVInsightsError(f"header {index} is empty")
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CSVInsightsError(f"duplicate header name(s): {rendered}")
    return headers


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CSVInsightsError(f"unknown column: {column!r}")


def read_rows(stream: TextIO) -> tuple[list[str], list[tuple[int, list[str]]]]:
    reader = csv.reader(stream, strict=True)
    try:
        headers = validate_headers(next(reader, None))
        rows: list[tuple[int, list[str]]] = []
        for row in reader:
            record_number = reader.line_num
            if len(row) != len(headers):
                raise CSVInsightsError(
                    f"row ending at line {record_number} has {len(row)} field(s); "
                    f"expected {len(headers)}"
                )
            rows.append((record_number, row))
        return headers, rows
    except csv.Error as exc:
        raise CSVInsightsError(
            f"malformed CSV near line {reader.line_num}: {exc}"
        ) from exc


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def filtered_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(headers.index(column), expected) for column, expected in filters]
    return [
        (line, row)
        for line, row in rows
        if all(row[index] == expected for index, expected in indexes)
    ]


def aggregate(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = headers.index(group_by)
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    numeric_indexes = {column: headers.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, list[Decimal] | int]] = {}

    for line, row in rows:
        values: dict[str, Decimal] = {}
        for column, index in numeric_indexes.items():
            raw = row[index]
            try:
                value = Decimal(raw)
            except InvalidOperation as exc:
                raise CSVInsightsError(
                    f"invalid numeric value at row ending on line {line}, "
                    f"column {column!r}: {raw!r}"
                ) from exc
            if not value.is_finite():
                raise CSVInsightsError(
                    f"invalid numeric value at row ending on line {line}, "
                    f"column {column!r}: {raw!r}"
                )
            values[column] = value

        group = row[group_index]
        bucket = groups.setdefault(
            group,
            {"count": 0, "totals": [Decimal(0) for _ in numeric_columns]},
        )
        bucket["count"] = int(bucket["count"]) + 1
        totals = bucket["totals"]
        assert isinstance(totals, list)
        for index, column in enumerate(numeric_columns):
            totals[index] += values[column]

    output_headers = [
        group_by,
        *(f"sum_{column}" for column in sum_columns),
        *(f"avg_{column}" for column in avg_columns),
    ]
    results: list[dict[str, str]] = []
    positions = {column: index for index, column in enumerate(numeric_columns)}
    for group in sorted(groups):
        bucket = groups[group]
        totals = bucket["totals"]
        count = int(bucket["count"])
        assert isinstance(totals, list)
        result = {group_by: group}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(totals[positions[column]])
        for column in avg_columns:
            result[f"avg_{column}"] = decimal_string(
                totals[positions[column]] / Decimal(count)
            )
        results.append(result)
    return output_headers, results


def write_output(
    stream: TextIO, output_format: str, headers: Sequence[str], rows: Sequence[dict[str, str]]
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        return
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str], stdout: TextIO) -> None:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CSVInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        raise CSVInsightsError("--group-by requires --sum or --avg")

    try:
        with Path(args.input).open("r", encoding="utf-8", newline="") as stream:
            headers, rows = read_rows(stream)
    except (OSError, UnicodeError) as exc:
        raise CSVInsightsError(f"cannot read {args.input!r}: {exc}") from exc

    referenced = [column for column, _ in filters]
    if args.group_by:
        referenced.append(args.group_by)
    referenced.extend(args.sum_columns)
    referenced.extend(args.avg_columns)
    require_columns(headers, referenced)
    rows = filtered_rows(headers, rows, filters)

    if args.group_by:
        output_headers, output_rows = aggregate(
            headers, rows, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [dict(zip(headers, row)) for _, row in rows]
    write_output(stdout, args.output, output_headers, output_rows)


def main() -> int:
    try:
        run(sys.argv[1:], sys.stdout)
    except CSVInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

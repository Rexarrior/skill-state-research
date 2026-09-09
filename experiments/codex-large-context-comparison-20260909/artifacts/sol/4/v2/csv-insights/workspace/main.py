#!/usr/bin/env python3
"""Command-line analytics for RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="group rows by column")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}: column must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_columns(
    headers: Sequence[str],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> None:
    known = set(headers)
    requested = [column for column, _ in filters]
    if group_by is not None:
        requested.append(group_by)
    requested.extend(sum_columns)
    requested.extend(avg_columns)
    for column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")

    if len(set(sum_columns)) != len(sum_columns):
        raise CsvInsightsError("the same column cannot be passed to --sum more than once")
    if len(set(avg_columns)) != len(avg_columns):
        raise CsvInsightsError("the same column cannot be passed to --avg more than once")

    if group_by is not None:
        generated = [
            *(f"sum_{column}" for column in sum_columns),
            *(f"avg_{column}" for column in avg_columns),
        ]
        if group_by in generated:
            raise CsvInsightsError(
                f"output column {group_by!r} would be used both for the group "
                "and an aggregate"
            )


def read_csv(path: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        stream = Path(path).open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path!r}: {exc}") from exc

    try:
        with stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input is empty; a header row is required") from exc

            if not headers:
                raise CsvInsightsError("header row must contain at least one column")
            if any(header == "" for header in headers):
                raise CsvInsightsError("headers must be non-empty")
            if len(set(headers)) != len(headers):
                duplicates = sorted(
                    {header for header in headers if headers.count(header) > 1}
                )
                raise CsvInsightsError(
                    "headers must be unique; duplicate: " + ", ".join(map(repr, duplicates))
                )

            rows: list[tuple[int, dict[str, str]]] = []
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {row_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((row_number, dict(zip(headers, fields))))
            return headers, rows
    except csv.Error as exc:
        line = getattr(locals().get("reader"), "line_num", None)
        location = f" near line {line}" if line else ""
        raise CsvInsightsError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: numeric value is blank"
        )
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, object]] = {}

    # Extra precision keeps ordinary sums exact and makes non-terminating averages
    # deterministic without involving binary floating point.
    precision = max(28, sum(len(row[column]) for _, row in rows for column in numeric_columns) + 10)
    with localcontext() as context:
        context.prec = precision
        for row_number, row in rows:
            group = row[group_by]
            bucket = groups.setdefault(
                group,
                {"count": 0, "totals": {column: Decimal(0) for column in numeric_columns}},
            )
            bucket["count"] = int(bucket["count"]) + 1
            totals = bucket["totals"]
            assert isinstance(totals, dict)
            for column in numeric_columns:
                totals[column] += decimal_value(row[column], row_number, column)

        output_headers = [group_by]
        output_headers.extend(f"sum_{column}" for column in sum_columns)
        output_headers.extend(f"avg_{column}" for column in avg_columns)
        result: list[dict[str, str]] = []
        for group in sorted(groups):
            bucket = groups[group]
            totals = bucket["totals"]
            count = int(bucket["count"])
            assert isinstance(totals, dict)
            output_row = {group_by: group}
            for column in sum_columns:
                output_row[f"sum_{column}"] = format_decimal(totals[column])
            for column in avg_columns:
                output_row[f"avg_{column}"] = format_decimal(
                    totals[column] / Decimal(count)
                )
            result.append(output_row)
    return output_headers, result


def emit_json(rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    json.dump(rows, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO) -> None:
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace, stdout: TextIO) -> None:
    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(args.input)
    validate_columns(
        headers, filters, args.group_by, args.sum_columns, args.avg_columns
    )
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.group_by is not None:
        output_headers, rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(rows, stdout)
    else:
        emit_csv(output_headers, rows, stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

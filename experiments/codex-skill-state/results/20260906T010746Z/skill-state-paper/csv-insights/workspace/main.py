#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Iterable, TextIO


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter and aggregate a CSV file.",
        allow_abbrev=False,
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(raw_filters: Iterable[str]) -> list[tuple[str, str]]:
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file {str(path)!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header is required") from exc
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

            if not header:
                raise CsvInsightsError("CSV header must contain at least one column")
            empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "CSV headers must be non-empty; empty header at column "
                    + ", ".join(empty_positions)
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "CSV headers must be unique; duplicate header(s): "
                    + ", ".join(repr(name) for name in duplicates)
                )

            rows: list[tuple[int, list[str]]] = []
            record_number = 1
            try:
                for row in reader:
                    record_number += 1
                    if len(row) != len(header):
                        raise CsvInsightsError(
                            f"row {record_number} has {len(row)} field(s); "
                            f"expected {len(header)}"
                        )
                    rows.append((record_number, row))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near line {reader.line_num}: {exc}"
                ) from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input file is not valid UTF-8: {exc}") from exc

    return header, rows


def require_columns(header: list[str], columns: Iterable[str]) -> None:
    available = set(header)
    for column in columns:
        if column not in available:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank cell"
        )
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {text!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {text!r}"
        )
    return value


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def filtered_rows(
    header: list[str],
    rows: Iterable[tuple[int, list[str]]],
    filters: list[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), expected) for column, expected in filters]
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == expected for index, expected in indexes)
    ]


def aggregate(
    header: list[str],
    rows: Iterable[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    sum_index = header.index(sum_column) if sum_column is not None else None
    avg_index = header.index(avg_column) if avg_column is not None else None
    groups: dict[str, dict[str, Decimal | int]] = {}

    for row_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(
            group, {"sum": Decimal(0), "avg_total": Decimal(0), "count": 0}
        )
        if sum_column is not None and sum_index is not None:
            bucket["sum"] = bucket["sum"] + decimal_value(
                row[sum_index], row_number, sum_column
            )
        if avg_column is not None and avg_index is not None:
            bucket["avg_total"] = bucket["avg_total"] + decimal_value(
                row[avg_index], row_number, avg_column
            )
            bucket["count"] = bucket["count"] + 1

    output_header = [group_column]
    if sum_column is not None:
        output_header.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        bucket = groups[group]
        result = [group]
        if sum_column is not None:
            result.append(format_decimal(bucket["sum"]))
        if avg_column is not None:
            with localcontext() as context:
                context.prec = max(28, len(bucket["avg_total"].as_tuple().digits) + 28)
                average = bucket["avg_total"] / bucket["count"]
            result.append(format_decimal(average))
        output_rows.append(result)
    return output_header, output_rows


def write_output(
    output_format: str, header: list[str], rows: Iterable[list[str]], stream: TextIO
) -> None:
    if output_format == "csv":
        writer = csv.writer(stream, lineterminator="\r\n")
        writer.writerow(header)
        writer.writerows(rows)
        return
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def run(arguments: argparse.Namespace) -> None:
    if (arguments.sum_column or arguments.avg_column) and not arguments.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if arguments.group_by and not (arguments.sum_column or arguments.avg_column):
        raise CsvInsightsError("--group-by requires --sum and/or --avg")

    filters = parse_filters(arguments.where)
    header, rows = read_csv(Path(arguments.input))
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(
        column
        for column in (arguments.group_by, arguments.sum_column, arguments.avg_column)
        if column is not None
    )
    require_columns(header, requested_columns)
    selected = filtered_rows(header, rows, filters)

    if arguments.group_by:
        output_header, output_rows = aggregate(
            header,
            selected,
            arguments.group_by,
            arguments.sum_column,
            arguments.avg_column,
        )
    else:
        output_header = header
        output_rows = [row for _, row in selected]
    write_output(arguments.output, output_header, output_rows, sys.stdout)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        run(arguments)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

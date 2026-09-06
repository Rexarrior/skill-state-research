#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sys
from typing import NoReturn, Sequence, TextIO


class CsvInsightsError(Exception):
    """An error suitable for display to a command-line user."""


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="exact-match filter (repeatable; filters combine with AND)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        parser.error("--group-by requires at least one --sum or --avg")
    if len(args.sum_columns) != len(set(args.sum_columns)):
        parser.error("the same --sum column cannot be specified more than once")
    if len(args.avg_columns) != len(set(args.avg_columns)):
        parser.error("the same --avg column cannot be specified more than once")
    return args


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty (empty at column "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique (duplicate: "
                    + ", ".join(repr(name) for name in duplicates)
                    + ")"
                )

            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append(row)
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    unknown = list(dict.fromkeys(column for column in columns if column not in known))
    if unknown:
        noun = "column" if len(unknown) == 1 else "columns"
        raise CsvInsightsError(
            f"unknown {noun}: " + ", ".join(repr(column) for column in unknown)
        )


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def filtered_rows(
    header: Sequence[str], rows: Sequence[Sequence[str]], filters: Sequence[tuple[str, str]]
) -> list[Sequence[str]]:
    positions = [(header.index(column), value) for column, value in filters]
    return [row for row in rows if all(row[index] == value for index, value in positions)]


def aggregate(
    header: Sequence[str],
    rows: Sequence[Sequence[str]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[list[str]]]:
    group_index = header.index(group_column)
    metric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    metric_indexes = {column: header.index(column) for column in metric_columns}
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for record_number, row in enumerate(rows, start=2):
        values: dict[str, Decimal] = {}
        for column, index in metric_indexes.items():
            raw = row[index]
            try:
                value = Decimal(raw)
            except InvalidOperation:
                raise CsvInsightsError(
                    f"row {record_number}, column {column!r}: invalid numeric value {raw!r}"
                ) from None
            if not value.is_finite():
                raise CsvInsightsError(
                    f"row {record_number}, column {column!r}: invalid numeric value {raw!r}"
                )
            values[column] = value

        bucket = groups.setdefault(
            row[group_index], {column: [] for column in metric_columns}
        )
        for column, value in values.items():
            bucket[column].append(value)

    output_header = [group_column]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[list[str]] = []
    for group_value in sorted(groups):
        bucket = groups[group_value]
        output_row = [group_value]
        output_row.extend(decimal_string(sum(bucket[column], Decimal(0))) for column in sum_columns)
        output_row.extend(
            decimal_string(sum(bucket[column], Decimal(0)) / len(bucket[column]))
            for column in avg_columns
        )
        output_rows.append(output_row)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream)
    writer.writerow(header)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    header, rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    if args.group_by:
        requested_columns.append(args.group_by)
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    require_columns(header, requested_columns)

    selected = filtered_rows(header, rows, filters)
    if args.group_by:
        output_header, output_rows = aggregate(
            header, selected, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_header, output_rows = header, selected

    if args.output == "json":
        emit_json(output_header, output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path


class CSVInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CSVInsightsError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate an RFC-style CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="sum a numeric column (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="average a numeric column (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    return parser


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for expression in raw_filters:
        if "=" not in expression:
            raise CSVInsightsError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise CSVInsightsError(
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise CSVInsightsError("input has no header row")
    empty_positions = [str(index) for index, name in enumerate(header, start=1) if not name]
    if empty_positions:
        raise CSVInsightsError(
            "header names must be non-empty (empty column at position "
            + ", ".join(empty_positions)
            + ")"
        )
    duplicates = sorted({name for name in header if header.count(name) > 1})
    if duplicates:
        raise CSVInsightsError(
            "header names must be unique (duplicate: "
            + ", ".join(repr(name) for name in duplicates)
            + ")"
        )


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CSVInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CSVInsightsError("input is empty") from None
            validate_header(header)

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(header):
                    raise CSVInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, dict(zip(header, fields))))
            return header, rows
    except CSVInsightsError:
        raise
    except (OSError, UnicodeError) as exc:
        raise CSVInsightsError(f"cannot read {path}: {exc}") from exc
    except csv.Error as exc:
        line = reader.line_num if "reader" in locals() else "unknown"
        raise CSVInsightsError(f"malformed CSV near line {line}: {exc}") from exc


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CSVInsightsError(
            f"row {row_number}, column {column!r}: numeric value is blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CSVInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CSVInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_by: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        values = {
            column: parse_decimal(row[column], row_number, column)
            for column in numeric_columns
        }
        bucket = groups.setdefault(
            row[group_by], {column: [] for column in numeric_columns}
        )
        for column, value in values.items():
            bucket[column].append(value)

    output_header = [group_by]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    results: list[dict[str, str]] = []
    for group_value in sorted(groups):
        bucket = groups[group_value]
        result = {group_by: group_value}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(sum(bucket[column], Decimal(0)))
        for column in avg_columns:
            values = bucket[column]
            result[f"avg_{column}"] = decimal_string(
                sum(values, Decimal(0)) / Decimal(len(values))
            )
        results.append(result)
    return output_header, results


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=list(header),
        extrasaction="ignore",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if (args.sum_columns or args.avg_columns) and not args.group_by:
        raise CSVInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        raise CSVInsightsError("--group-by requires --sum or --avg")

    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    if args.group_by:
        requested_columns.append(args.group_by)
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    require_columns(header, requested_columns)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]
    if args.group_by:
        output_header, output_rows = aggregate(
            filtered,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_header = header
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_header, output_rows)
    return 0


def main() -> int:
    try:
        return run()
    except CSVInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

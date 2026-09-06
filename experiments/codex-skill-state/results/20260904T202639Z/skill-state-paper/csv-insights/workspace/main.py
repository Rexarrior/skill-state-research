#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """A user-facing input or processing error."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate an RFC-style CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by is not None and not (args.sum_columns or args.avg_columns):
        raise CsvInsightsError("--group-by requires at least one --sum or --avg")
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
                f"malformed filter {expression!r}; column must not be empty"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty")
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV near row 1: {exc}") from exc

            if not header:
                raise CsvInsightsError("input CSV has no header fields")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if name == ""]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty field at position(s) "
                    + ", ".join(empty_positions)
                )
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "header names must be unique; duplicate(s): "
                    + ", ".join(repr(name) for name in duplicates)
                )

            rows: list[tuple[int, dict[str, str]]] = []
            logical_row = 1
            while True:
                try:
                    values = next(reader)
                except StopIteration:
                    break
                except csv.Error as exc:
                    raise CsvInsightsError(
                        f"malformed CSV near row {logical_row + 1}: {exc}"
                    ) from exc
                logical_row += 1
                if len(values) != len(header):
                    raise CsvInsightsError(
                        f"row {logical_row} has {len(values)} fields; expected {len(header)}"
                    )
                rows.append((logical_row, dict(zip(header, values))))
            return header, rows
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc


def ensure_columns(header: Sequence[str], requested: Sequence[tuple[str, str]]) -> None:
    known = set(header)
    for option, column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r} for {option}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def format_decimal(number: Decimal) -> str:
    if number == 0:
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
    groups: dict[str, dict[str, object]] = {}

    for row_number, row in rows:
        group = row[group_by]
        state = groups.setdefault(
            group,
            {
                "sums": {column: Decimal(0) for column in numeric_columns},
                "counts": {column: 0 for column in numeric_columns},
            },
        )
        sums = state["sums"]
        counts = state["counts"]
        assert isinstance(sums, dict) and isinstance(counts, dict)
        for column in numeric_columns:
            value = decimal_value(row[column], row_number, column)
            sums[column] += value
            counts[column] += 1

    output_header = [group_by]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        sums = state["sums"]
        counts = state["counts"]
        assert isinstance(sums, dict) and isinstance(counts, dict)
        result = {group_by: group}
        for column in sum_columns:
            result[f"sum_{column}"] = format_decimal(sums[column])
        for column in avg_columns:
            result[f"avg_{column}"] = format_decimal(sums[column] / counts[column])
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: Sequence[dict[str, str]], output: TextIO) -> None:
    json.dump(rows, output, ensure_ascii=False, separators=(",", ":"))
    output.write("\n")


def emit_csv(
    header: Sequence[str], rows: Sequence[dict[str, str]], output: TextIO
) -> None:
    writer = csv.DictWriter(output, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(Path(args.input))

    requested = [("--where", column) for column, _ in filters]
    if args.group_by is not None:
        requested.append(("--group-by", args.group_by))
    requested.extend(("--sum", column) for column in args.sum_columns)
    requested.extend(("--avg", column) for column in args.avg_columns)
    ensure_columns(header, requested)

    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.group_by is None:
        output_header = header
        output_rows = [row for _, row in filtered]
    else:
        output_header, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )

    if args.output == "json":
        emit_json(output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

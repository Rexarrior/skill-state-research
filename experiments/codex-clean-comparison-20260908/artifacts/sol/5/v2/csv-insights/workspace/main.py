#!/usr/bin/env python3
"""CSV Insights: filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter and aggregate CSV data.",
        allow_abbrev=False,
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
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
    if len(set(args.sum_columns)) != len(args.sum_columns):
        raise CsvInsightsError("the same --sum column cannot be specified more than once")
    if len(set(args.avg_columns)) != len(args.avg_columns):
        raise CsvInsightsError("the same --avg column cannot be specified more than once")
    return args


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: expected COLUMN=VALUE"
            )
        column, value = raw_filter.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_header(header: list[str]) -> None:
    if not header:
        raise CsvInsightsError("input is empty; expected a header row")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "header names must not be empty (field " + ", ".join(empty_positions) + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique; duplicate: "
            + ", ".join(repr(name) for name in duplicates)
        )


def require_columns(header: Sequence[str], columns: Sequence[str]) -> None:
    known = set(header)
    unknown = list(dict.fromkeys(column for column in columns if column not in known))
    if unknown:
        raise CsvInsightsError(
            "unknown column" + ("s" if len(unknown) > 1 else "") + ": "
            + ", ".join(repr(column) for column in unknown)
        )


def read_filtered_rows(
    source: TextIO,
    filters: Sequence[tuple[str, str]],
) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    reader = csv.reader(source, strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise CsvInsightsError("input is empty; expected a header row") from None
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

    validate_header(header)
    filter_columns = [column for column, _ in filters]
    require_columns(header, filter_columns)
    rows: list[tuple[int, dict[str, str]]] = []
    record_number = 1
    try:
        for fields in reader:
            record_number += 1
            if len(fields) != len(header):
                raise CsvInsightsError(
                    f"row {record_number} has {len(fields)} fields; expected {len(header)}"
                )
            row = dict(zip(header, fields))
            if all(row[column] == value for column, value in filters):
                rows.append((record_number, row))
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near row {record_number + 1}: {exc}") from exc
    return header, rows


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: numeric value must be finite"
        )
    return number


def decimal_string(number: Decimal) -> str:
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        return "0"
    return text


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, object]] = {}

    for row_number, row in rows:
        group = row[group_column]
        state = groups.setdefault(
            group,
            {"count": 0, "totals": {column: Decimal(0) for column in numeric_columns}},
        )
        state["count"] = int(state["count"]) + 1
        totals = state["totals"]
        assert isinstance(totals, dict)
        for column in numeric_columns:
            totals[column] += decimal_value(row[column], row_number, column)

    output_header = [
        group_column,
        *(f"sum_{column}" for column in sum_columns),
        *(f"avg_{column}" for column in avg_columns),
    ]
    results: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        count = int(state["count"])
        totals = state["totals"]
        assert isinstance(totals, dict)
        result = {group_column: group}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(totals[column])
        for column in avg_columns:
            total = totals[column]
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits) + len(str(count)) + 10)
                result[f"avg_{column}"] = decimal_string(total / Decimal(count))
        results.append(result)
    return output_header, results


def emit(header: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=header,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str]) -> None:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    try:
        with args.input.open("r", encoding="utf-8", newline="") as source:
            header, numbered_rows = read_filtered_rows(source, filters)
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {args.input}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc

    requested_columns = [
        *([args.group_by] if args.group_by is not None else []),
        *args.sum_columns,
        *args.avg_columns,
    ]
    require_columns(header, requested_columns)

    if args.sum_columns or args.avg_columns:
        output_header, output_rows = aggregate(
            numbered_rows,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )
    else:
        output_header = header
        output_rows = [row for _, row in numbered_rows]
    emit(output_header, output_rows, args.output)


def main() -> int:
    try:
        run(sys.argv[1:])
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

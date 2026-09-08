#!/usr/bin/env python3
"""CSV Insights: small, dependency-free command-line CSV analytics."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, DecimalException, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that should be shown to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    """Argument parser whose errors can be handled consistently."""

    def error(self, message: str) -> None:
        raise CsvInsightsError(f"invalid arguments: {message}")


def build_parser() -> argparse.ArgumentParser:
    parser = ArgumentParser(
        description="Filter and aggregate an RFC-style CSV file.",
        allow_abbrev=False,
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="sum a numeric column (repeatable)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="average a numeric column (repeatable)",
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
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise CsvInsightsError(
                f"malformed filter {expression!r}; expected COLUMN=VALUE"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index) for index, name in enumerate(headers, start=1) if not name]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty "
            f"(empty field at position {', '.join(empty_positions)})"
        )
    duplicates = sorted({name for name in headers if headers.count(name) > 1})
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique; duplicate "
            + ", ".join(repr(name) for name in duplicates)
        )


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input has no header row") from None
            validate_headers(headers)

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
            return headers, rows
    except csv.Error as exc:
        # line_num is the physical line on which the parser noticed the error.
        line = getattr(reader, "line_num", 0)
        location = f" near line {line}" if line else ""
        raise CsvInsightsError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def check_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    known = set(headers)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column {column!r}")


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except DecimalException as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals without silently rounding at the default precision."""
    if not values:
        return Decimal(0)
    highest_place = max(value.adjusted() for value in values)
    lowest_place = min(value.as_tuple().exponent for value in values)
    precision = max(28, highest_place - lowest_place + len(str(len(values))) + 2)
    try:
        with localcontext() as context:
            context.prec = precision
            return sum(values, Decimal(0))
    except (DecimalException, ValueError, OverflowError) as exc:
        raise CsvInsightsError("numeric values are too large to aggregate") from exc


def decimal_string(value: Decimal) -> str:
    """Render a finite Decimal in fixed notation with no insignificant zeroes."""
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in ("-0", ""):
        return "0"
    return rendered


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
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
        group = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column, number in values.items():
            group[column].append(number)

    output_headers = [group_column]
    output_headers.extend(f"sum_{column}" for column in sum_columns)
    output_headers.extend(f"avg_{column}" for column in avg_columns)
    output_rows: list[dict[str, str]] = []

    for group_value in sorted(groups):
        values = groups[group_value]
        result = {group_column: group_value}
        sums = {column: exact_sum(values[column]) for column in numeric_columns}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(sums[column])
        for column in avg_columns:
            try:
                with localcontext() as context:
                    # Preserve large integer portions; repeating results use at
                    # least Decimal's standard 28 significant digits.
                    context.prec = max(28, len(sums[column].as_tuple().digits))
                    average = sums[column] / len(values[column])
            except DecimalException as exc:
                raise CsvInsightsError(
                    f"could not average column {column!r}"
                ) from exc
            result[f"avg_{column}"] = decimal_string(average)
        output_rows.append(result)

    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]], output: TextIO) -> None:
    json.dump(rows, output, ensure_ascii=False)
    output.write("\n")


def emit_csv(
    headers: Sequence[str], rows: Sequence[dict[str, str]], output: TextIO
) -> None:
    writer = csv.DictWriter(output, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str], stdout: TextIO) -> None:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)
    aggregating = bool(args.sum_columns or args.avg_columns)
    if aggregating and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not aggregating:
        raise CsvInsightsError("--group-by requires --sum or --avg")
    if len(args.sum_columns) != len(set(args.sum_columns)):
        raise CsvInsightsError("the same --sum column cannot be specified more than once")
    if len(args.avg_columns) != len(set(args.avg_columns)):
        raise CsvInsightsError("the same --avg column cannot be specified more than once")
    if aggregating:
        derived_columns = [
            *(f"sum_{column}" for column in args.sum_columns),
            *(f"avg_{column}" for column in args.avg_columns),
        ]
        if args.group_by in derived_columns:
            raise CsvInsightsError(
                f"derived aggregate column conflicts with group column {args.group_by!r}"
            )
        if len(derived_columns) != len(set(derived_columns)):
            raise CsvInsightsError("aggregate output column names must be unique")

    headers, numbered_rows = read_csv(Path(args.input))
    requested_columns = [column for column, _ in filters]
    requested_columns.extend(args.sum_columns)
    requested_columns.extend(args.avg_columns)
    if args.group_by:
        requested_columns.append(args.group_by)
    check_columns(headers, requested_columns)

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if aggregating:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows, stdout)
    else:
        emit_csv(output_headers, output_rows, stdout)


def main() -> int:
    try:
        run(sys.argv[1:], sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

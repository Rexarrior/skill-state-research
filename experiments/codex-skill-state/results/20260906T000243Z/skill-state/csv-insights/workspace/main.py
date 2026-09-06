#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation tool."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument(
        "--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    return args


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
                f"malformed filter {expression!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def require_columns(headers: Sequence[str], requested: Sequence[str]) -> None:
    known = set(headers)
    for column in requested:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        handle = path.open("r", encoding="utf-8-sig", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file {str(path)!r}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header row is required") from exc

            if not headers:
                raise CsvInsightsError("header row must contain at least one column")
            empty_positions = [str(index) for index, name in enumerate(headers, start=1) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty (empty column position(s): "
                    + ", ".join(empty_positions)
                    + ")"
                )
            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                rendered = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"header names must be unique; duplicate(s): {rendered}")

            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
            return list(headers), rows
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near physical line {reader.line_num}: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read input file {str(path)!r}: {exc}") from exc


def decimal_value(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {record_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: numeric value must be finite, got {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    if number.is_zero():
        return "0"

    parts = number.as_tuple()
    digits = "".join(str(digit) for digit in parts.digits)
    exponent = parts.exponent

    if exponent >= 0:
        rendered = digits + ("0" * exponent)
    else:
        decimal_position = len(digits) + exponent
        if decimal_position <= 0:
            rendered = "0." + ("0" * -decimal_position) + digits
        else:
            rendered = digits[:decimal_position] + "." + digits[decimal_position:]
        rendered = rendered.rstrip("0").rstrip(".")

    return ("-" if parts.sign else "") + rendered


def decimal_add_exact(left: Decimal, right: Decimal) -> Decimal:
    """Add finite decimals without rounding under the process-wide context."""
    left_tuple = left.as_tuple()
    right_tuple = right.as_tuple()
    common_exponent = min(left_tuple.exponent, right_tuple.exponent)
    left_width = len(left_tuple.digits) + left_tuple.exponent - common_exponent
    right_width = len(right_tuple.digits) + right_tuple.exponent - common_exponent
    with localcontext() as context:
        # One extra digit accommodates a carry from the most significant place.
        context.prec = max(left_width, right_width) + 1
        return left + right


def filter_rows(
    headers: Sequence[str], rows: Sequence[list[str]], filters: Sequence[tuple[str, str]]
) -> list[tuple[int, list[str]]]:
    positions = [(headers.index(column), value) for column, value in filters]
    return [
        (record_number, row)
        for record_number, row in enumerate(rows, start=2)
        if all(row[index] == value for index, value in positions)
    ]


def aggregate(
    headers: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(group_column)
    sum_index = headers.index(sum_column) if sum_column else None
    avg_index = headers.index(avg_column) if avg_column else None
    groups: dict[str, dict[str, Decimal | int]] = {}

    for record_number, row in rows:
        group = row[group_index]
        values = groups.setdefault(
            group, {"sum": Decimal(0), "avg_sum": Decimal(0), "avg_count": 0}
        )
        if sum_column is not None and sum_index is not None:
            values["sum"] = decimal_add_exact(values["sum"], decimal_value(
                row[sum_index], record_number, sum_column
            ))
        if avg_column is not None and avg_index is not None:
            values["avg_sum"] = decimal_add_exact(values["avg_sum"], decimal_value(
                row[avg_index], record_number, avg_column
            ))
            values["avg_count"] = values["avg_count"] + 1

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        values = groups[group]
        output_row = [group]
        if sum_column:
            output_row.append(decimal_string(values["sum"]))
        if avg_column:
            avg_sum = values["avg_sum"]
            avg_count = values["avg_count"]
            with localcontext() as context:
                digit_count = len(avg_sum.as_tuple().digits)
                context.prec = max(28, digit_count + len(str(avg_count)) + 10)
                average = avg_sum / Decimal(avg_count)
            output_row.append(decimal_string(average))
        output_rows.append(output_row)
    return output_headers, output_rows


def emit_json(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    result = [dict(zip(headers, row)) for row in rows]
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    writer = csv.writer(sys.stdout, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    headers, rows = read_csv(Path(args.input))
    requested = [column for column, _ in filters]
    requested.extend(
        column for column in (args.group_by, args.sum_column, args.avg_column) if column
    )
    require_columns(headers, requested)
    selected = filter_rows(headers, rows, filters)

    if args.sum_column or args.avg_column:
        output_headers, output_rows = aggregate(
            headers, selected, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in selected]

    if args.output == "json":
        emit_json(output_headers, output_rows)
    else:
        emit_csv(output_headers, output_rows)
    return 0


def main() -> int:
    try:
        return run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

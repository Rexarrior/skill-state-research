#!/usr/bin/env python3
"""Command-line filtering and aggregation for CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import sys
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals the value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group results")
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to sum (repeatable)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="numeric column to average (repeatable)",
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


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input is empty; a header row is required")
    for position, header in enumerate(headers, start=1):
        if header == "":
            raise CsvInsightsError(f"header column {position} is empty")
    seen: set[str] = set()
    for header in headers:
        if header in seen:
            raise CsvInsightsError(f"duplicate header {header!r}")
        seen.add(header)


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty; a header row is required")
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
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        line = getattr(reader, "line_num", None)
        location = f" near physical line {line}" if line else ""
        raise CsvInsightsError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def require_columns(headers: Sequence[str], columns: Sequence[str]) -> None:
    available = set(headers)
    for column in columns:
        if column not in available:
            raise CsvInsightsError(f"unknown column {column!r}")


def parse_number(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {record_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {record_number}, "
            f"column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {record_number}, "
            f"column {column!r}: {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add two finite Decimals without rounding in the ambient context."""
    lowest_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    highest_position = max(left.adjusted(), right.adjusted())
    precision = max(1, highest_position - lowest_exponent + 2)
    with localcontext() as context:
        context.prec = precision
        return left + right


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    groups: dict[str, dict[str, tuple[Decimal, int]]] = {}

    for record_number, row in rows:
        values = {
            column: parse_number(row[column], record_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(row[group_column], {})
        for column, value in values.items():
            total, count = group.get(column, (Decimal(0), 0))
            group[column] = (exact_add(total, value), count + 1)

    output_headers = [
        group_column,
        *(f"sum_{column}" for column in sum_columns),
        *(f"avg_{column}" for column in avg_columns),
    ]
    if len(output_headers) != len(set(output_headers)):
        raise CsvInsightsError(
            "aggregate output column names collide; choose a different group column"
        )
    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        accumulators = groups[group_value]
        result = {group_column: group_value}
        for column in sum_columns:
            total, _ = accumulators[column]
            result[f"sum_{column}"] = decimal_string(total)
        for column in avg_columns:
            total, count = accumulators[column]
            result[f"avg_{column}"] = decimal_string(total / Decimal(count))
        output_rows.append(result)
    return output_headers, output_rows


def write_output(
    headers: Sequence[str], rows: Sequence[dict[str, str]], output: str, stream: TextIO
) -> None:
    if output == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="raise")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None, stdout: TextIO = sys.stdout) -> None:
    args = build_parser().parse_args(argv)
    filters = parse_filters(args.where)
    aggregation_requested = bool(args.sum_columns or args.avg_columns)

    if aggregation_requested and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not aggregation_requested:
        raise CsvInsightsError("--group-by requires --sum or --avg")
    if len(args.sum_columns) != len(set(args.sum_columns)):
        raise CsvInsightsError("the same --sum column cannot be specified more than once")
    if len(args.avg_columns) != len(set(args.avg_columns)):
        raise CsvInsightsError("the same --avg column cannot be specified more than once")

    headers, numbered_rows = read_csv(Path(args.input))
    referenced = [column for column, _ in filters]
    if args.group_by:
        referenced.append(args.group_by)
    referenced.extend(args.sum_columns)
    referenced.extend(args.avg_columns)
    require_columns(headers, referenced)

    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if aggregation_requested:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]
    write_output(output_headers, output_rows, args.output, stdout)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

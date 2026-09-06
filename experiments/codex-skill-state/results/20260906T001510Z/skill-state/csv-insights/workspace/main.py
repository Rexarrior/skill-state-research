#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Sequence, TextIO


class CsvInsightsError(Exception):
    """An input or usage error that should be shown without a traceback."""


def parse_arguments(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
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
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum and/or --avg")
    return args


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw_filter in raw_filters:
        column, separator, value = raw_filter.partition("=")
        if not separator or not column:
            raise CsvInsightsError(
                f"malformed filter {raw_filter!r}; expected COLUMN=VALUE"
            )
        filters.append((column, value))
    return filters


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None

            if not header or any(name == "" for name in header):
                raise CsvInsightsError("CSV headers must be non-empty")
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise CsvInsightsError(
                    "CSV headers must be unique; duplicate: "
                    + ", ".join(repr(name) for name in duplicates)
                )

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, dict(zip(header, fields))))
            return header, rows
    except CsvInsightsError:
        raise
    except (OSError, UnicodeError, csv.Error) as error:
        raise CsvInsightsError(f"cannot read {path}: {error}") from error


def require_columns(header: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def decimal_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    """Return fixed-point Decimal text without insignificant trailing zeroes."""
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals without the default context rounding long inputs."""
    if not values:
        return Decimal(0)
    lowest_exponent = min(value.as_tuple().exponent for value in values)
    highest_adjusted = max(value.adjusted() for value in values)
    integer_places = max(1, highest_adjusted - lowest_exponent + 1)
    carry_places = len(str(len(values)))
    with localcontext() as context:
        context.prec = max(28, integer_places + carry_places)
        return sum(values, Decimal(0))


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        values = {
            column: decimal_cell(row[column], row_number, column)
            for column in numeric_columns
        }
        bucket = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column, value in values.items():
            bucket[column].append(value)

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        result = {group_column: group_value}
        bucket = groups[group_value]
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(exact_sum(bucket[sum_column]))
        if avg_column:
            values = bucket[avg_column]
            total = exact_sum(values)
            # Division may repeat, so retain ample deterministic precision beyond the
            # exact total while avoiding binary floating-point arithmetic entirely.
            precision = max(28, len(total.as_tuple().digits) + len(str(len(values))) + 10)
            with localcontext() as context:
                context.prec = precision
                average = total / Decimal(len(values))
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: Sequence[dict[str, str]], output: TextIO) -> None:
    json.dump(rows, output, ensure_ascii=False, separators=(",", ":"))
    output.write("\n")


def emit_csv(
    header: Sequence[str], rows: Sequence[dict[str, str]], output: TextIO
) -> None:
    writer = csv.DictWriter(output, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None, output: TextIO = sys.stdout) -> None:
    args = parse_arguments(argv)
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.group_by:
        output_header, rows = aggregate(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = header
        rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(rows, output)
    else:
        emit_csv(output_header, rows, output)


def main() -> int:
    try:
        run()
    except CsvInsightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

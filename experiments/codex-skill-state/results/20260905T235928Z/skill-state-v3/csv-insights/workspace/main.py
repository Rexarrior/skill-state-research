#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An input or usage error suitable for displaying to the user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
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
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format (default: json)"
    )
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        parser.error("--group-by requires --sum or --avg")
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


def validate_header(header: list[str] | None) -> list[str]:
    if header is None:
        raise CsvInsightsError("input is empty; expected a header row")
    empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "header names must not be empty (field position(s): "
            + ", ".join(empty_positions)
            + ")"
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in header:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique; duplicate(s): "
            + ", ".join(repr(name) for name in duplicates)
        )
    return header


def require_columns(header: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    unknown: list[str] = []
    for column in columns:
        if column is not None and column not in known and column not in unknown:
            unknown.append(column)
    if unknown:
        raise CsvInsightsError(
            "unknown column(s): " + ", ".join(repr(column) for column in unknown)
        )


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        file = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file {str(path)!r}: {exc}") from exc

    try:
        with file:
            reader = csv.reader(file, strict=True)
            try:
                header = validate_header(next(reader, None))
                rows: list[tuple[int, dict[str, str]]] = []
                for record_number, fields in enumerate(reader, start=2):
                    if len(fields) != len(header):
                        raise CsvInsightsError(
                            f"row {record_number} has {len(fields)} field(s); "
                            f"expected {len(header)}"
                        )
                    rows.append((record_number, dict(zip(header, fields))))
                return header, rows
            except csv.Error as exc:
                line_number = reader.line_num or 1
                raise CsvInsightsError(
                    f"malformed CSV near physical line {line_number}: {exc}"
                ) from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read input file {str(path)!r}: {exc}") from exc


def decimal_value(raw: str, row_number: int, column: str) -> Decimal:
    if raw == "":
        raise CsvInsightsError(f"row {row_number}, column {column!r}: numeric value is blank")
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {raw!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {row_number}, column {column!r}: invalid numeric value {raw!r}"
        )
    return value


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = [column for column in (sum_column, avg_column) if column is not None]
    parsed: list[tuple[str, dict[str, Decimal]]] = []
    maximum_digits = 1
    for row_number, row in rows:
        values: dict[str, Decimal] = {}
        for column in numeric_columns:
            value = decimal_value(row[column], row_number, column)
            values[column] = value
            maximum_digits = max(maximum_digits, len(value.as_tuple().digits))
        parsed.append((row[group_column], values))

    groups: dict[str, dict[str, list[Decimal]]] = {}
    for group, values in parsed:
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column, value in values.items():
            bucket[column].append(value)

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    # Leave ample precision for exact sums and useful Decimal averages, including
    # inputs much larger than Decimal's default 28 significant digits.
    with localcontext() as context:
        context.prec = max(50, maximum_digits + len(str(max(1, len(rows)))) + 28)
        for group in sorted(groups):
            bucket = groups[group]
            output: dict[str, str] = {group_column: group}
            if sum_column:
                total = sum(bucket[sum_column], Decimal(0))
                output[f"sum_{sum_column}"] = decimal_string(total)
            if avg_column:
                values = bucket[avg_column]
                average = sum(values, Decimal(0)) / Decimal(len(values))
                output[f"avg_{avg_column}"] = decimal_string(average)
            output_rows.append(output)
    return output_header, output_rows


def write_output(header: Sequence[str], rows: Sequence[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=list(header),
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(Path(args.input))
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    filtered_rows = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.group_by:
        output_header, output_rows = aggregate_rows(
            filtered_rows, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = header
        output_rows = [row for _, row in filtered_rows]
    write_output(output_header, output_rows, args.output)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        run(args)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

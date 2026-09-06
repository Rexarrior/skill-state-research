#!/usr/bin/env python3
"""CSV Insights: small, dependency-free command-line CSV analytics."""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="UTF-8 CSV input file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def unique(items: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(items))


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
                f"malformed filter {raw_filter!r}: column name is empty"
            )
        filters.append((column, value))
    return filters


def validate_columns(columns: Sequence[str], header: Sequence[str]) -> None:
    known = set(header)
    for column in columns:
        if column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        source = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open input file {str(path)!r}: {exc}") from exc

    try:
        with source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty") from exc

            if not header:
                raise CsvInsightsError("header row is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "header names must be non-empty; empty header at column "
                    + ", ".join(empty_positions)
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

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((record_number, row))
    except csv.Error as exc:
        line = reader.line_num if "reader" in locals() else "unknown"
        raise CsvInsightsError(f"malformed CSV near line {line}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc

    return header, rows


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(f"invalid numeric value at row {row_number}, column {column!r}: blank")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def add_exact(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals without rounding to the process context precision."""
    highest_place = max(left.adjusted(), right.adjusted())
    lowest_place = min(left.as_tuple().exponent, right.as_tuple().exponent)
    with localcontext() as context:
        context.prec = max(1, highest_place - lowest_place + 2)
        return left + right


def analyze(
    header: list[str],
    numbered_rows: list[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
    group_by: str | None,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    positions = {name: index for index, name in enumerate(header)}
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[positions[column]] == value for column, value in filters)
    ]

    if not sum_columns and not avg_columns:
        return header, [dict(zip(header, row)) for _, row in filtered]

    assert group_by is not None
    numeric_columns = unique([*sum_columns, *avg_columns])
    groups: dict[str, dict[str, object]] = {}
    for row_number, row in filtered:
        group_value = row[positions[group_by]]
        group = groups.setdefault(
            group_value,
            {
                "sums": {column: Decimal(0) for column in numeric_columns},
                "counts": {column: 0 for column in numeric_columns},
            },
        )
        sums = group["sums"]
        counts = group["counts"]
        assert isinstance(sums, dict) and isinstance(counts, dict)
        for column in numeric_columns:
            value = decimal_value(row[positions[column]], row_number, column)
            sums[column] = add_exact(sums[column], value)
            counts[column] += 1

    output_header = [group_by]
    output_header.extend(f"sum_{column}" for column in sum_columns)
    output_header.extend(f"avg_{column}" for column in avg_columns)
    if len(set(output_header)) != len(output_header):
        raise CsvInsightsError("aggregation produces duplicate output column names")

    results: list[dict[str, str]] = []
    for group_value in sorted(groups):
        group = groups[group_value]
        sums = group["sums"]
        counts = group["counts"]
        assert isinstance(sums, dict) and isinstance(counts, dict)
        result = {group_by: group_value}
        for column in sum_columns:
            result[f"sum_{column}"] = format_decimal(sums[column])
        for column in avg_columns:
            result[f"avg_{column}"] = format_decimal(sums[column] / counts[column])
        results.append(result)
    return output_header, results


def write_output(output: str, header: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    if output == "json":
        sys.stdout.write(json.dumps(rows, ensure_ascii=False) + "\n")
        return

    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)
    sys.stdout.write(buffer.getvalue())


def run(args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    sum_columns = unique(args.sum_columns)
    avg_columns = unique(args.avg_columns)
    if (sum_columns or avg_columns) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    header, rows = read_csv(Path(args.input))
    requested = [column for column, _ in filters]
    if args.group_by is not None:
        requested.append(args.group_by)
    requested.extend(sum_columns)
    requested.extend(avg_columns)
    validate_columns(requested, header)
    output_header, result = analyze(
        header, rows, filters, args.group_by, sum_columns, avg_columns
    )
    write_output(args.output, output_header, result)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        parser.exit(1, f"error: {exc}\n")
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Filter and aggregate CSV files without third-party dependencies."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import TextIO


class CsvInsightsError(Exception):
    """An error that can be reported to a command-line user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums or averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group aggregates")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
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
                f"malformed filter {expression!r}: column name cannot be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if name == ""]
    if empty_positions:
        raise CsvInsightsError(
            "header names cannot be empty (field " + ", ".join(empty_positions) + ")"
        )

    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        rendered = ", ".join(repr(name) for name in duplicates)
        raise CsvInsightsError(f"header names must be unique; duplicate: {rendered}")


def validate_columns(headers: list[str], requested: Sequence[tuple[str, str | None]]) -> None:
    available = set(headers)
    for purpose, column in requested:
        if column is not None and column not in available:
            raise CsvInsightsError(f"unknown column {column!r} for {purpose}")


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise CsvInsightsError(f"cannot open {path}: {exc}") from exc

    with handle:
        reader = csv.reader(handle, strict=True)
        try:
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty") from None
            validate_headers(headers)

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
        except csv.Error as exc:
            raise CsvInsightsError(
                f"malformed CSV near physical line {reader.line_num}: {exc}"
            ) from exc
        except UnicodeError as exc:
            raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
        except OSError as exc:
            raise CsvInsightsError(f"cannot read {path}: {exc}") from exc

    return headers, rows


def decimal_cell(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank cell"
        )
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


def decimal_string(number: Decimal) -> str:
    if number.is_zero():
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def exact_add(left: Decimal, right: Decimal) -> Decimal:
    """Add finite decimals without rounding a long coefficient."""
    integer_places = max(left.adjusted() + 1, right.adjusted() + 1, 0)
    fractional_places = max(-left.as_tuple().exponent, -right.as_tuple().exponent, 0)
    with localcontext() as context:
        context.prec = max(28, integer_places + fractional_places + 1)
        return left + right


def filtered_rows(
    rows: Sequence[tuple[int, dict[str, str]]], filters: Sequence[tuple[str, str]]
) -> list[tuple[int, dict[str, str]]]:
    return [
        (record_number, row)
        for record_number, row in rows
        if all(row[column] == value for column, value in filters)
    ]


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    # Each entry contains exact Decimal totals and the number of contributing rows.
    groups: dict[str, dict[str, Decimal | int]] = {}
    for record_number, row in rows:
        group = row[group_column]
        state = groups.setdefault(group, {"count": 0, "sum": Decimal(0), "avg": Decimal(0)})
        state["count"] = int(state["count"]) + 1
        if sum_column is not None:
            state["sum"] = exact_add(Decimal(state["sum"]), decimal_cell(
                row[sum_column], record_number, sum_column
            ))
        if avg_column is not None:
            state["avg"] = exact_add(Decimal(state["avg"]), decimal_cell(
                row[avg_column], record_number, avg_column
            ))

    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        result = {group_column: group}
        if sum_column is not None:
            result[f"sum_{sum_column}"] = decimal_string(Decimal(state["sum"]))
        if avg_column is not None:
            total = Decimal(state["avg"])
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits) + 2)
                average = total / int(state["count"])
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_headers, output_rows


def write_output(
    output_format: str, headers: Sequence[str], rows: Sequence[dict[str, str]], stream: TextIO
) -> None:
    if output_format == "json":
        json.dump(rows, stream, ensure_ascii=False)
        stream.write("\n")
        return

    writer = csv.DictWriter(
        stream, fieldnames=headers, extrasaction="ignore", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace, stdout: TextIO) -> None:
    if (args.sum_column is not None or args.avg_column is not None) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    headers, rows = read_csv(Path(args.input))
    validate_columns(
        headers,
        [("--where", column) for column, _ in filters]
        + [
            ("--group-by", args.group_by),
            ("--sum", args.sum_column),
            ("--avg", args.avg_column),
        ],
    )
    generated_columns = [
        name
        for name in (
            f"sum_{args.sum_column}" if args.sum_column is not None else None,
            f"avg_{args.avg_column}" if args.avg_column is not None else None,
        )
        if name is not None
    ]
    if args.group_by in generated_columns:
        raise CsvInsightsError(
            f"generated aggregate column {args.group_by!r} conflicts with --group-by"
        )
    selected = filtered_rows(rows, filters)

    if args.sum_column is not None or args.avg_column is not None:
        output_headers, output_rows = aggregate_rows(
            selected, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in selected]
    write_output(args.output, output_headers, output_rows, stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

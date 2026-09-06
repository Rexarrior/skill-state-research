#!/usr/bin/env python3
"""Filter and aggregate RFC-4180-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class CsvInsightsError(Exception):
    """An error that should be reported to the command-line user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CsvInsightsError(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter and aggregate a CSV file.",
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
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise CsvInsightsError("--group-by requires --sum or --avg")
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


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input has no header row")
    empty_positions = [str(index) for index, value in enumerate(headers, start=1) if not value]
    if empty_positions:
        raise CsvInsightsError(
            "header names must be non-empty (empty at column "
            + ", ".join(empty_positions)
            + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in headers:
        if header in seen and header not in duplicates:
            duplicates.append(header)
        seen.add(header)
    if duplicates:
        raise CsvInsightsError(
            "header names must be unique (duplicate: "
            + ", ".join(repr(value) for value in duplicates)
            + ")"
        )


def require_columns(headers: list[str], columns: Sequence[str | None]) -> None:
    known = set(headers)
    for column in columns:
        if column is not None and column not in known:
            raise CsvInsightsError(f"unknown column: {column!r}")


def read_filtered_rows(
    path: Path, filters: Sequence[tuple[str, str]]
) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        source = path.open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise CsvInsightsError(f"cannot open input {str(path)!r}: {exc}") from exc

    try:
        with source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input is empty") from None
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV in header: {exc}") from exc

            validate_headers(headers)
            filter_columns = [column for column, _ in filters]
            require_columns(headers, filter_columns)
            indexes = {header: index for index, header in enumerate(headers)}
            rows: list[tuple[int, dict[str, str]]] = []

            try:
                for record_number, fields in enumerate(reader, start=2):
                    if len(fields) != len(headers):
                        raise CsvInsightsError(
                            f"row {record_number} has {len(fields)} fields; "
                            f"expected {len(headers)}"
                        )
                    if all(fields[indexes[column]] == value for column, value in filters):
                        rows.append((record_number, dict(zip(headers, fields))))
            except csv.Error as exc:
                raise CsvInsightsError(
                    f"malformed CSV near row {reader.line_num}: {exc}"
                ) from exc
            return headers, rows
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank"
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


def exact_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals without rounding at the default context precision."""
    if not values:
        return Decimal(0)
    minimum_exponent = min(value.as_tuple().exponent for value in values)
    nonzero_values = [value for value in values if value]
    if not nonzero_values:
        return Decimal(0)
    maximum_adjusted = max(value.adjusted() for value in nonzero_values)
    integer_digits = max(1, maximum_adjusted - minimum_exponent + 1)
    carry_digits = len(str(len(values)))
    with localcontext() as context:
        context.prec = max(28, integer_digits + carry_digits)
        return sum(values, Decimal(0))


def decimal_string(value: Decimal) -> str:
    if not value:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    groups: dict[str, dict[str, list[Decimal]]] = {}
    numeric_columns = list(dict.fromkeys(
        column for column in (sum_column, avg_column) if column is not None
    ))

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
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        result = {group_column: group_value}
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(
                exact_sum(groups[group_value][sum_column])
            )
        if avg_column:
            values = groups[group_value][avg_column]
            total = exact_sum(values)
            with localcontext() as context:
                context.prec = max(28, len(total.as_tuple().digits) + 28)
                average = total / Decimal(len(values))
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=headers,
        extrasaction="ignore",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    headers, numbered_rows = read_filtered_rows(args.input, filters)
    require_columns(
        headers,
        [args.group_by, args.sum_column, args.avg_column],
    )

    if args.group_by:
        output_headers, rows = aggregate(
            numbered_rows,
            args.group_by,
            args.sum_column,
            args.avg_column,
        )
    else:
        output_headers = headers
        rows = [row for _, row in numbered_rows]

    if args.output == "json":
        emit_json(rows)
    else:
        emit_csv(output_headers, rows)


def main() -> int:
    try:
        run()
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

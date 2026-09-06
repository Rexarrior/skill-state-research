#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
import math
from pathlib import Path
import sys
from typing import Iterable, Sequence


class UserError(Exception):
    """An input or command-line error suitable for displaying to the user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums/averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where", action="append", default=[], metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument(
        "--sum", dest="sum_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument(
        "--avg", dest="avg_columns", action="append", default=[], metavar="COLUMN"
    )
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)

    if (args.sum_columns or args.avg_columns) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_columns or args.avg_columns):
        parser.error("--group-by requires --sum or --avg")
    return args


def parse_filters(values: Iterable[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise UserError(
                f"malformed filter {value!r}: expected COLUMN=VALUE"
            )
        column, expected = value.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {value!r}: column name must not be empty"
            )
        filters.append((column, expected))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise UserError("input has no header row")
    empty_positions = [str(i + 1) for i, name in enumerate(headers) if not name]
    if empty_positions:
        raise UserError(
            "header names must not be empty (field " + ", ".join(empty_positions) + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise UserError("duplicate header name(s): " + ", ".join(repr(x) for x in duplicates))


def require_columns(headers: list[str], requested: Iterable[str]) -> None:
    known = set(headers)
    for column in requested:
        if column not in known:
            raise UserError(f"unknown column: {column!r}")


def read_rows(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise UserError("input is empty") from None
            validate_headers(headers)

            rows: list[tuple[int, dict[str, str]]] = []
            for record_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise UserError(
                        f"row {record_number} has {len(fields)} fields; "
                        f"expected {len(headers)}"
                    )
                rows.append((record_number, dict(zip(headers, fields))))
            return headers, rows
    except UserError:
        raise
    except csv.Error as exc:
        line = getattr(locals().get("reader"), "line_num", None)
        location = f" near line {line}" if line else ""
        raise UserError(f"malformed CSV{location}: {exc}") from exc
    except UnicodeError as exc:
        raise UserError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise UserError(f"cannot read {path}: {exc}") from exc


def parse_number(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_precision(values: list[Decimal]) -> int:
    """Return enough context precision to add the finite decimals exactly."""
    if not values:
        return 28
    nonzero = [value for value in values if value]
    if not nonzero:
        return 28
    highest_place = max(value.adjusted() for value in nonzero)
    lowest_place = min(value.as_tuple().exponent for value in values)
    carry_digits = math.ceil(math.log10(len(values) + 1))
    return max(28, highest_place - lowest_place + carry_digits + 2)


def minimal_decimal(value: Decimal) -> str:
    if not value:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    rows: list[tuple[int, dict[str, str]]],
    group_column: str,
    sum_columns: list[str],
    avg_columns: list[str],
) -> tuple[list[str], list[dict[str, str]]]:
    numeric_columns = list(dict.fromkeys(sum_columns + avg_columns))
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for row_number, row in rows:
        parsed = {
            column: parse_number(row[column], row_number, column)
            for column in numeric_columns
        }
        group = groups.setdefault(
            row[group_column], {column: [] for column in numeric_columns}
        )
        for column, number in parsed.items():
            group[column].append(number)

    output_headers = (
        [group_column]
        + [f"sum_{column}" for column in sum_columns]
        + [f"avg_{column}" for column in avg_columns]
    )
    output_rows: list[dict[str, str]] = []
    for group_value in sorted(groups):
        values_by_column = groups[group_value]
        totals: dict[str, Decimal] = {}
        for column, values in values_by_column.items():
            with localcontext() as context:
                context.prec = decimal_precision(values)
                totals[column] = sum(values, Decimal(0))

        output: dict[str, str] = {group_column: group_value}
        for column in sum_columns:
            output[f"sum_{column}"] = minimal_decimal(totals[column])
        for column in avg_columns:
            values = values_by_column[column]
            with localcontext() as context:
                context.prec = max(28, decimal_precision(values))
                average = totals[column] / Decimal(len(values))
            output[f"avg_{column}"] = minimal_decimal(average)
        output_rows.append(output)
    return output_headers, output_rows


def emit_json(rows: list[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def emit_csv(headers: list[str], rows: list[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    filters = parse_filters(args.where)
    headers, numbered_rows = read_rows(args.input)
    require_columns(
        headers,
        [column for column, _ in filters]
        + ([args.group_by] if args.group_by else [])
        + args.sum_columns
        + args.avg_columns,
    )

    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == expected for column, expected in filters)
    ]

    if args.group_by:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_columns, args.avg_columns
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_headers, output_rows)
    return 0


def main() -> int:
    try:
        return run()
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

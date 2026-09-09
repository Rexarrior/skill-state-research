#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class UserError(Exception):
    """An input or command-line error suitable for display to the user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UserError(message)


def parser() -> ArgumentParser:
    result = ArgumentParser(
        prog="main.py",
        description="Filter and aggregate an RFC-4180-style CSV file.",
    )
    result.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    result.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="exact-match filter; may be repeated",
    )
    result.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    result.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    result.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    result.add_argument("--output", choices=("json", "csv"), default="json")
    return result


def parse_filters(values: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise UserError(f"malformed filter {value!r}: expected COLUMN=VALUE")
        column, expected = value.split("=", 1)
        if not column:
            raise UserError(f"malformed filter {value!r}: column name is empty")
        filters.append((column, expected))
    return filters


def read_csv(path: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("input CSV is empty") from None

            if not header:
                raise UserError("header row is empty")
            empty_position = next((i for i, name in enumerate(header, 1) if name == ""), None)
            if empty_position is not None:
                raise UserError(f"header column {empty_position} is empty")
            seen: set[str] = set()
            duplicate = next((name for name in header if name in seen or seen.add(name)), None)
            if duplicate is not None:
                raise UserError(f"duplicate header column: {duplicate!r}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, 2):
                if len(row) != len(header):
                    raise UserError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except UserError:
        raise
    except csv.Error as exc:
        raise UserError(f"malformed CSV: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise UserError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise UserError(f"cannot read {path!r}: {exc}") from exc


def require_columns(header: Sequence[str], columns: Sequence[str | None]) -> None:
    known = set(header)
    for column in columns:
        if column is not None and column not in known:
            raise UserError(f"unknown column: {column!r}")


def decimal_value(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"row {row_number}, column {column!r}: numeric value is blank")
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


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    positions = {name: position for position, name in enumerate(header)}
    numeric_columns = list(dict.fromkeys(c for c in (sum_column, avg_column) if c is not None))
    groups: dict[str, dict[str, list[Decimal]]] = {}

    for row_number, row in rows:
        group = row[positions[group_column]]
        bucket = groups.setdefault(group, {column: [] for column in numeric_columns})
        for column in numeric_columns:
            bucket[column].append(decimal_value(row[positions[column]], row_number, column))

    output_header = [group_column]
    if sum_column:
        output_header.append(f"sum_{sum_column}")
    if avg_column:
        output_header.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        result = {group_column: group}
        bucket = groups[group]
        # Extra precision keeps large exact sums intact and gives useful repeating averages.
        precision = max(
            50,
            sum(max(1, len(value.as_tuple().digits)) for values in bucket.values() for value in values)
            + 10,
        )
        with localcontext() as context:
            context.prec = precision
            if sum_column:
                result[f"sum_{sum_column}"] = format_decimal(sum(bucket[sum_column], Decimal(0)))
            if avg_column:
                values = bucket[avg_column]
                average = sum(values, Decimal(0)) / Decimal(len(values))
                result[f"avg_{avg_column}"] = format_decimal(average)
        output_rows.append(result)
    return output_header, output_rows


def write_output(output_format: str, header: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    if output_format == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)


def run(arguments: Sequence[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")

    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(args.input)
    require_columns(
        header,
        [*(column for column, _ in filters), args.group_by, args.sum_column, args.avg_column],
    )
    positions = {name: position for position, name in enumerate(header)}
    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[positions[column]] == expected for column, expected in filters)
    ]

    if args.sum_column or args.avg_column:
        output_header, output_rows = aggregate(
            header, filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_header = list(header)
        output_rows = [dict(zip(header, row)) for _, row in filtered]
    write_output(args.output, output_header, output_rows)


def main() -> int:
    try:
        run()
        return 0
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

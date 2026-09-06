#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import json
import sys
from collections.abc import Sequence
from pathlib import Path


class UserError(Exception):
    """An input or command-line error suitable for display to the user."""


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
        help="keep rows whose column exactly equals value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to group rows")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument(
        "--avg", dest="avg_column", metavar="COLUMN", help="column to average"
    )
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    return parser


def validate_options(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise UserError("--group-by requires --sum or --avg")


def parse_filters(raw_filters: Sequence[str]) -> list[tuple[str, str]]:
    filters: list[tuple[str, str]] = []
    for raw in raw_filters:
        if "=" not in raw:
            raise UserError(
                f"malformed filter {raw!r}: expected COLUMN=VALUE"
            )
        column, value = raw.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {raw!r}: column name must not be empty"
            )
        filters.append((column, value))
    return filters


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise UserError("CSV header is empty")
    empty_positions = [str(index + 1) for index, name in enumerate(headers) if not name]
    if empty_positions:
        raise UserError(
            "CSV header names must not be empty (column "
            + ", ".join(empty_positions)
            + ")"
        )
    seen: set[str] = set()
    duplicates: list[str] = []
    for name in headers:
        if name in seen and name not in duplicates:
            duplicates.append(name)
        seen.add(name)
    if duplicates:
        raise UserError(
            "CSV header names must be unique; duplicate: "
            + ", ".join(repr(name) for name in duplicates)
        )


def read_csv(path: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise UserError("CSV input is empty") from None
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
        line = f" near line {getattr(reader, 'line_num', '?')}"
        raise UserError(f"malformed CSV{line}: {exc}") from None
    except UnicodeError as exc:
        raise UserError(f"cannot decode input as UTF-8: {exc}") from None
    except OSError as exc:
        raise UserError(f"cannot read {path!r}: {exc}") from None


def require_columns(headers: Sequence[str], columns: Sequence[tuple[str, str]]) -> None:
    available = set(headers)
    for option, column in columns:
        if column not in available:
            raise UserError(f"unknown column {column!r} for {option}")


def parse_number(value: str, record_number: int, column: str) -> Decimal:
    if not value:
        raise UserError(f"row {record_number}, column {column!r}: numeric value is blank")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise UserError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from None
    if not number.is_finite():
        raise UserError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
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
    # Values are parsed independently for each requested operation. This keeps
    # errors tied to the exact option column, including when sum and avg differ.
    groups: dict[str, dict[str, Decimal | int]] = {}
    for record_number, row in rows:
        key = row[group_column]
        values = groups.setdefault(key, {"count": 0})
        values["count"] = int(values["count"]) + 1
        if sum_column:
            number = parse_number(row[sum_column], record_number, sum_column)
            values["sum"] = Decimal(values.get("sum", Decimal(0))) + number
        if avg_column:
            number = parse_number(row[avg_column], record_number, avg_column)
            values["avg_total"] = Decimal(values.get("avg_total", Decimal(0))) + number

    output_headers = [group_column]
    if sum_column:
        output_headers.append(f"sum_{sum_column}")
    if avg_column:
        output_headers.append(f"avg_{avg_column}")

    output_rows: list[dict[str, str]] = []
    for key in sorted(groups):
        values = groups[key]
        result = {group_column: key}
        if sum_column:
            result[f"sum_{sum_column}"] = decimal_string(Decimal(values["sum"]))
        if avg_column:
            average = Decimal(values["avg_total"]) / int(values["count"])
            result[f"avg_{avg_column}"] = decimal_string(average)
        output_rows.append(result)
    return output_headers, output_rows


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def emit_csv(headers: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(
        sys.stdout, fieldnames=headers, extrasaction="raise", lineterminator="\r\n"
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    validate_options(args)
    filters = parse_filters(args.where)
    headers, numbered_rows = read_csv(args.input)

    requested_columns = [("--where", column) for column, _ in filters]
    if args.group_by:
        requested_columns.append(("--group-by", args.group_by))
    if args.sum_column:
        requested_columns.append(("--sum", args.sum_column))
    if args.avg_column:
        requested_columns.append(("--avg", args.avg_column))
    require_columns(headers, requested_columns)

    filtered = [
        (number, row)
        for number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]
    if args.group_by:
        output_headers, output_rows = aggregate(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_headers, output_rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except UserError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

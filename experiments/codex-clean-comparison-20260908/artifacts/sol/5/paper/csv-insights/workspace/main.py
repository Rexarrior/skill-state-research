#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Iterable, Sequence, TextIO


class UserError(Exception):
    """An input or command-line error suitable for showing to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally compute grouped sums and averages."
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except (OSError, UnicodeError) as exc:
        raise UserError(f"cannot open input file {path}: {exc}") from exc

    try:
        with handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise UserError("input CSV is empty; a header row is required") from exc
            except csv.Error as exc:
                raise UserError(f"malformed CSV header: {exc}") from exc

            if not header:
                raise UserError("CSV header must contain at least one column")
            empty_positions = [str(i + 1) for i, name in enumerate(header) if name == ""]
            if empty_positions:
                raise UserError(
                    "CSV header names must be non-empty "
                    f"(empty at column {', '.join(empty_positions)})"
                )
            seen: set[str] = set()
            duplicates: list[str] = []
            for name in header:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                raise UserError(
                    "CSV header names must be unique "
                    f"(duplicate: {', '.join(repr(name) for name in duplicates)})"
                )

            rows: list[tuple[int, list[str]]] = []
            record_number = 1
            try:
                for row in reader:
                    record_number += 1
                    if len(row) != len(header):
                        raise UserError(
                            f"row {record_number} has {len(row)} fields; "
                            f"expected {len(header)}"
                        )
                    rows.append((record_number, row))
            except csv.Error as exc:
                raise UserError(
                    f"malformed CSV near physical line {reader.line_num}: {exc}"
                ) from exc
            except UnicodeError as exc:
                raise UserError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise UserError(f"cannot read input file {path}: {exc}") from exc

    return header, rows


def require_column(name: str, indexes: dict[str, int], option: str) -> int:
    try:
        return indexes[name]
    except KeyError as exc:
        raise UserError(f"unknown column for {option}: {name!r}") from exc


def parse_filters(
    values: Sequence[str], indexes: dict[str, int]
) -> list[tuple[int, str]]:
    filters: list[tuple[int, str]] = []
    for expression in values:
        if "=" not in expression:
            raise UserError(
                f"malformed --where filter {expression!r}; expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise UserError(
                f"malformed --where filter {expression!r}; column cannot be empty"
            )
        filters.append((require_column(column, indexes, "--where"), value))
    return filters


def parse_decimal(value: str, row_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(f"invalid numeric value at row {row_number}, column {column!r}: blank")
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise UserError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        ) from exc
    if not number.is_finite():
        raise UserError(
            f"invalid numeric value at row {row_number}, column {column!r}: {value!r}"
        )
    return number


def decimal_text(number: Decimal) -> str:
    if number == 0:
        return "0"
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def aggregate_rows(
    rows: Iterable[tuple[int, list[str]]],
    header: Sequence[str],
    group_index: int,
    sum_index: int | None,
    avg_index: int | None,
) -> tuple[list[str], list[list[str]]]:
    # Each list stores [sum, count]. The count is also needed for averages.
    groups: dict[str, dict[str, Decimal | int]] = {}
    sum_name = header[sum_index] if sum_index is not None else None
    avg_name = header[avg_index] if avg_index is not None else None

    for row_number, row in rows:
        group = row[group_index]
        bucket = groups.setdefault(group, {"sum": Decimal(0), "avg_sum": Decimal(0), "count": 0})
        if sum_index is not None:
            value = parse_decimal(row[sum_index], row_number, sum_name or "")
            bucket["sum"] = bucket["sum"] + value  # type: ignore[operator]
        if avg_index is not None:
            value = parse_decimal(row[avg_index], row_number, avg_name or "")
            bucket["avg_sum"] = bucket["avg_sum"] + value  # type: ignore[operator]
            bucket["count"] = int(bucket["count"]) + 1

    output_header = [header[group_index]]
    if sum_name is not None:
        output_header.append(f"sum_{sum_name}")
    if avg_name is not None:
        output_header.append(f"avg_{avg_name}")

    output_rows: list[list[str]] = []
    for group in sorted(groups):
        bucket = groups[group]
        result = [group]
        if sum_name is not None:
            result.append(decimal_text(bucket["sum"]))  # type: ignore[arg-type]
        if avg_name is not None:
            # Use a generous context while keeping Decimal's deterministic rounding
            # for non-terminating averages.
            with localcontext() as context:
                context.prec = max(50, len(bucket["avg_sum"].as_tuple().digits) + 20)  # type: ignore[union-attr]
                average = bucket["avg_sum"] / int(bucket["count"])  # type: ignore[operator]
            result.append(decimal_text(average))
        output_rows.append(result)
    return output_header, output_rows


def emit_json(header: Sequence[str], rows: Iterable[Sequence[str]], stream: TextIO) -> None:
    objects = [dict(zip(header, row)) for row in rows]
    json.dump(objects, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")


def emit_csv(header: Sequence[str], rows: Iterable[Sequence[str]], stream: TextIO) -> None:
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")

    header, numbered_rows = read_csv(Path(args.input))
    indexes = {name: index for index, name in enumerate(header)}
    filters = parse_filters(args.where, indexes)

    group_index = (
        require_column(args.group_by, indexes, "--group-by")
        if args.group_by is not None
        else None
    )
    sum_index = (
        require_column(args.sum_column, indexes, "--sum")
        if args.sum_column is not None
        else None
    )
    avg_index = (
        require_column(args.avg_column, indexes, "--avg")
        if args.avg_column is not None
        else None
    )

    filtered = [
        (row_number, row)
        for row_number, row in numbered_rows
        if all(row[index] == value for index, value in filters)
    ]

    if sum_index is not None or avg_index is not None:
        assert group_index is not None
        output_header, output_rows = aggregate_rows(
            filtered, header, group_index, sum_index, avg_index
        )
    else:
        output_header = header
        output_rows = [row for _, row in filtered]

    if args.output == "json":
        emit_json(output_header, output_rows, sys.stdout)
    else:
        emit_csv(output_header, output_rows, sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

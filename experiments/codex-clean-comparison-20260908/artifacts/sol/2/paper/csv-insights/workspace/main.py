#!/usr/bin/env python3
"""Command-line analytics for RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class UserError(Exception):
    """An input or command-line error suitable for showing to the user."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UserError(message)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Filter and aggregate a CSV file.",
        allow_abbrev=False,
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to read")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly equals the value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column used to form groups")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="numeric column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="numeric column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    args = parser.parse_args(argv)
    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")
    return args


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration:
                raise UserError("input has no header row") from None

            if not header:
                raise UserError("input has no headers")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if name == ""]
            if empty_positions:
                raise UserError(f"header names must be non-empty (column {', '.join(empty_positions)})")
            duplicates = sorted({name for name in header if header.count(name) > 1})
            if duplicates:
                raise UserError(f"duplicate header: {duplicates[0]!r}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise UserError(
                        f"row {record_number} has {len(row)} fields; expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except UserError:
        raise
    except FileNotFoundError:
        raise UserError(f"input file not found: {path}") from None
    except IsADirectoryError:
        raise UserError(f"input path is not a file: {path}") from None
    except PermissionError:
        raise UserError(f"cannot read input file: {path}") from None
    except UnicodeDecodeError as exc:
        raise UserError(f"input is not valid UTF-8: {exc}") from None
    except csv.Error as exc:
        raise UserError(f"malformed CSV: {exc}") from None
    except OSError as exc:
        raise UserError(f"cannot read input file: {exc}") from None


def parse_filters(raw_filters: Sequence[str], header: Sequence[str]) -> list[tuple[int, str]]:
    filters: list[tuple[int, str]] = []
    for raw_filter in raw_filters:
        if "=" not in raw_filter:
            raise UserError(f"malformed filter {raw_filter!r}; expected COLUMN=VALUE")
        column, value = raw_filter.split("=", 1)
        if not column:
            raise UserError(f"malformed filter {raw_filter!r}; column must be non-empty")
        if column not in header:
            raise UserError(f"unknown column in --where: {column!r}")
        filters.append((header.index(column), value))
    return filters


def require_column(name: str | None, option: str, header: Sequence[str]) -> int | None:
    if name is None:
        return None
    if name not in header:
        raise UserError(f"unknown column for {option}: {name!r}")
    return header.index(name)


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise UserError(f"row {row_number}, column {column!r}: blank numeric value")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        ) from None
    if not value.is_finite():
        raise UserError(
            f"row {row_number}, column {column!r}: invalid numeric value {text!r}"
        )
    return value


def decimal_text(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def filtered_rows(
    rows: Sequence[tuple[int, list[str]]], filters: Sequence[tuple[int, str]]
) -> list[tuple[int, list[str]]]:
    return [
        (row_number, row)
        for row_number, row in rows
        if all(row[index] == expected for index, expected in filters)
    ]


def aggregate(
    rows: Sequence[tuple[int, list[str]]],
    header: Sequence[str],
    group_index: int,
    sum_index: int | None,
    avg_index: int | None,
) -> tuple[list[str], list[dict[str, str]]]:
    group_column = header[group_index]
    output_header = [group_column]
    if sum_index is not None:
        output_header.append(f"sum_{header[sum_index]}")
    if avg_index is not None:
        output_header.append(f"avg_{header[avg_index]}")

    parsed: list[tuple[str, Decimal | None, Decimal | None]] = []
    numeric_values: list[Decimal] = []
    for row_number, row in rows:
        sum_value = (
            decimal_value(row[sum_index], row_number, header[sum_index])
            if sum_index is not None
            else None
        )
        avg_value = (
            decimal_value(row[avg_index], row_number, header[avg_index])
            if avg_index is not None
            else None
        )
        parsed.append((row[group_index], sum_value, avg_value))
        if sum_value is not None:
            numeric_values.append(sum_value)
        if avg_value is not None:
            numeric_values.append(avg_value)

    # Use enough precision to add all finite input decimals without rounding.
    if numeric_values:
        highest_place = max(value.adjusted() for value in numeric_values)
        lowest_place = min(value.as_tuple().exponent for value in numeric_values)
        exact_sum_precision = highest_place - lowest_place + len(str(max(1, len(rows)))) + 2
    else:
        exact_sum_precision = 28

    groups: dict[str, dict[str, Decimal | int]] = {}
    with localcontext() as context:
        context.prec = max(28, exact_sum_precision)
        for group, sum_value, avg_value in parsed:
            bucket = groups.setdefault(
                group,
                {"sum": Decimal(0), "avg_total": Decimal(0), "avg_count": 0},
            )
            if sum_value is not None:
                bucket["sum"] += sum_value  # type: ignore[operator]
            if avg_value is not None:
                bucket["avg_total"] += avg_value  # type: ignore[operator]
                bucket["avg_count"] += 1  # type: ignore[operator]

        results: list[dict[str, str]] = []
        for group in sorted(groups):
            bucket = groups[group]
            result = {group_column: group}
            if sum_index is not None:
                result[f"sum_{header[sum_index]}"] = decimal_text(bucket["sum"])  # type: ignore[arg-type]
            if avg_index is not None:
                average = bucket["avg_total"] / bucket["avg_count"]  # type: ignore[operator]
                result[f"avg_{header[avg_index]}"] = decimal_text(average)
            results.append(result)
    return output_header, results


def emit_json(rows: Sequence[dict[str, str]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def emit_csv(header: Sequence[str], rows: Sequence[dict[str, str]]) -> None:
    writer = csv.DictWriter(sys.stdout, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str]) -> None:
    args = parse_args(argv)
    header, all_rows = read_csv(Path(args.input))
    filters = parse_filters(args.where, header)
    group_index = require_column(args.group_by, "--group-by", header)
    sum_index = require_column(args.sum_column, "--sum", header)
    avg_index = require_column(args.avg_column, "--avg", header)
    selected = filtered_rows(all_rows, filters)

    if sum_index is not None or avg_index is not None:
        assert group_index is not None
        output_header, output_rows = aggregate(
            selected, header, group_index, sum_index, avg_index
        )
    else:
        output_header = list(header)
        output_rows = [dict(zip(header, row)) for _, row in selected]

    if args.output == "json":
        emit_json(output_rows)
    else:
        emit_csv(output_header, output_rows)


def main() -> int:
    try:
        run(sys.argv[1:])
        return 0
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

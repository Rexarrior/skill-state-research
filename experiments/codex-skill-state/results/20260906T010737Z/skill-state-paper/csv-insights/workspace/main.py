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
    """An error suitable for display to a command-line user."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter rows or calculate grouped sums and averages from CSV."
    )
    parser.add_argument("input", metavar="INPUT.csv", type=Path)
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="retain rows whose column exactly matches value (repeatable)",
    )
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", action="append", default=[], metavar="COLUMN")
    parser.add_argument("--avg", action="append", default=[], metavar="COLUMN")
    parser.add_argument(
        "--output", choices=("json", "csv"), default="json", help="output format"
    )
    args = parser.parse_args(argv)

    if (args.sum or args.avg) and not args.group_by:
        parser.error("--sum and --avg require --group-by")
    if args.group_by and not (args.sum or args.avg):
        parser.error("--group-by requires --sum or --avg")
    for option, columns in (("--sum", args.sum), ("--avg", args.avg)):
        duplicates = sorted({column for column in columns if columns.count(column) > 1})
        if duplicates:
            parser.error(f"{option} specified more than once for: {', '.join(duplicates)}")
    return args


def validate_headers(headers: list[str]) -> None:
    if not headers:
        raise CsvInsightsError("input CSV is empty; a header row is required")
    empty = [str(index) for index, name in enumerate(headers, start=1) if name == ""]
    if empty:
        raise CsvInsightsError(
            f"header names must be non-empty (empty field at column {', '.join(empty)})"
        )
    duplicates = sorted({name for name in headers if headers.count(name) > 1})
    if duplicates:
        raise CsvInsightsError(f"header names must be unique: {', '.join(duplicates)}")


def parse_filters(raw_filters: list[str], headers: list[str]) -> list[tuple[int, str]]:
    parsed: list[tuple[int, str]] = []
    for raw in raw_filters:
        if "=" not in raw:
            raise CsvInsightsError(
                f"malformed filter {raw!r}; expected COLUMN=VALUE"
            )
        column, value = raw.split("=", 1)
        if not column:
            raise CsvInsightsError(
                f"malformed filter {raw!r}; column name must be non-empty"
            )
        if column not in headers:
            raise CsvInsightsError(f"unknown column in --where: {column}")
        parsed.append((headers.index(column), value))
    return parsed


def require_columns(args: argparse.Namespace, headers: list[str]) -> None:
    requested: list[tuple[str, str | None]] = [
        ("--group-by", args.group_by),
        *(("--sum", column) for column in args.sum),
        *(("--avg", column) for column in args.avg),
    ]
    for option, column in requested:
        if column is not None and column not in headers:
            raise CsvInsightsError(f"unknown column for {option}: {column}")


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                headers = []
            validate_headers(headers)
            rows: list[list[str]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(headers):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} fields; expected {len(headers)}"
                    )
                rows.append(row)
            return headers, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        raise CsvInsightsError(f"malformed CSV near line {getattr(reader, 'line_num', '?')}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def decimal_value(text: str, record_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(f"row {record_number}, column {column}: blank numeric value")
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column}: invalid numeric value {text!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column}: invalid numeric value {text!r}"
        )
    return value


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def aggregate(
    rows: list[tuple[int, list[str]]], headers: list[str], args: argparse.Namespace
) -> tuple[list[str], list[list[str]]]:
    group_index = headers.index(args.group_by)
    sum_columns = [(column, headers.index(column)) for column in args.sum]
    avg_columns = [(column, headers.index(column)) for column in args.avg]
    output_headers = [
        args.group_by,
        *(f"sum_{column}" for column, _ in sum_columns),
        *(f"avg_{column}" for column, _ in avg_columns),
    ]
    if len(set(output_headers)) != len(output_headers):
        raise CsvInsightsError("aggregation produces duplicate output column names")

    groups: dict[str, dict[str, object]] = {}
    numeric_columns = list(dict.fromkeys([*args.sum, *args.avg]))
    numeric_indexes = {column: headers.index(column) for column in numeric_columns}
    for record_number, row in rows:
        key = row[group_index]
        values = {
            column: decimal_value(row[index], record_number, column)
            for column, index in numeric_indexes.items()
        }
        state = groups.setdefault(
            key,
            {"count": 0, "totals": {column: Decimal(0) for column in numeric_columns}},
        )
        state["count"] = int(state["count"]) + 1
        totals = state["totals"]
        assert isinstance(totals, dict)
        for column, value in values.items():
            totals[column] += value

    output_rows: list[list[str]] = []
    for key in sorted(groups):
        state = groups[key]
        totals = state["totals"]
        count = int(state["count"])
        assert isinstance(totals, dict)
        digit_count = max(
            (len(value.as_tuple().digits) for value in totals.values()), default=1
        )
        with localcontext() as context:
            context.prec = max(28, digit_count + len(str(max(count, 1))) + 10)
            output_rows.append(
                [
                    key,
                    *(decimal_string(totals[column]) for column, _ in sum_columns),
                    *(
                        decimal_string(totals[column] / count)
                        for column, _ in avg_columns
                    ),
                ]
            )
    return output_headers, output_rows


def write_output(headers: list[str], rows: list[list[str]], output: str) -> None:
    if output == "csv":
        writer = csv.writer(sys.stdout, lineterminator="\n")
        writer.writerow(headers)
        writer.writerows(rows)
        return
    objects = [dict(zip(headers, row)) for row in rows]
    json.dump(objects, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def run(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    headers, all_rows = read_csv(args.input)
    require_columns(args, headers)
    filters = parse_filters(args.where, headers)
    filtered = [
        (record_number, row)
        for record_number, row in enumerate(all_rows, start=2)
        if all(row[index] == value for index, value in filters)
    ]
    if args.group_by:
        output_headers, output_rows = aggregate(filtered, headers, args)
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]
    write_output(output_headers, output_rows, args.output)


def main() -> int:
    try:
        run()
        return 0
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

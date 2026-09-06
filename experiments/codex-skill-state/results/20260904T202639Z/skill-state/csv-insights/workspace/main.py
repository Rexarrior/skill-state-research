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
from typing import TextIO


class CsvInsightsError(Exception):
    """An input or processing error suitable for display to the user."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and calculate grouped sums and averages."
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
    parser.add_argument(
        "--sum",
        dest="sum_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="sum a numeric column (repeatable; requires --group-by)",
    )
    parser.add_argument(
        "--avg",
        dest="avg_columns",
        action="append",
        default=[],
        metavar="COLUMN",
        help="average a numeric column (repeatable; requires --group-by)",
    )
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, list[str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise CsvInsightsError("input CSV is empty; a header is required") from exc

            if not header:
                raise CsvInsightsError("CSV header is empty")
            empty_positions = [str(index + 1) for index, name in enumerate(header) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "CSV header contains an empty column name at position(s) "
                    + ", ".join(empty_positions)
                )

            seen: set[str] = set()
            duplicates: list[str] = []
            for name in header:
                if name in seen and name not in duplicates:
                    duplicates.append(name)
                seen.add(name)
            if duplicates:
                rendered = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"CSV header contains duplicate column(s): {rendered}")

            rows: list[tuple[int, list[str]]] = []
            for record_number, row in enumerate(reader, start=2):
                if len(row) != len(header):
                    raise CsvInsightsError(
                        f"row {record_number} has {len(row)} field(s); "
                        f"expected {len(header)}"
                    )
                rows.append((record_number, row))
            return header, rows
    except CsvInsightsError:
        raise
    except csv.Error as exc:
        line = f" near physical line {getattr(reader, 'line_num', '?')}"
        raise CsvInsightsError(f"malformed CSV{line}: {exc}") from exc
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {path}: {exc}") from exc


def require_columns(header: Sequence[str], requested: Sequence[tuple[str, str]]) -> None:
    available = set(header)
    for column, purpose in requested:
        if column not in available:
            raise CsvInsightsError(f"unknown column {column!r} used by {purpose}")


def decimal_value(text: str, row_number: int, column: str) -> Decimal:
    if text == "":
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: blank cell"
        )
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {text!r}"
        ) from exc
    if not value.is_finite():
        raise CsvInsightsError(
            f"invalid numeric value at row {row_number}, column {column!r}: {text!r}"
        )
    return value


def decimal_string(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def add_exact(left: Decimal, right: Decimal) -> Decimal:
    """Add finite Decimals without rounding in the active decimal context."""
    lowest_exponent = min(left.as_tuple().exponent, right.as_tuple().exponent)
    highest_place = max(left.adjusted(), right.adjusted(), 0)
    with localcontext() as context:
        # Cover every place in both operands, plus one possible carry digit.
        context.prec = max(1, highest_place - lowest_exponent + 2)
        return left + right


def filtered_rows(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    filters: Sequence[tuple[str, str]],
) -> list[tuple[int, list[str]]]:
    indexes = [(header.index(column), expected) for column, expected in filters]
    return [
        (number, row)
        for number, row in rows
        if all(row[index] == expected for index, expected in indexes)
    ]


def aggregate(
    header: Sequence[str],
    rows: Sequence[tuple[int, list[str]]],
    group_column: str,
    sum_columns: Sequence[str],
    avg_columns: Sequence[str],
) -> tuple[list[str], list[dict[str, str]]]:
    group_index = header.index(group_column)
    numeric_columns = list(dict.fromkeys([*sum_columns, *avg_columns]))
    numeric_indexes = {column: header.index(column) for column in numeric_columns}
    groups: dict[str, dict[str, object]] = {}

    for row_number, row in rows:
        group = row[group_index]
        state = groups.setdefault(
            group,
            {
                "count": 0,
                "totals": {column: Decimal(0) for column in numeric_columns},
            },
        )
        totals = state["totals"]
        assert isinstance(totals, dict)
        for column, index in numeric_indexes.items():
            totals[column] = add_exact(
                totals[column], decimal_value(row[index], row_number, column)
            )
        state["count"] = int(state["count"]) + 1

    output_header = [
        group_column,
        *(f"sum_{column}" for column in sum_columns),
        *(f"avg_{column}" for column in avg_columns),
    ]
    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        totals = state["totals"]
        count = int(state["count"])
        assert isinstance(totals, dict)
        result = {group_column: group}
        for column in sum_columns:
            result[f"sum_{column}"] = decimal_string(totals[column])
        for column in avg_columns:
            total = totals[column]
            with localcontext() as context:
                # Retain all input precision and provide ample room for division.
                context.prec = max(28, len(total.as_tuple().digits) + 28)
                average = total / Decimal(count)
            result[f"avg_{column}"] = decimal_string(average)
        output_rows.append(result)
    return output_header, output_rows


def emit_json(rows: Sequence[dict[str, str]], output: TextIO) -> None:
    json.dump(rows, output, ensure_ascii=False, indent=2)
    output.write("\n")


def emit_csv(
    header: Sequence[str], rows: Sequence[dict[str, str]], output: TextIO
) -> None:
    writer = csv.DictWriter(
        output,
        fieldnames=list(header),
        lineterminator="\r\n",
        extrasaction="raise",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace, output: TextIO) -> None:
    if (args.sum_columns or args.avg_columns) and args.group_by is None:
        raise CsvInsightsError("--sum and --avg require --group-by")
    if args.group_by is not None and not (args.sum_columns or args.avg_columns):
        raise CsvInsightsError("--group-by requires --sum and/or --avg")
    if len(args.sum_columns) != len(set(args.sum_columns)):
        raise CsvInsightsError("the same --sum column cannot be specified more than once")
    if len(args.avg_columns) != len(set(args.avg_columns)):
        raise CsvInsightsError("the same --avg column cannot be specified more than once")

    filters = parse_filters(args.where)
    header, numbered_rows = read_csv(Path(args.input))
    requested = [(column, "--where") for column, _ in filters]
    requested += [(column, "--sum") for column in args.sum_columns]
    requested += [(column, "--avg") for column in args.avg_columns]
    if args.group_by is not None:
        requested.append((args.group_by, "--group-by"))
    require_columns(header, requested)

    selected = filtered_rows(header, numbered_rows, filters)
    if args.group_by is None:
        result_header = list(header)
        result_rows = [dict(zip(header, row, strict=True)) for _, row in selected]
    else:
        result_header, result_rows = aggregate(
            header,
            selected,
            args.group_by,
            args.sum_columns,
            args.avg_columns,
        )

    if args.output == "json":
        emit_json(result_rows, output)
    else:
        emit_csv(result_header, result_rows, output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args, sys.stdout)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

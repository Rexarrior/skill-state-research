#!/usr/bin/env python3
"""Filter and aggregate RFC-style CSV files."""

from __future__ import annotations

import argparse
import csv
from decimal import Decimal, DecimalException, InvalidOperation, localcontext
import json
import sys
from collections.abc import Sequence
from pathlib import Path


class CsvInsightsError(Exception):
    """An expected, user-facing input or validation error."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter CSV rows and optionally calculate grouped sums or averages.",
        allow_abbrev=False,
    )
    parser.add_argument("input", metavar="INPUT.csv", help="CSV file to analyze")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="keep rows whose column exactly matches value; may be repeated",
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


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as source:
            reader = csv.reader(source, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                raise CsvInsightsError("input CSV is empty") from None
            except csv.Error as exc:
                raise CsvInsightsError(f"malformed CSV header: {exc}") from exc

            if not headers:
                raise CsvInsightsError("CSV header is empty")
            empty_positions = [str(index) for index, name in enumerate(headers, 1) if not name]
            if empty_positions:
                raise CsvInsightsError(
                    "CSV headers must be non-empty "
                    f"(empty header at column {', '.join(empty_positions)})"
                )

            duplicates = sorted({name for name in headers if headers.count(name) > 1})
            if duplicates:
                formatted = ", ".join(repr(name) for name in duplicates)
                raise CsvInsightsError(f"CSV headers must be unique (duplicate: {formatted})")

            rows: list[tuple[int, dict[str, str]]] = []
            try:
                for record_number, fields in enumerate(reader, start=2):
                    if len(fields) != len(headers):
                        raise CsvInsightsError(
                            f"row {record_number} has {len(fields)} fields; "
                            f"expected {len(headers)}"
                        )
                    rows.append((record_number, dict(zip(headers, fields))))
            except csv.Error as exc:
                # csv.reader.line_num is useful when a malformed record spans lines.
                raise CsvInsightsError(
                    f"malformed CSV near line {reader.line_num}: {exc}"
                ) from exc
    except CsvInsightsError:
        raise
    except UnicodeError as exc:
        raise CsvInsightsError(f"input is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise CsvInsightsError(f"cannot read {str(path)!r}: {exc}") from exc

    return headers, rows


def require_column(column: str, headers: Sequence[str], option: str) -> None:
    if column not in headers:
        raise CsvInsightsError(f"unknown column {column!r} for {option}")


def decimal_cell(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: numeric value is blank"
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        ) from exc
    if not number.is_finite():
        raise CsvInsightsError(
            f"row {record_number}, column {column!r}: invalid numeric value {value!r}"
        )
    return number


def decimal_string(number: Decimal) -> str:
    """Return a non-exponential decimal representation without redundant zeros."""
    if number == 0:
        return "0"
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def decimal_sum(values: Sequence[Decimal]) -> Decimal:
    """Sum finite Decimals without rounding significant input digits."""
    if not values:
        return Decimal(0)
    # Addition is context-sensitive. Reserve enough significant digits for the
    # widest integer/fractional span plus carry digits introduced by addition.
    least_exponent = min(number.as_tuple().exponent for number in values)
    greatest_adjusted = max(number.adjusted() for number in values)
    required_digits = max(1, greatest_adjusted - least_exponent + 1)
    required_digits += len(str(len(values)))
    with localcontext() as context:
        context.prec = max(28, required_digits)
        return sum(values, Decimal(0))


def aggregate_rows(
    rows: Sequence[tuple[int, dict[str, str]]],
    group_column: str,
    sum_column: str | None,
    avg_column: str | None,
) -> tuple[list[str], list[dict[str, str]]]:
    output_headers = [group_column]
    if sum_column is not None:
        output_headers.append(f"sum_{sum_column}")
    if avg_column is not None:
        output_headers.append(f"avg_{avg_column}")

    # Values are retained until output so averages use Decimal division rather
    # than binary floating point.
    groups: dict[str, dict[str, list[Decimal]]] = {}
    for record_number, row in rows:
        group = groups.setdefault(row[group_column], {"sum": [], "avg": []})
        if sum_column is not None:
            group["sum"].append(decimal_cell(row[sum_column], record_number, sum_column))
        if avg_column is not None:
            group["avg"].append(decimal_cell(row[avg_column], record_number, avg_column))

    output_rows: list[dict[str, str]] = []
    try:
        for group_value in sorted(groups):
            values = groups[group_value]
            result = {group_column: group_value}
            if sum_column is not None:
                result[f"sum_{sum_column}"] = decimal_string(decimal_sum(values["sum"]))
            if avg_column is not None:
                total = decimal_sum(values["avg"])
                # Preserve all significant digits of large finite totals while
                # retaining Decimal's conventional 28 digits for recurring
                # quotients such as 1 / 3.
                with localcontext() as context:
                    context.prec = max(28, len(total.as_tuple().digits))
                    average = total / Decimal(len(values["avg"]))
                result[f"avg_{avg_column}"] = decimal_string(average)
            output_rows.append(result)
    except DecimalException as exc:
        raise CsvInsightsError(f"numeric aggregation failed: {exc}") from exc

    return output_headers, output_rows


def write_output(
    headers: Sequence[str], rows: Sequence[dict[str, str]], output_format: str
) -> None:
    if output_format == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=headers,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(args: argparse.Namespace) -> None:
    filters = parse_filters(args.where)
    if (args.sum_column is not None or args.avg_column is not None) and not args.group_by:
        raise CsvInsightsError("--sum and --avg require --group-by")

    headers, numbered_rows = read_csv(Path(args.input))
    for column, _ in filters:
        require_column(column, headers, "--where")
    if args.group_by is not None:
        require_column(args.group_by, headers, "--group-by")
    if args.sum_column is not None:
        require_column(args.sum_column, headers, "--sum")
    if args.avg_column is not None:
        require_column(args.avg_column, headers, "--avg")

    aggregate_headers = [args.group_by]
    if args.sum_column is not None:
        aggregate_headers.append(f"sum_{args.sum_column}")
    if args.avg_column is not None:
        aggregate_headers.append(f"avg_{args.avg_column}")
    if len(aggregate_headers) != len(set(aggregate_headers)):
        raise CsvInsightsError("aggregation produces duplicate output column names")

    filtered = [
        (record_number, row)
        for record_number, row in numbered_rows
        if all(row[column] == value for column, value in filters)
    ]

    if args.sum_column is not None or args.avg_column is not None:
        output_headers, output_rows = aggregate_rows(
            filtered, args.group_by, args.sum_column, args.avg_column
        )
    else:
        output_headers = headers
        output_rows = [row for _, row in filtered]
    write_output(output_headers, output_rows, args.output)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except CsvInsightsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

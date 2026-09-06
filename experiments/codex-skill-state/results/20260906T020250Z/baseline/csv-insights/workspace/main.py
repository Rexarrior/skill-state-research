#!/usr/bin/env python3
"""CSV Insights: small, dependency-free CSV filtering and aggregation CLI."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from decimal import MAX_EMAX, MIN_EMIN, Decimal, DecimalException, localcontext
from pathlib import Path
from typing import TextIO


class UserError(Exception):
    """An input or command-line error that should be shown without a traceback."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UserError(message)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = ArgumentParser(
        prog="csv-insights",
        description="Filter and aggregate an RFC-style CSV file.",
    )
    parser.add_argument("input", metavar="INPUT.csv", help="input CSV file")
    parser.add_argument(
        "--where",
        action="append",
        default=[],
        metavar="COLUMN=VALUE",
        help="exact-match filter; may be repeated",
    )
    parser.add_argument("--group-by", metavar="COLUMN", help="column to group by")
    parser.add_argument("--sum", dest="sum_column", metavar="COLUMN", help="column to sum")
    parser.add_argument("--avg", dest="avg_column", metavar="COLUMN", help="column to average")
    parser.add_argument(
        "--output",
        choices=("json", "csv"),
        default="json",
        help="output format (default: json)",
    )
    args = parser.parse_args(argv)

    if (args.sum_column or args.avg_column) and not args.group_by:
        raise UserError("--sum and --avg require --group-by")
    if args.group_by and not (args.sum_column or args.avg_column):
        raise UserError("--group-by requires --sum or --avg")

    filters: list[tuple[str, str]] = []
    for expression in args.where:
        if "=" not in expression:
            raise UserError(
                f"malformed filter {expression!r}: expected COLUMN=VALUE"
            )
        column, value = expression.split("=", 1)
        if not column:
            raise UserError(
                f"malformed filter {expression!r}: column name must not be empty"
            )
        filters.append((column, value))
    args.filters = filters
    return args


def validate_header(header: list[str]) -> None:
    if not header:
        raise UserError("input has no header row")
    for position, name in enumerate(header, start=1):
        if name == "":
            raise UserError(f"header column {position} is empty")

    seen: set[str] = set()
    for name in header:
        if name in seen:
            raise UserError(f"duplicate header column: {name!r}")
        seen.add(name)


def require_columns(header: list[str], args: argparse.Namespace) -> None:
    known = set(header)
    requested: list[tuple[str, str]] = [
        ("filter", column) for column, _ in args.filters
    ]
    if args.group_by:
        requested.append(("group-by", args.group_by))
    if args.sum_column:
        requested.append(("sum", args.sum_column))
    if args.avg_column:
        requested.append(("avg", args.avg_column))

    for purpose, column in requested:
        if column not in known:
            raise UserError(f"unknown {purpose} column: {column!r}")

    generated = set()
    if args.sum_column:
        generated.add(f"sum_{args.sum_column}")
    if args.avg_column:
        generated.add(f"avg_{args.avg_column}")
    if args.group_by in generated:
        raise UserError(
            f"output column name collision for group-by column: {args.group_by!r}"
        )


def decimal_value(value: str, record_number: int, column: str) -> Decimal:
    if value == "":
        raise UserError(
            f"invalid numeric value at row {record_number}, column {column!r}: blank"
        )
    try:
        number = Decimal(value)
    except DecimalException:
        raise UserError(
            f"invalid numeric value at row {record_number}, "
            f"column {column!r}: {value!r}"
        ) from None
    if not number.is_finite():
        raise UserError(
            f"invalid numeric value at row {record_number}, "
            f"column {column!r}: {value!r}"
        )
    return number


def format_decimal(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def add_decimals(left: Decimal, right: Decimal) -> Decimal:
    """Add finite decimals without the default context silently rounding them."""
    lowest_exponent = min(int(left.as_tuple().exponent), int(right.as_tuple().exponent))
    highest_position = max(left.adjusted(), right.adjusted(), 0)
    with localcontext() as context:
        context.prec = highest_position - lowest_exponent + 2
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return left + right


def average_decimal(total: Decimal, count: int) -> Decimal:
    # Preserve a large integer part and all input decimal places. Repeating
    # results use at least Decimal's usual 28 significant digits.
    exponent = int(total.as_tuple().exponent)
    precision = max(
        28,
        len(total.as_tuple().digits) + max(0, -exponent) + len(str(count)) + 2,
    )
    with localcontext() as context:
        context.prec = precision
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return total / Decimal(count)


def read_and_process(stream: TextIO, args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    # The stdlib defaults to a relatively small field limit; RFC-style CSV does
    # not impose that artificial cap.
    csv.field_size_limit(sys.maxsize)
    reader = csv.reader(stream, strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise UserError("input is empty") from None
    except csv.Error as exc:
        raise UserError(f"malformed CSV near line {reader.line_num}: {exc}") from None

    validate_header(header)
    require_columns(header, args)
    indexes = {name: index for index, name in enumerate(header)}

    aggregate = bool(args.sum_column or args.avg_column)
    if aggregate:
        # group -> [sum, count] for each requested operation.  Keeping separate
        # accumulators also handles --sum X --avg Y without special cases.
        groups: dict[str, dict[str, Decimal | int]] = {}
    else:
        rows: list[dict[str, str]] = []

    try:
        for record_number, fields in enumerate(reader, start=2):
            if len(fields) != len(header):
                raise UserError(
                    f"row {record_number} has {len(fields)} fields; "
                    f"expected {len(header)}"
                )

            if any(fields[indexes[column]] != value for column, value in args.filters):
                continue

            if not aggregate:
                rows.append(dict(zip(header, fields)))
                continue

            group = fields[indexes[args.group_by]]
            state = groups.setdefault(group, {})
            if args.sum_column:
                number = decimal_value(
                    fields[indexes[args.sum_column]], record_number, args.sum_column
                )
                state["sum"] = add_decimals(
                    state.get("sum", Decimal(0)), number
                )
            if args.avg_column:
                number = decimal_value(
                    fields[indexes[args.avg_column]], record_number, args.avg_column
                )
                state["avg_sum"] = add_decimals(
                    state.get("avg_sum", Decimal(0)), number
                )
                state["avg_count"] = int(state.get("avg_count", 0)) + 1
    except csv.Error as exc:
        raise UserError(f"malformed CSV near line {reader.line_num}: {exc}") from None

    if not aggregate:
        return header, rows

    output_header = [args.group_by]
    if args.sum_column:
        output_header.append(f"sum_{args.sum_column}")
    if args.avg_column:
        output_header.append(f"avg_{args.avg_column}")

    output_rows: list[dict[str, str]] = []
    for group in sorted(groups):
        state = groups[group]
        result = {args.group_by: group}
        if args.sum_column:
            result[f"sum_{args.sum_column}"] = format_decimal(state["sum"])
        if args.avg_column:
            average = average_decimal(state["avg_sum"], int(state["avg_count"]))
            result[f"avg_{args.avg_column}"] = format_decimal(average)
        output_rows.append(result)
    return output_header, output_rows


def emit(header: list[str], rows: list[dict[str, str]], output: str) -> None:
    if output == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    # Avoid doubling CR characters on platforms whose text streams otherwise
    # translate newlines; the writer supplies RFC-compatible CRLF itself.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="")
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=header,
        extrasaction="raise",
        lineterminator="\r\n",
    )
    writer.writeheader()
    writer.writerows(rows)


def run(argv: Sequence[str]) -> int:
    try:
        args = parse_args(argv)
        try:
            with Path(args.input).open("r", encoding="utf-8", newline="") as stream:
                header, rows = read_and_process(stream, args)
        except OSError as exc:
            detail = exc.strerror or str(exc)
            raise UserError(f"cannot read {args.input!r}: {detail}") from None
        except UnicodeError as exc:
            raise UserError(f"input is not valid UTF-8: {exc}") from None
        emit(header, rows, args.output)
        return 0
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def main() -> None:
    raise SystemExit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()

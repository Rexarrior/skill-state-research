"""Dependency-free CSV filtering and grouped decimal analytics."""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path


class InputError(ValueError):
    """An actionable input or usage error."""


NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def number(value: str, row: int, column: str) -> Decimal:
    text = value.strip()
    if not NUMBER.fullmatch(text):
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {value!r}")
    try:
        result = Decimal(text)
    except InvalidOperation as exc:
        raise InputError(f"row {row}, column {column!r}: invalid numeric value {value!r}") from exc
    if not result.is_finite():
        raise InputError(f"row {row}, column {column!r}: non-finite numeric value")
    return result


def add_exact(left: Decimal, right: Decimal) -> Decimal:
    # Accommodate all integer and fractional digits, plus a possible carry.
    precision = max(left.adjusted(), right.adjusted()) - min(
        left.as_tuple().exponent, right.as_tuple().exponent
    ) + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        context.Emax = max(context.Emax, left.adjusted() + 2, right.adjusted() + 2)
        context.Emin = min(context.Emin, left.as_tuple().exponent, right.as_tuple().exponent)
        return left + right


def decimal_text(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def average(total: Decimal, count: int) -> Decimal:
    # Terminating averages retain every digit; repeating averages use at least
    # 28 significant digits (ROUND_HALF_EVEN, Decimal's default rounding).
    divisor = count
    twos = fives = 0
    while divisor % 2 == 0:
        divisor //= 2
        twos += 1
    while divisor % 5 == 0:
        divisor //= 5
        fives += 1
    with localcontext() as context:
        context.prec = max(28, len(total.as_tuple().digits) + max(twos, fives))
        context.Emax = max(context.Emax, total.adjusted() + 2)
        context.Emin = min(context.Emin, total.as_tuple().exponent - context.prec)
        return total / Decimal(count)


def analyze(args: argparse.Namespace) -> tuple[list[str], list[dict[str, str]]]:
    filters = []
    for expression in args.where:
        column, separator, value = expression.partition("=")
        if not separator or not column:
            raise InputError(f"malformed filter {expression!r}; expected COLUMN=VALUE")
        filters.append((column, value))

    with Path(args.input).open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        try:
            headers = next(reader, None)
            if not headers or any(not header.strip() for header in headers):
                raise InputError("CSV must have non-empty headers")
            if len(set(headers)) != len(headers):
                raise InputError("CSV headers must be unique")
            requested = [column for column, _ in filters]
            requested += [column for column in (args.group_by, args.sum, args.avg) if column is not None]
            for column in requested:
                if column not in headers:
                    raise InputError(f"unknown column {column!r}")
            output_headers = headers
            if args.group_by is not None:
                output_headers = [args.group_by]
                if args.sum is not None:
                    output_headers.append(f"sum_{args.sum}")
                if args.avg is not None:
                    output_headers.append(f"avg_{args.avg}")
                if len(set(output_headers)) != len(output_headers):
                    raise InputError("group and aggregate output column names collide")
            rows = []
            groups: dict[str, tuple[int, dict[str, Decimal]]] = {}
            numeric_columns = list(dict.fromkeys(
                column for column in (args.sum, args.avg) if column is not None
            ))
            for row_number, fields in enumerate(reader, start=2):
                if len(fields) != len(headers):
                    raise InputError(f"row {row_number}: expected {len(headers)} fields, got {len(fields)}")
                row = dict(zip(headers, fields))
                if not all(row[column] == value for column, value in filters):
                    continue
                if args.group_by is None:
                    rows.append(row)
                    continue
                key = row[args.group_by]
                count, totals = groups.get(key, (0, {column: Decimal(0) for column in numeric_columns}))
                for column in numeric_columns:
                    totals[column] = add_exact(totals[column], number(row[column], row_number, column))
                groups[key] = (count + 1, totals)
            for key in sorted(groups):
                count, totals = groups[key]
                row = {args.group_by: key}
                if args.sum is not None:
                    row[f"sum_{args.sum}"] = decimal_text(totals[args.sum])
                if args.avg is not None:
                    row[f"avg_{args.avg}"] = decimal_text(average(totals[args.avg], count))
                rows.append(row)
            return output_headers, rows
        except csv.Error as exc:
            raise InputError(f"malformed CSV near line {reader.line_num}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("input", metavar="INPUT.csv")
    parser.add_argument("--where", action="append", default=[], metavar="COLUMN=VALUE")
    parser.add_argument("--group-by", metavar="COLUMN")
    parser.add_argument("--sum", metavar="COLUMN")
    parser.add_argument("--avg", metavar="COLUMN")
    parser.add_argument("--output", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    if (args.sum is not None or args.avg is not None) and args.group_by is None:
        parser.error("--sum and --avg require --group-by")
    try:
        headers, rows = analyze(args)
        if args.output == "json":
            json.dump(rows, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            writer = csv.DictWriter(sys.stdout, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
    except (InputError, OSError, UnicodeError, ArithmeticError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

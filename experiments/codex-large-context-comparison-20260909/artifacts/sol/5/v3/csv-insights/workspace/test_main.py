from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_preserves_filtered_rows_and_parses_quoted_fields(self) -> None:
        result = self.invoke(
            'name,team,note\r\n"Ada, A.",red,"first\nsecond"\r\nBob,blue,plain\r\n',
            "--where",
            "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "team": "red", "note": "first\nsecond"}],
        )

    def test_repeated_filters_combine_with_and(self) -> None:
        result = self.invoke(
            "kind,place,value\na,x,1\na,y,2\nb,x,3\n",
            "--where",
            "kind=a",
            "--where",
            "place=x",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["kind", "place", "value"], ["a", "x", "1"]])

    def test_sum_and_average_are_sorted_and_decimal_exact(self) -> None:
        result = self.invoke(
            "group,amount,score\nz,0.1,2\na,1.20,2\nz,0.2,3\na,1.80,3\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "3", "avg_score": "2.5"},
                {"group": "z", "sum_amount": "0.3", "avg_score": "2.5"},
            ],
        )

    def test_empty_result_still_emits_csv_header(self) -> None:
        result = self.invoke("a,b\n1,2\n", "--where", "a=missing", "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "a,b\n")

    def test_large_decimal_sum_is_not_rounded_by_default_context(self) -> None:
        result = self.invoke(
            "group,amount\na,9999999999999999999999999999\na,1\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "a", "sum_amount": "10000000000000000000000000000"}],
        )

    def test_invalid_numeric_cell_identifies_row_and_column(self) -> None:
        result = self.invoke(
            "group,amount\na,nope\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_rejects_bad_headers_row_width_filters_and_columns(self) -> None:
        cases = [
            (("a,a\n1,2\n",), "unique"),
            (("a,b\n1\n",), "fields"),
            (("a\n1\n", "--where", "broken"), "malformed filter"),
            (("a\n1\n", "--where", "missing=x"), "unknown column"),
        ]
        for invocation, message in cases:
            with self.subTest(message=message):
                result = self.invoke(*invocation)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_aggregation_requires_group_by(self) -> None:
        result = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()

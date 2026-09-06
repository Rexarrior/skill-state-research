"""Regression tests for the CSV Insights command-line interface."""

from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRAM = ROOT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def run_tool(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before, "the input file was modified")
            return result

    def test_json_preserves_quoted_commas_newlines_and_input_order(self) -> None:
        result = self.run_tool(
            'name,team,note\r\n"Ada, A",red,"first\r\nsecond"\r\nBob,blue,plain\r\n',
            "--where",
            "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A", "team": "red", "note": "first\r\nsecond"}],
        )

    def test_multiple_filters_use_and_and_allow_equals_in_value(self) -> None:
        result = self.run_tool(
            "kind,value,tag\nA,x=y,one\nA,x=y,two\nB,x=y,one\n",
            "--where",
            "kind=A",
            "--where",
            "value=x=y",
            "--where",
            "tag=one",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"kind": "A", "value": "x=y", "tag": "one"}])

    def test_sum_avg_sorting_and_minimal_exact_decimals(self) -> None:
        result = self.run_tool(
            "group,amount,score\nz,0.1,1\na,0.2,2\nz,0.2,2\na,2.80,3\n",
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
                {"group": "z", "sum_amount": "0.3", "avg_score": "1.5"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self) -> None:
        result = self.run_tool(
            'name,note\r\n"Doe, Jane","line 1\r\nline 2"\r\n',
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines(keepends=True))),
            [["name", "note"], ["Doe, Jane", "line 1\nline 2"]],
        )

    def test_all_zero_aggregates(self) -> None:
        result = self.run_tool(
            "group,amount\na,0\na,0.00\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "a", "sum_amount": "0", "avg_amount": "0"}],
        )

    def test_invalid_inputs_fail_with_useful_errors(self) -> None:
        cases = [
            ("a,a\n1,2\n", (), "unique"),
            ("a,b\n1\n", (), "row 2"),
            ("a,b\n1,2\n", ("--where", "missing=x"), "unknown column"),
            ("a,b\n1,2\n", ("--where", "broken"), "malformed filter"),
            ("g,n\na,nope\n", ("--group-by", "g", "--sum", "n"), "row 2"),
            ("g,n\na,\n", ("--group-by", "g", "--avg", "n"), "blank"),
            ("g,n\na,1\n", ("--sum", "n"), "require --group-by"),
            ('a,b\n"unterminated,2\n', (), "malformed CSV"),
        ]
        for content, arguments, expected in cases:
            with self.subTest(expected=expected):
                result = self.run_tool(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()

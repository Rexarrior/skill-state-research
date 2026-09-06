from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsCliTests(unittest.TestCase):
    def run_cli(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before, "input file was modified")
            return result

    def test_preserves_filtered_rows_and_parses_quoted_fields(self) -> None:
        result = self.run_cli(
            'name,region,note\r\n"Alice, A",east,"line 1\nline 2"\r\nBob,west,plain\r\n',
            "--where",
            "region=east",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Alice, A", "region": "east", "note": "line 1\nline 2"}],
        )

    def test_multiple_filters_use_and_and_allow_equals_in_value(self) -> None:
        result = self.run_cli(
            "a,b\n1,x=y\n1,z\n2,x=y\n",
            "--where",
            "a=1",
            "--where",
            "b=x=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x=y"}])

    def test_grouped_sum_and_average_are_sorted_and_plain(self) -> None:
        result = self.run_cli(
            "group,amount,score\nB,0.010,2\nA,1.20,2\nB,0.02,3\nA,1.8,3\n",
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
                {"group": "A", "sum_amount": "3", "avg_score": "2.5"},
                {"group": "B", "sum_amount": "0.03", "avg_score": "2.5"},
            ],
        )

    def test_csv_output_has_header_and_rfc_quoting(self) -> None:
        result = self.run_cli('name,note\nA,"x,y"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["A", "x,y"]])

    def test_wrong_width_duplicate_and_empty_headers_are_errors(self) -> None:
        cases = [
            ("a,b\n1\n", "row 2"),
            ("a,a\n1,2\n", "unique"),
            ("a,\n1,2\n", "must not be empty"),
        ]
        for content, message in cases:
            with self.subTest(content=content):
                result = self.run_cli(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_unknown_column_and_malformed_filter_are_errors(self) -> None:
        for arguments, message in [
            (("--where", "missing=x"), "unknown column"),
            (("--where", "broken"), "malformed filter"),
            (("--where", "=x"), "column name"),
        ]:
            with self.subTest(arguments=arguments):
                result = self.run_cli("a\n1\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_invalid_numeric_value_reports_row_and_column(self) -> None:
        for value in ("", "nope", "NaN", "Infinity"):
            with self.subTest(value=value):
                result = self.run_cli(
                    f"group,value\nA,{value}\n",
                    "--group-by",
                    "group",
                    "--sum",
                    "value",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2", result.stderr)
                self.assertIn("value", result.stderr)

    def test_aggregation_flags_require_a_complete_operation(self) -> None:
        for arguments in (("--sum", "value"), ("--group-by", "group")):
            with self.subTest(arguments=arguments):
                result = self.run_cli("group,value\nA,1\n", *arguments)
                self.assertNotEqual(result.returncode, 0)

    def test_malformed_quoted_csv_is_an_error(self) -> None:
        result = self.run_cli('a,b\n"unterminated,x\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)


if __name__ == "__main__":
    unittest.main()

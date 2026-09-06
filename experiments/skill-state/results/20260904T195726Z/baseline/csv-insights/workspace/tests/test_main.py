import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class CliTests(unittest.TestCase):
    def run_cli(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_quoted_fields_and_embedded_newlines(self):
        result = self.run_cli(
            'name,note,kind\nAlice,"hello, world",x\nBob,"two\nlines",y\n',
            "--where",
            "kind=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "two\nlines", "kind": "y"}],
        )

    def test_aggregation_is_sorted_and_uses_plain_decimals(self):
        result = self.run_cli(
            "team,amount\nb,1.20\na,2\nb,1.30\na,3\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "5", "avg_amount": "2.5"},
                {"team": "b", "sum_amount": "2.5", "avg_amount": "1.25"},
            ],
        )

    def test_large_decimal_sum_is_not_rounded(self):
        result = self.run_cli(
            "team,amount\na,1000000000000000000000000000000\na,1\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"team": "a", "sum_amount": "1000000000000000000000000000001"}],
        )

    def test_csv_output_has_header_and_rfc_quoting(self):
        result = self.run_cli('name,note\nAlice,"hello, world"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["name", "note"], ["Alice", "hello, world"]],
        )

    def test_bad_row_width_fails(self):
        result = self.run_cli("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_invalid_numeric_value_identifies_row_and_column(self):
        result = self.run_cli(
            "team,amount\na,nope\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_duplicate_header_unknown_column_and_malformed_filter_fail(self):
        cases = [
            ("a,a\n1,2\n", (), "duplicate"),
            ("a\n1\n", ("--where", "missing=x"), "unknown column"),
            ("a\n1\n", ("--where", "broken"), "malformed filter"),
        ]
        for content, arguments, message in cases:
            with self.subTest(message=message):
                result = self.run_cli(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()

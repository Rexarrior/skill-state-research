import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
PROGRAM = ROOT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(contents, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(input_path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_exactly_and_preserves_embedded_csv_content(self):
        result = self.invoke(
            'name,note,status\r\n"Ada, A.","first\nsecond",yes\r\nBob,plain,no\r\n',
            "--where",
            "status=yes",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "note": "first\nsecond", "status": "yes"}],
        )

    def test_grouped_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "team,amount\r\nz,0.10\r\na,1.20\r\na,1.80\r\nz,0.20\r\n",
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
                {"team": "a", "sum_amount": "3", "avg_amount": "1.5"},
                {"team": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_quoted_and_has_header(self):
        result = self.invoke('name,note\r\nAda,"hello, world"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["name", "note"], ["Ada", "hello, world"]],
        )

    def test_bad_row_width_is_reported(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("expected 2", result.stderr)

    def test_invalid_number_identifies_logical_row_and_column(self):
        result = self.invoke(
            'group,note,value\nA,"two\nlines",wat\n',
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("column 'value'", result.stderr)

    def test_invalid_headers_filters_and_columns_fail(self):
        cases = [
            ("a,a\n1,2\n", (), "unique"),
            ("a,b\n1,2\n", ("--where", "broken"), "malformed filter"),
            ("a,b\n1,2\n", ("--where", "missing=x"), "unknown column"),
            ("a,b\n1,2\n", ("--sum", "b"), "require --group-by"),
        ]
        for contents, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(contents, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_rejects_non_rfc_bare_quote_and_non_finite_number(self):
        bad_quote = self.invoke('name\nAda"Lovelace\n')
        self.assertNotEqual(bad_quote.returncode, 0)
        self.assertIn("quote in unquoted field", bad_quote.stderr)

        non_finite = self.invoke(
            "group,value\nA,NaN\n", "--group-by", "group", "--sum", "value"
        )
        self.assertNotEqual(non_finite.returncode, 0)
        self.assertIn("row 2", non_finite.stderr)
        self.assertIn("invalid numeric", non_finite.stderr)

    def test_exact_sum_is_not_limited_by_decimal_context_precision(self):
        result = self.invoke(
            "group,value\nA,999999999999999999999999999999\nA,1\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout)[0]["sum_value"],
            "1000000000000000000000000000000",
        )


if __name__ == "__main__":
    unittest.main()

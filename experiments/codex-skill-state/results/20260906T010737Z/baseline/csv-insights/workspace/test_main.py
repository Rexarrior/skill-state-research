import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(contents, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(input_path), *arguments],
                capture_output=True,
                text=True,
                check=False,
            )

    def test_filters_quoted_and_multiline_fields(self):
        result = self.invoke(
            'name,team,note\r\n"Doe, Jane",A,"first\nsecond"\r\nJohn,B,plain\r\n',
            "--where",
            "team=A",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Doe, Jane", "team": "A", "note": "first\nsecond"}],
        )

    def test_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "team,amount\r\nb,1.20\r\na,0.1\r\nb,2.30\r\na,0.2\r\n",
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
                {"team": "a", "sum_amount": "0.3", "avg_amount": "0.15"},
                {"team": "b", "sum_amount": "3.5", "avg_amount": "1.75"},
            ],
        )

    def test_sum_preserves_small_addend_beyond_default_decimal_precision(self):
        result = self.invoke(
            "team,amount\na,1e30\na,1\n",
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

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('name,note\r\n"Doe, Jane","hello, world"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["name", "note"], ["Doe, Jane", "hello, world"]],
        )

    def test_wrong_field_count_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("expected 2", result.stderr)

    def test_invalid_number_identifies_row_and_column(self):
        result = self.invoke(
            "team,amount\na,nope\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_duplicate_and_unknown_headers_are_errors(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        unknown = self.invoke("a,b\n1,2\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

    def test_empty_header_malformed_filter_and_missing_group_are_errors(self):
        empty_header = self.invoke("a,\n1,2\n")
        self.assertNotEqual(empty_header.returncode, 0)
        self.assertIn("must not be empty", empty_header.stderr)

        malformed_filter = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed_filter.returncode, 0)
        self.assertIn("COLUMN=VALUE", malformed_filter.stderr)

        missing_group = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

    def test_non_finite_number_is_an_error(self):
        result = self.invoke(
            "team,amount\na,NaN\n",
            "--group-by",
            "team",
            "--avg",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_malformed_csv_is_an_error(self):
        result = self.invoke('a,b\n"unterminated,2\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)


if __name__ == "__main__":
    unittest.main()

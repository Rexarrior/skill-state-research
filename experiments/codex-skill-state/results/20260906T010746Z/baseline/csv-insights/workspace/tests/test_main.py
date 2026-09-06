import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def run_tool(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            original_bytes = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), original_bytes)
            return result

    def test_filters_preserve_quoted_fields_and_order(self):
        result = self.run_tool(
            'name,note,status\r\nFirst,"comma, here",ok\r\nSecond,"two\nlines",ok\r\n',
            "--where",
            "status=ok",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "First", "note": "comma, here", "status": "ok"},
                {"name": "Second", "note": "two\nlines", "status": "ok"},
            ],
        )

    def test_grouped_decimal_sum_and_average(self):
        result = self.run_tool(
            "team,amount\nB,0.1\nA,1.20\nB,0.2\nA,2.80\n",
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
                {"team": "A", "sum_amount": "4", "avg_amount": "2"},
                {"team": "B", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_quoted_by_standard_writer(self):
        result = self.run_tool('name,note\nAlice,"hello, world"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["name", "note"], ["Alice", "hello, world"]],
        )

    def test_bad_numeric_value_identifies_record_and_column(self):
        result = self.run_tool(
            "team,amount\nA,nope\n", "--group-by", "team", "--sum", "amount"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2, column 'amount'", result.stderr)

    def test_rejects_duplicate_headers_and_short_rows(self):
        duplicate = self.run_tool("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("duplicate", duplicate.stderr)

        short = self.run_tool("a,b\n1\n")
        self.assertNotEqual(short.returncode, 0)
        self.assertIn("row 2", short.stderr)

    def test_unknown_column_and_malformed_filter_fail(self):
        unknown = self.run_tool("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

        malformed = self.run_tool("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_filters_combine_with_and_and_allow_equals_in_value(self):
        result = self.run_tool(
            "a,b\nx,one=1\nx,two\ny,one=1\n",
            "--where",
            "a=x",
            "--where",
            "b=one=1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "x", "b": "one=1"}])

    def test_rejects_malformed_quoted_csv_and_non_finite_decimal(self):
        malformed_csv = self.run_tool('a,b\n"unterminated,b\n')
        self.assertNotEqual(malformed_csv.returncode, 0)
        self.assertIn("malformed CSV", malformed_csv.stderr)

        non_finite = self.run_tool(
            "team,amount\nA,NaN\n", "--group-by", "team", "--avg", "amount"
        )
        self.assertNotEqual(non_finite.returncode, 0)
        self.assertIn("row 2, column 'amount'", non_finite.stderr)


if __name__ == "__main__":
    unittest.main()

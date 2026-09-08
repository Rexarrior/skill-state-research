import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def run_cli(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_preserve_rows_and_parse_quoted_fields(self):
        result = self.run_cli(
            'name,note,status\r\nAlice,"hello, world",yes\r\nBob,"two\nlines",no\r\n',
            "--where",
            "status=no",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "two\nlines", "status": "no"}],
        )

    def test_sum_and_average_are_grouped_sorted_and_decimal(self):
        result = self.run_cli(
            "team,amount\r\nz,0.10\r\na,1.20\r\na,2.30\r\nz,0.20\r\n",
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
                {"team": "a", "sum_amount": "3.5", "avg_amount": "1.75"},
                {"team": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_quoted(self):
        result = self.run_cli('name,note\r\nA,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["name", "note"], ["A", "x,y"]],
        )

    def test_invalid_number_identifies_record_and_column(self):
        result = self.run_cli(
            "team,amount\ngood,1\nbad,nope\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_rejects_duplicate_headers_and_short_rows(self):
        duplicate = self.run_cli("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        short = self.run_cli("a,b\n1\n")
        self.assertNotEqual(short.returncode, 0)
        self.assertIn("row 2", short.stderr)
        self.assertIn("expected 2", short.stderr)

        empty_header = self.run_cli("\n")
        self.assertNotEqual(empty_header.returncode, 0)
        self.assertIn("header", empty_header.stderr)

    def test_rejects_unknown_columns_and_aggregation_without_group(self):
        unknown = self.run_cli("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

        no_group = self.run_cli("a\n1\n", "--sum", "a")
        self.assertNotEqual(no_group.returncode, 0)
        self.assertIn("require --group-by", no_group.stderr)

        collision = self.run_cli(
            "sum_value,value\ng,1\n",
            "--group-by",
            "sum_value",
            "--sum",
            "value",
        )
        self.assertNotEqual(collision.returncode, 0)
        self.assertIn("conflicts", collision.stderr)

    def test_rejects_malformed_filter_and_csv(self):
        bad_filter = self.run_cli("a\n1\n", "--where", "a")
        self.assertNotEqual(bad_filter.returncode, 0)
        self.assertIn("COLUMN=VALUE", bad_filter.stderr)

        bad_csv = self.run_cli('a,b\n1,"unterminated\n')
        self.assertNotEqual(bad_csv.returncode, 0)
        self.assertIn("malformed CSV", bad_csv.stderr)

    def test_large_sum_does_not_round_at_default_decimal_precision(self):
        result = self.run_cli(
            "group,value\nx,10000000000000000000000000000\nx,0.01\n",
            "--group-by",
            "group",
            "--sum",
            "value",
            "--avg",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {
                    "group": "x",
                    "sum_value": "10000000000000000000000000000.01",
                    "avg_value": "5000000000000000000000000000.005",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()

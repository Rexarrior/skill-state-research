import csv
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
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_preserve_rows_and_handle_embedded_newline(self):
        result = self.invoke(
            'name,team,note\r\n"Ada, A",red,"first\nsecond"\r\nBob,blue,ok\r\n',
            "--where",
            "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A", "team": "red", "note": "first\nsecond"}],
        )

    def test_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "team,amount\r\nz,1.20\r\na,2\r\nz,1.30\r\n",
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
                {"team": "a", "sum_amount": "2", "avg_amount": "2"},
                {"team": "z", "sum_amount": "2.5", "avg_amount": "1.25"},
            ],
        )

    def test_csv_output_quotes_values(self):
        result = self.invoke('name,note\r\nAda,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["Ada", "x,y"]])

    def test_wrong_width_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_blank_header_line_is_an_error(self):
        result = self.invoke("\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("headers", result.stderr)

    def test_invalid_number_identifies_row_and_column(self):
        result = self.invoke(
            "team,amount\nx,wat\n", "--group-by", "team", "--sum", "amount"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_column_named_count_can_be_aggregated(self):
        result = self.invoke(
            "team,count\nx,2\nx,4\n", "--group-by", "team", "--avg", "count"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"team": "x", "avg_count": "3"}])

    def test_malformed_quoted_csv_is_an_error(self):
        result = self.invoke('a,b\n"unterminated,b\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error:", result.stderr)

    def test_long_decimals_are_summed_without_context_rounding(self):
        result = self.invoke(
            "team,value\nx,123456789012345678901234567890.1\nx,0.2\n",
            "--group-by",
            "team",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"team": "x", "sum_value": "123456789012345678901234567890.3"}],
        )

    def test_duplicate_header_unknown_column_and_malformed_filter_are_errors(self):
        cases = [
            (("a,a\n1,2\n",), "unique"),
            (("a\n1\n", "--where", "missing=x"), "unknown column"),
            (("a\n1\n", "--where", "broken"), "malformed filter"),
        ]
        for invocation, message in cases:
            with self.subTest(message=message):
                result = self.invoke(*invocation)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()

import csv
import io
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
            path = Path(directory) / "input.csv"
            path.write_text(contents, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_commas_and_embedded_newlines(self):
        result = self.invoke(
            'name,note,kind\r\n"Ada, A.","first\nsecond",x\r\nBob,plain,y\r\n',
            "--where", "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"name": "Ada, A.", "note": "first\nsecond", "kind": "x"}
        ])

    def test_grouped_sum_and_average_are_sorted_and_exact(self):
        result = self.invoke(
            "group,amount\r\nb,0.1\r\na,1.20\r\nb,0.2\r\na,3.80\r\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"group": "a", "sum_amount": "5", "avg_amount": "2.5"},
            {"group": "b", "sum_amount": "0.3", "avg_amount": "0.15"},
        ])

    def test_sum_is_not_rounded_by_decimal_context(self):
        result = self.invoke(
            "group,amount\r\na,1000000000000000000000000000000\r\na,1\r\n",
            "--group-by", "group", "--sum", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]["sum_amount"],
                         "1000000000000000000000000000001")

    def test_csv_output_quotes_fields(self):
        result = self.invoke('name,note\r\n"A,B","line 1\nline 2"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [
            ["name", "note"], ["A,B", "line 1\nline 2"]
        ])

    def test_bad_row_width_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_duplicate_and_empty_headers_are_errors(self):
        for contents in ("a,a\n1,2\n", "a,\n1,2\n"):
            with self.subTest(contents=contents):
                result = self.invoke(contents)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("header", result.stderr)

    def test_invalid_numeric_cell_identifies_row_and_column(self):
        result = self.invoke(
            "g,n\na,wat\n", "--group-by", "g", "--sum", "n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("column 'n'", result.stderr)

    def test_unknown_column_and_malformed_filter_are_errors(self):
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        malformed = self.invoke("a\n1\n", "--where", "oops")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_aggregation_requires_group_by(self):
        result = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()

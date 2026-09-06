import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content, *args):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *args],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before)
            return result

    def test_filter_preserves_order_and_parses_quoted_records(self):
        result = self.invoke(
            'name,note,kind\r\n"Alice","hello, world",x\r\n"Bob","two\nlines",y\r\n',
            "--where", "kind=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "two\nlines", "kind": "y"}],
        )

    def test_sum_and_average_are_exact_sorted_and_minimal(self):
        result = self.invoke(
            "group,amount\nB,0.1\nA,1.00\nB,0.2\nA,2.00\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "A", "sum_amount": "3", "avg_amount": "1.5"},
                {"group": "B", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_quotes_values(self):
        result = self.invoke('name,note\nA,"hello, world"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["name", "note"], ["A", "hello, world"]])

    def test_wrong_field_count_is_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_duplicate_or_empty_headers_are_errors(self):
        for content in ("a,a\n1,2\n", "a,\n1,2\n"):
            with self.subTest(content=content):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("header", result.stderr)

    def test_unknown_column_and_malformed_filter_are_errors(self):
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        malformed = self.invoke("a\n1\n", "--where", "oops")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_blank_invalid_and_nonfinite_numbers_are_errors(self):
        for value in ("", "nope", "NaN", "Infinity"):
            with self.subTest(value=value):
                result = self.invoke(
                    f"group,value\nA,{value}\n", "--group-by", "group", "--sum", "value"
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'value'", result.stderr)

    def test_aggregation_requires_group_by(self):
        result = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()

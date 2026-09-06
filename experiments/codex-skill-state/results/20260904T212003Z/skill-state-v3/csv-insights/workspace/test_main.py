import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(contents, encoding="utf-8", newline="")
            before = input_path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(input_path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(input_path.read_bytes(), before)
            return result

    def test_filter_preserves_order_and_parses_quoted_records(self):
        result = self.invoke(
            'name,note,team\r\n"Ada","first, item","A"\r\n'
            '"Lin","two\nlines","B"\r\n"Jo","last","A"\r\n',
            "--where",
            "team=A",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Ada", "note": "first, item", "team": "A"},
                {"name": "Jo", "note": "last", "team": "A"},
            ],
        )

    def test_multiple_filters_use_and_and_allow_equals_in_value(self):
        result = self.invoke(
            "kind,value\na,x=y\na,z\nb,x=y\n",
            "--where",
            "kind=a",
            "--where",
            "value=x=y",
        )
        self.assertEqual(json.loads(result.stdout), [{"kind": "a", "value": "x=y"}])

    def test_sum_avg_sorting_and_minimal_exact_decimals(self):
        result = self.invoke(
            "group,amount\nz,0.1\na,1.00\nz,0.2\na,2\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout,
            '[{"group": "a", "sum_amount": 3, "avg_amount": 1.5}, '
            '{"group": "z", "sum_amount": 0.3, "avg_amount": 0.15}]\n',
        )

    def test_csv_output_is_quoted_and_has_header(self):
        result = self.invoke('name,note\n"A, B","line 1\nline 2"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        parsed = list(csv.reader(io.StringIO(result.stdout, newline="")))
        self.assertEqual(parsed, [["name", "note"], ["A, B", "line 1\nline 2"]])

    def test_bad_row_width_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("expected 2", result.stderr)

    def test_duplicate_and_empty_headers_are_errors(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        empty = self.invoke("a,\n1,2\n")
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("non-empty", empty.stderr)

    def test_bad_numeric_value_identifies_row_and_column(self):
        result = self.invoke(
            "group,amount\na,nope\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("'amount'", result.stderr)

    def test_argument_and_column_errors(self):
        missing_group = self.invoke("a,b\nx,1\n", "--sum", "b")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)
        unknown = self.invoke("a,b\nx,1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        malformed = self.invoke("a,b\nx,1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)


if __name__ == "__main__":
    unittest.main()

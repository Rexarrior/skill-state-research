import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_data_and_order(self):
        result = self.invoke(
            'name,kind,note\n"Doe, Jane",x,"first\nline"\nBob,y,last\nAnn,x,third\n',
            "--where", "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Doe, Jane", "kind": "x", "note": "first\nline"},
                {"name": "Ann", "kind": "x", "note": "third"},
            ],
        )

    def test_grouped_sum_and_average_are_sorted_decimal_strings(self):
        result = self.invoke(
            "group,amount\nb,0.10\na,1.20\nb,0.20\na,1.30\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "2.5", "avg_amount": "1.25"},
                {"group": "b", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('name,note\n"Doe, Jane","two\nlines"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines(keepends=True))), [["name", "note"], ["Doe, Jane", "two\nlines"]])

    def test_wrong_width_and_invalid_number_fail_usefully(self):
        width = self.invoke("a,b\n1\n")
        self.assertNotEqual(width.returncode, 0)
        self.assertIn("row 2", width.stderr)
        number = self.invoke("g,n\nx,nope\n", "--group-by", "g", "--sum", "n")
        self.assertNotEqual(number.returncode, 0)
        self.assertIn("row 2", number.stderr)
        self.assertIn("'n'", number.stderr)

    def test_duplicate_headers_unknown_columns_and_bad_filters_fail(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown", unknown.stderr)
        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed", malformed.stderr)

    def test_aggregation_requires_group(self):
        result = self.invoke("n\n1\n", "--sum", "n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()

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
            source = Path(directory) / "input.csv"
            source.write_text(contents, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_fields_and_order(self):
        result = self.invoke(
            'name,team,note\r\n"Alice, A",red,"first\nline"\r\nBob,blue,last\r\n',
            "--where", "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"name": "Alice, A", "team": "red", "note": "first\nline"}
        ])

    def test_sum_and_average_are_decimal_and_sorted(self):
        result = self.invoke(
            "group,amount,count\r\nz,0.1,1\r\na,2.00,2\r\nz,0.2,2\r\n",
            "--group-by", "group", "--sum", "amount", "--avg", "count",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"group": "a", "sum_amount": "2", "avg_count": "2"},
            {"group": "z", "sum_amount": "0.3", "avg_count": "1.5"},
        ])

    def test_csv_output_is_parseable(self):
        result = self.invoke('name,note\r\nA,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["A", "x,y"]])

    def test_wrong_width_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_invalid_number_names_row_and_column(self):
        result = self.invoke("g,n\na,nope\n", "--group-by", "g", "--sum", "n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("column 'n'", result.stderr)

    def test_unknown_column_and_malformed_filter_are_errors(self):
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        malformed = self.invoke("a\n1\n", "--where", "broken")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)


if __name__ == "__main__":
    unittest.main()

import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def run_cli(self, content, *args):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *args],
                text=True,
                capture_output=True,
            )

    def test_filters_quoted_fields_and_embedded_newlines(self):
        result = self.run_cli(
            'name,note,kind\r\nAlice,"one, two",x\r\nBob,"line 1\nline 2",y\r\n',
            "--where", "kind=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"name": "Bob", "note": "line 1\nline 2", "kind": "y"}])

    def test_aggregate_sorted_and_decimal_output(self):
        result = self.run_cli(
            "group,value\nb,0.1\na,1.00\nb,0.2\na,2\n",
            "--group-by", "group", "--sum", "value", "--avg", "value",
            "--output", "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = list(csv.DictReader(result.stdout.splitlines()))
        self.assertEqual(rows, [
            {"group": "a", "sum_value": "3", "avg_value": "1.5"},
            {"group": "b", "sum_value": "0.3", "avg_value": "0.15"},
        ])

    def test_bad_width_and_numeric_value_are_errors(self):
        width = self.run_cli("a,b\n1\n")
        self.assertNotEqual(width.returncode, 0)
        self.assertIn("row 2", width.stderr)
        numeric = self.run_cli("g,n\nx,nope\n", "--group-by", "g", "--sum", "n")
        self.assertNotEqual(numeric.returncode, 0)
        self.assertIn("row 2, column 'n'", numeric.stderr)

    def test_header_and_argument_validation(self):
        duplicate = self.run_cli("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        unknown = self.run_cli("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        malformed = self.run_cli("a\n1\n", "--where", "broken")
        self.assertNotEqual(malformed.returncode, 0)
        missing_group = self.run_cli("a\n1\n", "--sum", "a")
        self.assertNotEqual(missing_group.returncode, 0)


if __name__ == "__main__":
    unittest.main()

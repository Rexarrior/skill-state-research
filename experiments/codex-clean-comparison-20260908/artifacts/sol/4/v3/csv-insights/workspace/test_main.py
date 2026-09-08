import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent
PROGRAM = ROOT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content, *args):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8", newline="")
            before = path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(path), *args],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(path.read_bytes(), before, "input was modified")
            return result

    def test_filter_preserves_embedded_commas_newlines_and_order(self):
        result = self.invoke(
            'id,kind,note\r\n1,x,"hello, world"\r\n2,y,"two\r\nlines"\r\n3,x,last\r\n',
            "--where", "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"id": "1", "kind": "x", "note": "hello, world"},
            {"id": "3", "kind": "x", "note": "last"},
        ])

    def test_multiple_filters_and_empty_value(self):
        result = self.invoke("a,b\n1,\n1,x\n2,\n", "--where", "a=1", "--where", "b=")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": ""}])

    def test_sum_avg_sort_and_decimal_format(self):
        result = self.invoke(
            "team,amount,count\nB,0.10,2\nA,1.20,1\nB,0.20,4\nA,1.80,2\n",
            "--group-by", "team", "--sum", "amount", "--avg", "count",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"team": "A", "sum_amount": "3", "avg_count": "1.5"},
            {"team": "B", "sum_amount": "0.3", "avg_count": "3"},
        ])

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('name,note\r\n"Doe, Jane","a ""quote"""\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [
            ["name", "note"], ["Doe, Jane", 'a "quote"']
        ])

    def test_wrong_width_duplicate_empty_and_malformed_headers(self):
        cases = [
            ("a,b\n1\n", "expected 2 fields, got 1"),
            ("a,a\n1,2\n", "duplicate header"),
            ("a,\n1,2\n", "header names cannot be empty"),
            ('a,b\n"unterminated,2\n', "malformed CSV"),
        ]
        for content, message in cases:
            with self.subTest(message=message):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_unknown_column_and_invalid_filter(self):
        result = self.invoke("a\n1\n", "--where", "missing=1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown column", result.stderr)
        result = self.invoke("a\n1\n", "--where", "broken")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed filter", result.stderr)

    def test_aggregation_requires_group_and_numeric_errors_identify_cell(self):
        result = self.invoke("group,value\nx,abc\n", "--sum", "value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)
        result = self.invoke("group,value\nx,abc\n", "--group-by", "group", "--avg", "value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2, column 'value'", result.stderr)
        result = self.invoke("group,value\nx,\n", "--group-by", "group", "--sum", "value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("blank numeric value", result.stderr)


if __name__ == "__main__":
    unittest.main()

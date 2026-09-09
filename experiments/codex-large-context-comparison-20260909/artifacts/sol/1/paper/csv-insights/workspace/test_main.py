import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(contents, encoding="utf-8", newline="")
            before = input_path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(input_path), *arguments],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(input_path.read_bytes(), before)
            return result

    def test_json_filter_preserves_rows_and_parses_quoted_fields(self):
        result = self.invoke(
            'name,region,note\r\n"Ada, A.",East,"first\nsecond"\r\nBob,West,x\r\n',
            "--where",
            "region=East",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "region": "East", "note": "first\nsecond"}],
        )

    def test_multiple_filters_are_and_conditions(self):
        result = self.invoke(
            "a,b\r\nx,1\r\nx,2\r\ny,1\r\n",
            "--where",
            "a=x",
            "--where",
            "b=1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "x", "b": "1"}])

    def test_grouped_sum_and_average_are_sorted_decimal_strings(self):
        result = self.invoke(
            "group,value\r\nb,0.1\r\na,1.00\r\nb,0.2\r\na,4\r\n",
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
                {"group": "a", "sum_value": "5", "avg_value": "2.5"},
                {"group": "b", "sum_value": "0.3", "avg_value": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('name,note\r\n"A, B","line 1\nline 2"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout, newline=""))),
            [["name", "note"], ["A, B", "line 1\nline 2"]],
        )

    def test_invalid_numeric_value_identifies_record_and_column(self):
        result = self.invoke(
            "group,value\ngood,1\nbad,nope\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3, column 'value'", result.stderr)

    def test_rejects_bad_shape_duplicate_header_and_unknown_column(self):
        cases = [
            ("a,b\n1\n", (), "row 2 has 1 fields"),
            ("a,a\n1,2\n", (), "duplicate header"),
            ("a\n1\n", ("--where", "missing=x"), "unknown column 'missing'"),
        ]
        for contents, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(contents, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_rejects_malformed_usage(self):
        cases = [
            (("--where", "invalid"), "malformed filter"),
            (("--sum", "value"), "require --group-by"),
            (("--group-by", "group"), "requires --sum and/or --avg"),
        ]
        for arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke("group,value\na,1\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()

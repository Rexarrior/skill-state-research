import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before, "input file was modified")
            return result

    def test_quoted_fields_embedded_newline_and_exact_and_filters(self):
        result = self.invoke(
            'name,note,kind\r\n"Ada","one, two","A"\r\n'
            '"Bob","line one\nline two","B"\r\n',
            "--where",
            "kind=B",
            "--where",
            "note=line one\nline two",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "line one\nline two", "kind": "B"}],
        )

    def test_sum_average_sorting_and_minimal_decimal_csv(self):
        result = self.invoke(
            "team,amount\r\nz,1.20\r\na,0.01\r\nz,1.80\r\na,0.03\r\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "amount",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["team", "sum_amount", "avg_amount"], ["a", "0.04", "0.02"], ["z", "3", "1.5"]],
        )

    def test_wrong_width_duplicate_header_and_unknown_column_fail(self):
        cases = [
            ("a,b\n1\n", (), "row 2 has 1 fields"),
            ("a,a\n1,2\n", (), "header names must be unique"),
            ("a,b\n1,2\n", ("--where", "missing=x"), "unknown column"),
        ]
        for content, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_numeric_error_identifies_logical_row_and_column(self):
        result = self.invoke(
            'group,note,value\nA,"embedded\nnewline",2\nA,ok,nope\n',
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3, column 'value'", result.stderr)
        self.assertIn("invalid numeric value 'nope'", result.stderr)

    def test_aggregation_requires_grouping_and_malformed_filter_fails(self):
        for arguments, message in [
            (("--sum", "value"), "require --group-by"),
            (("--where", "broken"), "malformed filter"),
        ]:
            with self.subTest(arguments=arguments):
                result = self.invoke("group,value\nA,1\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()

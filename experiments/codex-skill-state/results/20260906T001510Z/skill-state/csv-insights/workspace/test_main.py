import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(contents, encoding="utf-8", newline="")
            before = input_path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(input_path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(before, input_path.read_bytes(), "input file was modified")
            return result

    def test_json_filter_preserves_rows_and_parses_quoted_fields(self):
        result = self.invoke(
            'name,note,team\r\n"Ada","first, second","A"\r\n'
            '"Bob","line one\nline two","B"\r\n'
            '"Amy","ok","A"\r\n',
            "--where", "team=A",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Ada", "note": "first, second", "team": "A"},
                {"name": "Amy", "note": "ok", "team": "A"},
            ],
        )

    def test_filters_combine_with_and_and_allow_equals_in_value(self):
        result = self.invoke(
            "a,b\r\nx,1=2\r\nx,2\r\ny,1=2\r\n",
            "--where", "a=x", "--where", "b=1=2",
        )
        self.assertEqual(json.loads(result.stdout), [{"a": "x", "b": "1=2"}])

    def test_grouped_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "group,amount,count\r\nz,1.20,2\r\na,0.01,1\r\n"
            "z,1.30,3\r\na,0.02,2\r\n",
            "--group-by", "group", "--sum", "amount", "--avg", "count",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "0.03", "avg_count": "1.5"},
                {"group": "z", "sum_amount": "2.5", "avg_count": "2.5"},
            ],
        )

    def test_csv_output_has_header_and_rfc_quoting(self):
        result = self.invoke('name,note\r\nAda,"hello, world"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["name", "note"], ["Ada", "hello, world"]],
        )
        self.assertIn('"hello, world"', result.stdout)

    def test_rejects_invalid_headers_and_row_lengths(self):
        for contents, message in (
            ("a,a\r\n1,2\r\n", "headers must be unique"),
            ("a,\r\n1,2\r\n", "headers must be non-empty"),
            ("a,b\r\n1\r\n", "row 2 has 1 fields"),
        ):
            with self.subTest(contents=contents):
                result = self.invoke(contents)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_rejects_unknown_columns_and_bad_filters(self):
        unknown = self.invoke("a\r\nx\r\n", "--where", "missing=x")
        malformed = self.invoke("a\r\nx\r\n", "--where", "broken")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_numeric_errors_identify_row_and_column(self):
        for value, phrase in (("", "blank numeric"), ("wat", "invalid numeric"), ("NaN", "invalid numeric")):
            with self.subTest(value=value):
                result = self.invoke(
                    f"group,value\r\na,{value}\r\n",
                    "--group-by", "group", "--sum", "value",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'value'", result.stderr)
                self.assertIn(phrase, result.stderr)

    def test_aggregation_requires_group_by(self):
        result = self.invoke("a,b\r\nx,1\r\n", "--sum", "b")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()

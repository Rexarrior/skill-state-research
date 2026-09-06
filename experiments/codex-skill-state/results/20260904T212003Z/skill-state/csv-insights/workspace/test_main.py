import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
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

    def test_filter_preserves_quoted_fields_embedded_newline_and_order(self):
        content = 'name,team,note\r\nAlice,A,"hello, world"\r\nBob,B,"two\r\nlines"\r\nCara,A,last\r\n'
        result = self.invoke(content, "--where", "team=A")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Alice", "team": "A", "note": "hello, world"},
                {"name": "Cara", "team": "A", "note": "last"},
            ],
        )

    def test_multiple_filters_are_and_and_value_may_contain_equals(self):
        content = "a,b\n1,x=y\n1,no\n2,x=y\n"
        result = self.invoke(content, "--where", "a=1", "--where", "b=x=y")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x=y"}])

    def test_grouped_sum_and_average_are_sorted_minimal_decimal_strings(self):
        content = "team,amount,units\nB,0.10,1\nA,1.20,2\nB,0.20,2\nA,1.30,5\n"
        result = self.invoke(
            content, "--group-by", "team", "--sum", "amount", "--avg", "units"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "A", "sum_amount": "2.5", "avg_units": "3.5"},
                {"team": "B", "sum_amount": "0.3", "avg_units": "1.5"},
            ],
        )

    def test_csv_output_has_header_and_round_trips(self):
        result = self.invoke('name,note\nA,"x,y"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout, newline=""))),
            [["name", "note"], ["A", "x,y"]],
        )

    def test_rejects_bad_headers_and_wrong_field_count(self):
        for content, expected in (
            ("a,a\n1,2\n", "duplicate header"),
            ("a,\n1,2\n", "must not be empty"),
            ("a,b\n1\n", "row 2 has 1 fields"),
        ):
            with self.subTest(content=content):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)

    def test_rejects_unknown_columns_filters_and_invalid_numbers(self):
        cases = [
            (("--where", "missing=x"), "unknown column"),
            (("--where", "broken"), "malformed filter"),
            (("--group-by", "team", "--sum", "amount"), "row 2, column 'amount'"),
        ]
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                result = self.invoke("team,amount\nA,nope\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)

    def test_invalid_number_in_filtered_out_row_is_ignored(self):
        result = self.invoke(
            "team,amount\nA,2\nB,nope\n",
            "--where", "team=A", "--group-by", "team", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"team": "A", "avg_amount": "2"}])


if __name__ == "__main__":
    unittest.main()

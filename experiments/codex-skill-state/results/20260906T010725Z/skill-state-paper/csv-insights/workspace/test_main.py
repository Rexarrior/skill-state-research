import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class CliTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before)
            return result

    def test_filters_and_rfc_fields(self):
        result = self.invoke(
            'name,note,team\r\nAlice,"hello, world",A\r\nBob,"line 1\nline 2",B\r\n',
            "--where", "team=B",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "line 1\nline 2", "team": "B"}],
        )

    def test_multiple_filters_combine_with_and(self):
        result = self.invoke(
            "a,b\n1,x\n1,y\n2,x\n",
            "--where", "a=1", "--where", "b=x", "--output", "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["a", "b"], ["1", "x"]])

    def test_sum_average_sorting_and_decimal_format(self):
        result = self.invoke(
            "team,amount,units\nB,0.1,2\nA,1.20,2\nB,0.2,4\nA,1.30,3\n",
            "--group-by", "team", "--sum", "amount", "--avg", "amount",
            "--sum", "units", "--output", "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [
                ["team", "sum_amount", "sum_units", "avg_amount"],
                ["A", "2.5", "5", "1.25"],
                ["B", "0.3", "6", "0.15"],
            ],
        )

    def test_empty_aggregate_has_header(self):
        result = self.invoke(
            "team,value\nA,1\n", "--where", "team=missing",
            "--group-by", "team", "--sum", "value", "--output", "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "team,sum_value\n")

    def test_bad_headers_and_width_are_errors(self):
        for content, phrase in [
            ("a,a\n1,2\n", "unique"),
            ("a,\n1,2\n", "non-empty"),
            ("a,b\n1\n", "expected 2"),
        ]:
            with self.subTest(content=content):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(phrase, result.stderr)

    def test_numeric_errors_identify_row_and_column(self):
        for value, phrase in [("", "blank"), ("nope", "invalid")]:
            with self.subTest(value=value):
                result = self.invoke(
                    f"team,value\nA,{value}\n",
                    "--group-by", "team", "--sum", "value",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2", result.stderr)
                self.assertIn("'value'", result.stderr)
                self.assertIn(phrase, result.stderr)

    def test_argument_and_column_errors(self):
        cases = [
            (("--where", "bad"), "malformed filter"),
            (("--where", "missing=x"), "unknown column"),
            (("--sum", "value"), "require --group-by"),
            (("--group-by", "team"), "requires --sum or --avg"),
        ]
        for arguments, phrase in cases:
            with self.subTest(arguments=arguments):
                result = self.invoke("team,value\nA,1\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(phrase, result.stderr)

    def test_malformed_quoting_is_error(self):
        result = self.invoke('a,b\n"unterminated,x\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)


if __name__ == "__main__":
    unittest.main()

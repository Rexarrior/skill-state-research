import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(contents, encoding="utf-8", newline="")
            before = path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(path.read_bytes(), before, "input file was modified")
            return result

    def test_rfc_csv_filter_and_input_order(self):
        result = self.invoke(
            'name,note,kind\r\nAlice,"hello, world",x\r\nBob,"two\nlines",y\r\n',
            "--where",
            "kind=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "two\nlines", "kind": "y"}],
        )

    def test_multiple_filters_use_and(self):
        result = self.invoke(
            "a,b\n1,x\n1,y\n2,x\n", "--where", "a=1", "--where", "b=x"
        )
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x"}])

    def test_sum_avg_sort_and_decimal_format(self):
        result = self.invoke(
            "team,amount\nz,0.10\na,1.20\na,1.30\nz,0.20\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "2.5", "avg_amount": "1.25"},
                {"team": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_compliant(self):
        result = self.invoke(
            'name,note\nA,"comma, here"\n', "--output", "csv"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["name", "note"], ["A", "comma, here"]],
        )
        self.assertIn('"comma, here"', result.stdout)

    def test_bad_shapes_headers_filters_and_columns_fail(self):
        cases = [
            ("a,b\n1\n", (), "row 2"),
            ("a,a\n1,2\n", (), "duplicate"),
            (",b\n1,2\n", (), "non-empty"),
            ("a\n1\n", ("--where", "bad"), "malformed filter"),
            ("a\n1\n", ("--where", "missing=x"), "unknown column"),
        ]
        for contents, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(contents, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_aggregation_validation_and_numeric_errors(self):
        cases = [
            (("--sum", "amount"), "require --group-by"),
            (("--group-by", "team"), "requires --sum"),
            (("--group-by", "team", "--sum", "missing"), "unknown column"),
        ]
        for arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke("team,amount\na,1\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

        for bad_value in ("", "wat", "NaN", "Infinity"):
            with self.subTest(value=bad_value):
                result = self.invoke(
                    f"team,amount\na,{bad_value}\n",
                    "--group-by",
                    "team",
                    "--sum",
                    "amount",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'amount'", result.stderr)


if __name__ == "__main__":
    unittest.main()

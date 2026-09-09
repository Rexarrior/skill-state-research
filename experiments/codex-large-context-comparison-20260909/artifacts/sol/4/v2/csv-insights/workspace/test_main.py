import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
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

    def test_filter_preserves_order_and_parses_quoted_content(self):
        result = self.invoke(
            'name,note,team\r\nAlice,"hello, world",red\r\nBob,"two\nlines",blue\r\n',
            "--where", "team=blue",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "two\nlines", "team": "blue"}],
        )

    def test_group_sum_avg_sorted_and_decimal(self):
        result = self.invoke(
            "team,amount\nb,0.1\na,2\nb,0.2\na,3\n",
            "--group-by", "team", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "5", "avg_amount": "2.5"},
                {"team": "b", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_quotes_fields(self):
        result = self.invoke('name,note\nA,"x,y"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'name,note\nA,"x,y"\n')

    def test_bad_width_is_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_bad_headers_unknown_columns_and_bad_filter_are_errors(self):
        for content, arguments, message in (
            ("a,a\n1,2\n", (), "unique"),
            ("a\n1\n", ("--where", "missing=x"), "unknown column"),
            ("a\n1\n", ("--where", "broken"), "malformed filter"),
        ):
            with self.subTest(message=message):
                result = self.invoke(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_invalid_numeric_value_identifies_row_and_column(self):
        result = self.invoke("team,value\na,nope\n", "--group-by", "team", "--sum", "value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("value", result.stderr)

    def test_aggregation_requires_group(self):
        result = self.invoke("value\n1\n", "--sum", "value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)

    def test_aggregate_output_columns_must_be_unique(self):
        for content, arguments in (
            (
                "team,value\na,1\n",
                ("--group-by", "team", "--sum", "value", "--sum", "value"),
            ),
            (
                "sum_value,value\na,1\n",
                ("--group-by", "sum_value", "--sum", "value"),
            ),
        ):
            with self.subTest(arguments=arguments):
                result = self.invoke(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("column", result.stderr)


if __name__ == "__main__":
    unittest.main()

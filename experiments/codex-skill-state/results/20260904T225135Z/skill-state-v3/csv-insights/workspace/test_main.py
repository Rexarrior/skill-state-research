import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsCliTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "input.csv")
            path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_fields_embedded_newline_and_order(self):
        result = self.invoke(
            'id,kind,note\r\n1,A,"hello, world"\r\n2,B,"two\nlines"\r\n3,A,last\r\n',
            "--where", "kind=A",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"id": "1", "kind": "A", "note": "hello, world"},
                {"id": "3", "kind": "A", "note": "last"},
            ],
        )

    def test_grouped_sum_and_average_are_sorted_and_exact(self):
        result = self.invoke(
            "group,amount\r\nz,0.1\r\na,1.20\r\nz,0.2\r\na,2.80\r\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "4", "avg_amount": "2"},
                {"group": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_sum_does_not_round_values_longer_than_decimal_context(self):
        result = self.invoke(
            "group,amount\nA,123456789012345678901234567890\nA,1\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "A", "sum_amount": "123456789012345678901234567891"}],
        )

    def test_csv_output_is_parseable_and_has_generated_header(self):
        result = self.invoke(
            'group,amount\r\n"x,y",2.5\r\n',
            "--group-by", "group", "--sum", "amount", "--output", "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["group", "sum_amount"], ["x,y", "2.5"]],
        )

    def test_multiple_filters_use_and_and_allow_equals_in_value(self):
        result = self.invoke(
            "a,b\r\nx,1=2\r\nx,no\r\ny,1=2\r\n",
            "--where", "a=x", "--where", "b=1=2",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "x", "b": "1=2"}])

    def test_invalid_numeric_cell_identifies_record_and_column(self):
        result = self.invoke(
            "group,amount\r\na,1\r\na,nope\r\n",
            "--group-by", "group", "--sum", "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_rejects_bad_header_wrong_field_count_and_unknown_column(self):
        cases = [
            ("a,a\r\n1,2\r\n", (), "unique"),
            ("a,b\r\n1\r\n", (), "row 2"),
            ("a,b\r\n1,2\r\n", ("--where", "missing=x"), "unknown column"),
        ]
        for content, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_aggregation_requires_group_by(self):
        result = self.invoke("a\r\n1\r\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()

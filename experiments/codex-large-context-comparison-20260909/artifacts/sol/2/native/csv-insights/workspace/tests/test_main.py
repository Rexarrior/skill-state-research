import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "main.py"


class CLITests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(contents, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before)
            return result

    def test_filter_preserves_quoted_fields_and_order(self):
        result = self.invoke(
            'name,team,note\r\nAlice,A,"one, two"\r\nBob,B,"two\nlines"\r\n',
            "--where",
            "team=B",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "team": "B", "note": "two\nlines"}],
        )

    def test_group_by_without_calculation_still_emits_rows(self):
        result = self.invoke("group,value\nb,2\na,1\n", "--group-by", "group")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "b", "value": "2"}, {"group": "a", "value": "1"}],
        )

    def test_grouped_sum_and_average_are_sorted_and_decimal(self):
        result = self.invoke(
            "group,amount,score\r\nz,0.10,1\r\na,2.00,2\r\nz,0.20,2\r\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "2", "avg_score": "2"},
                {"group": "z", "sum_amount": "0.3", "avg_score": "1.5"},
            ],
        )

    def test_csv_output_is_parseable_and_has_generated_header(self):
        result = self.invoke(
            'group,amount\r\n"a,b",1.20\r\n',
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["group", "sum_amount"], ["a,b", "1.2"]],
        )

    def test_sum_does_not_round_at_default_decimal_precision(self):
        result = self.invoke(
            "group,amount\na,123456789012345678901234567890\na,1\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout)[0]["sum_amount"],
            "123456789012345678901234567891",
        )

    def test_repeating_average_uses_decimal_not_binary_float(self):
        result = self.invoke(
            "group,amount\na,1\na,0\na,0\n",
            "--group-by",
            "group",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout)[0]["avg_amount"],
            "0.3333333333333333333333333333",
        )

    def test_wrong_field_count_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_bad_number_identifies_row_and_column(self):
        result = self.invoke(
            "group,amount\na,nope\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_schema_and_argument_errors(self):
        cases = [
            ("a,a\n1,2\n", (), "unique"),
            (",b\n1,2\n", (), "non-empty"),
            ("a\n1\n", ("--where", "missing=x"), "unknown column"),
            ("a\n1\n", ("--where", "broken"), "malformed filter"),
            ("a\n1\n", ("--sum", "a"), "require --group-by"),
        ]
        for contents, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(contents, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()

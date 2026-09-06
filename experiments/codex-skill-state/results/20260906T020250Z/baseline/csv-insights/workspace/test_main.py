import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents: str, *args: str):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(contents, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *args],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before)
            return result

    def test_filters_and_rfc_csv(self):
        result = self.invoke(
            'name,note,kind\r\n"Ada","line 1\nline, 2",x\r\nBob,plain,y\r\n',
            "--where", "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada", "note": "line 1\nline, 2", "kind": "x"}],
        )

    def test_sum_avg_sort_and_minimal_decimals(self):
        result = self.invoke(
            "team,amount,score\r\nz,1.20,2\r\na,0.01,1\r\nz,1.30,3\r\n",
            "--group-by", "team", "--sum", "amount", "--avg", "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "0.01", "avg_score": "1"},
                {"team": "z", "sum_amount": "2.5", "avg_score": "2.5"},
            ],
        )

    def test_csv_output_round_trips(self):
        result = self.invoke('a,b\r\n"x,y","line 1\nline 2"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout, newline=""))),
            [["a", "b"], ["x,y", "line 1\nline 2"]],
        )

    def test_decimal_sum_does_not_round_at_default_context_precision(self):
        result = self.invoke(
            "group,value\nx,10000000000000000000000000000\nx,0.1\n",
            "--group-by", "group", "--sum", "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "x", "sum_value": "10000000000000000000000000000.1"}],
        )

    def test_bad_width_and_bad_number_report_record_and_column(self):
        width = self.invoke("a,b\n1\n")
        self.assertNotEqual(width.returncode, 0)
        self.assertIn("row 2", width.stderr)

        number = self.invoke(
            "group,value\ngood,1\nbad,nope\n",
            "--group-by", "group", "--sum", "value",
        )
        self.assertNotEqual(number.returncode, 0)
        self.assertIn("row 3", number.stderr)
        self.assertIn("value", number.stderr)

    def test_header_and_argument_validation(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("duplicate", duplicate.stderr)

        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown", unknown.stderr)

        aggregation = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(aggregation.returncode, 0)
        self.assertIn("require --group-by", aggregation.stderr)

        empty_aggregation = self.invoke("a\n1\n", "--group-by", "a")
        self.assertNotEqual(empty_aggregation.returncode, 0)
        self.assertIn("requires --sum or --avg", empty_aggregation.stderr)


if __name__ == "__main__":
    unittest.main()

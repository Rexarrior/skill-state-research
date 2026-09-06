import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRAM = ROOT / "main.py"


class CliTests(unittest.TestCase):
    def invoke(self, content: str, *args: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *args],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_exactly_and_preserves_complex_csv(self) -> None:
        result = self.invoke(
            'name,note,status\r\n"Ada, A.","first\nsecond",ok\r\nBob,plain,no\r\n',
            "--where",
            "status=ok",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "note": "first\nsecond", "status": "ok"}],
        )

    def test_multiple_filters_combine_with_and(self) -> None:
        result = self.invoke(
            "a,b\n1,x\n1,y\n2,x\n", "--where", "a=1", "--where", "b=x"
        )
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x"}])

    def test_sum_and_average_are_decimal_and_groups_are_sorted(self) -> None:
        result = self.invoke(
            "team,amount,score\nz,0.1,1\na,0.2,2\nz,0.2,2\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "0.2", "avg_score": "2"},
                {"team": "z", "sum_amount": "0.3", "avg_score": "1.5"},
            ],
        )

    def test_csv_output_has_header_and_rfc_quoting(self) -> None:
        result = self.invoke('a,b\n"x,y","line 1\nline 2"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines(keepends=True))),
            [["a", "b"], ["x,y", "line 1\nline 2"]],
        )
        self.assertTrue(result.stdout.startswith("a,b\n") or result.stdout.startswith("a,b\r\n"))

    def test_empty_result_keeps_csv_header(self) -> None:
        result = self.invoke("a,b\n1,2\n", "--where", "a=none", "--output", "csv")
        self.assertEqual(result.stdout, "a,b\n")  # text mode normalizes CRLF

    def test_rejects_invalid_numeric_cell_with_location(self) -> None:
        result = self.invoke(
            "group,value\na,nope\n", "--group-by", "group", "--sum", "value"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("value", result.stderr)

    def test_rejects_non_finite_and_blank_numbers(self) -> None:
        for value in ("", "NaN", "Infinity"):
            with self.subTest(value=value):
                result = self.invoke(
                    f"group,value\na,{value}\n",
                    "--group-by",
                    "group",
                    "--avg",
                    "value",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2", result.stderr)

    def test_rejects_bad_headers_and_row_widths(self) -> None:
        for content, message in (
            ("a,a\n1,2\n", "unique"),
            ("a,\n1,2\n", "non-empty"),
            ("a,b\n1\n", "fields"),
        ):
            with self.subTest(content=content):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_rejects_malformed_csv_quoting(self) -> None:
        result = self.invoke('a,b\n"unterminated,value\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)

    def test_rejects_unknown_columns_and_malformed_arguments(self) -> None:
        cases = (
            (("--where", "missing=x"), "unknown column"),
            (("--where", "broken"), "malformed filter"),
            (("--sum", "a"), "require --group-by"),
        )
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                result = self.invoke("a,b\n1,2\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()

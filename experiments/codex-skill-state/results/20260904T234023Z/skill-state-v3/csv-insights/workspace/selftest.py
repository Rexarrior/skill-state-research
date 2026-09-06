"""Minimal regression tests for the CSV Insights command-line tool."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).parent


def run(csv_text: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "input.csv"
        source.write_text(csv_text, encoding="utf-8", newline="")
        return subprocess.run(
            [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )


def test_filter_and_quoted_fields() -> None:
    result = run('name,team,amount\n"Doe, Jane",red,1\nBob,blue,2\n', "--where", "team=red")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [{"name": "Doe, Jane", "team": "red", "amount": "1"}]


def test_aggregates_and_csv_output() -> None:
    result = run(
        "team,amount,score\nb,1.0,1\na,2.5,2\nb,3,4\n",
        "--group-by", "team", "--sum", "amount", "--avg", "score", "--output", "csv",
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "team,sum_amount,avg_score\na,2.5,2\nb,4,2.5\n"


def test_errors() -> None:
    result = run("name,value\nx,\n", "--group-by", "name", "--sum", "value")
    assert result.returncode != 0 and "row 2, column value" in result.stderr
    result = run("name,value\nx,1\n", "--where", "missing=x")
    assert result.returncode != 0 and "unknown column" in result.stderr
    result = run("name,value\nx\n")
    assert result.returncode != 0 and "expected 2" in result.stderr


if __name__ == "__main__":
    test_filter_and_quoted_fields()
    test_aggregates_and_csv_output()
    test_errors()
    print("self-tests passed")

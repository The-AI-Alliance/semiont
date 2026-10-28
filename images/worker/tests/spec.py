"""Where the repository around this project is, for the tests that hold the project to it."""

from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
SPEC = ROOT / "specs/src"
SDK = ROOT / "packages/sdk-python"

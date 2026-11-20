"""Test de regresión UTF-8: el export no puede volver a la doble codificación."""

from __future__ import annotations

import unittest
from pathlib import Path

from .db import BASE_DIR

MOJIBAKE = (
    "Ã¡", "Ã©", "Ã­", "Ã³", "Ãº", "Ã±", "Ã",
    "Â", "â€", "FÃºtbol", "MÃ©xico", "BrasileirÃ£o",
)

TEXT_SUFFIXES = {".js", ".json", ".md", ".html", ".css", ".py", ".mjs", ".sql", ".txt"}
SKIP_PARTS = {
    "_respaldo_antes_live",
    "_respaldo_demo",
    "_respaldo_v3",
    ".cache",
    "raw",
    "__pycache__",
    "node_modules",
}


def text_files() -> list[Path]:
    files: list[Path] = []
    for path in BASE_DIR.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if SKIP_PARTS & set(path.parts):
            continue
        if path == Path(__file__).resolve():
            continue
        files.append(path)
    return files


class EncodingRegressionTests(unittest.TestCase):
    def test_all_text_files_decode_as_utf8(self) -> None:
        failures = []
        for path in text_files():
            try:
                path.read_text(encoding="utf-8")
            except UnicodeDecodeError as error:
                failures.append(f"{path.relative_to(BASE_DIR)}: {error}")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_no_mojibake_in_current_files(self) -> None:
        hits = []
        for path in text_files():
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for pattern in MOJIBAKE:
                if pattern in text:
                    hits.append(f"{path.relative_to(BASE_DIR)}: {pattern!r}")
                    break
        self.assertEqual(hits, [], "\n".join(hits))

    def test_source_keeps_spanish_accents(self) -> None:
        source = (BASE_DIR / "datos_live.mjs").read_text(encoding="utf-8")
        self.assertIn("México", source)
        self.assertIn("Brasileirão", source)
        self.assertIn("España", source)

    def test_generated_competition_export_is_utf8(self) -> None:
        path = BASE_DIR / "data" / "competitions.json"
        if not path.exists():
            self.skipTest("data/competitions.json todavía no existe")
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("Ã", text)
        self.assertNotIn("Â", text)


if __name__ == "__main__":
    unittest.main()

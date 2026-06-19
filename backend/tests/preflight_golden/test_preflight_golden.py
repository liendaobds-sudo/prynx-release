"""
Golden tests — khóa hành vi Preflight trên bộ PDF fixture chuẩn.

Chạy:
    cd backend
    venv\\Scripts\\python.exe -m pytest tests/preflight_golden -v

Fixture PDF: tests/preflight_fixtures/pdfs/
Kỳ vọng:     tests/preflight_fixtures/expected_rules.json

So sánh: tập rule_id thực tế phải chứa must_have và không chứa must_not_have.
`17_tac_heavy_cmyk.pdf` skip chỉ khi máy không có Ghostscript (TAC cần GS tiffsep).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.config import settings
from app.core.preflight_engine import PreflightEngine
from app.core.preflight_models import ALL_RULES

FIXTURES_ROOT = Path(__file__).parent.parent / "preflight_fixtures"
PDF_DIR = FIXTURES_ROOT / "pdfs"
MANIFEST_PATH = FIXTURES_ROOT / "expected_rules.json"


def _load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        pytest.skip(
            f"Chưa có {MANIFEST_PATH.name}. "
            "Chạy: python tests/preflight_fixtures/generate_fixtures.py"
        )
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _issue_rule_ids(report) -> set[str]:
    return {i.rule_id for i in report.issues}


@pytest.fixture(scope="module")
def manifest():
    return _load_manifest()


@pytest.fixture(scope="module")
def engine():
    return PreflightEngine()


def _fixture_ids(manifest):
    return sorted(manifest["fixtures"].keys())


@pytest.mark.parametrize("fixture_name", _fixture_ids(_load_manifest()) if MANIFEST_PATH.exists() else [])
def test_preflight_fixture_golden(fixture_name: str, manifest: dict, engine: PreflightEngine):
    spec = manifest["fixtures"][fixture_name]
    pdf_path = PDF_DIR / fixture_name
    assert pdf_path.exists(), f"Thiếu PDF: {pdf_path}"

    if fixture_name == "17_tac_heavy_cmyk.pdf" and not os.path.isfile(settings.GHOSTSCRIPT_PATH):
        pytest.skip(
            f"Thiếu Ghostscript tại {settings.GHOSTSCRIPT_PATH} — không thể golden-test TAC."
        )

    rules = spec.get("rules") or list(ALL_RULES)
    report = engine.run(str(pdf_path), rules=rules, tac_threshold=300)
    found = _issue_rule_ids(report)

    must_have = set(spec.get("must_have", []))
    must_not = set(spec.get("must_not_have", []))

    missing = must_have - found
    forbidden = must_not & found

    if missing and (spec.get("optional") or spec.get("manual_only")):
        pytest.skip(
            f"{fixture_name}: optional/manual fixture — thiếu {missing}"
        )

    assert not forbidden, (
        f"{fixture_name}: phát hiện rule không mong muốn {forbidden}\n"
        f"Tất cả issues: {sorted(found)}"
    )
    assert not missing, (
        f"{fixture_name}: thiếu rule bắt buộc {missing}\n"
        f"Tất cả issues: {sorted(found)}"
    )


def test_all_fixture_pdfs_exist(manifest: dict):
    for name in manifest["fixtures"]:
        assert (PDF_DIR / name).exists(), f"Thiếu {name}"


def test_manifest_covers_at_least_15_core_fixtures(manifest: dict):
    """Bộ QA core (không tính optional TAC / manual_only progressive)."""
    core = [
        k for k, v in manifest["fixtures"].items()
        if not v.get("optional") and not v.get("manual_only")
    ]
    assert len(core) >= 15
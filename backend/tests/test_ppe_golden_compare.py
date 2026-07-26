"""Truthfulness guards for the PPE/GS corpus comparison harness."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.ppe_golden_compare import Comparison  # noqa: E402


def _comparison(**overrides) -> Comparison:
    values = {
        "pdf": "fixture.pdf",
        "gs_tac": 200.0,
        "ppe_tac": 200.0,
        "gs_plates": ["Cyan", "Magenta", "Yellow", "Black"],
        "ppe_plates": ["Cyan", "Magenta", "Yellow", "Black"],
        "worst_mae": 0.0,
        "degraded": False,
        "skipped": [],
    }
    values.update(overrides)
    return Comparison(**values)


def test_ink_unsound_can_never_be_reported_as_pass():
    result = _comparison(
        ink_unsound=True,
        dropped=0,
        skipped=["Group non-isolated + BM khác Normal"],
    )
    assert result.verdict() == "CHƯA ĐỦ TÍNH NĂNG"


def test_plate_mean_delta_is_not_labeled_as_pixel_mae():
    result = _comparison(worst_mae=10.0)
    assert result.verdict() == "FAIL (mean kẽm)"

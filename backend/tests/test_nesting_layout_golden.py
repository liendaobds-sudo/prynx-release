"""Golden layout cho nesting — KHÓA bất biến layout của baseline autofill/quantity.

Lịch sử:
* B6 (spatial-index) đã ĐO là bất khả thi byte-exact và bỏ; golden giữ nguyên.
* B7 (clash-index) byte-identical — golden xanh không đổi.
* B9 (miền hợp lệ tăng dần, §NEST-B9): bỏ O(N²) của pha difference. Nhanh ~7× nhưng
  Clipper nhạy cách gom-batch nên ở N LỚN lệch mức phần-triệu → có thể ±1 con biên
  (đã đo, deterministic, không hồi quy mật độ). Ca nhỏ dưới đây vẫn khớp từng byte
  (đã kiểm), và ca ``autofill_scale_*`` được **bless CÓ CHỦ ĐÍCH** để khoá layout B9
  ở quy mô làm mốc chống trôi về sau. Đây KHÔNG phải bless để giấu hồi quy — là chốt
  lại đường incremental đã được người dùng duyệt (đánh đổi ±1 con lấy 7× tốc độ).

Test này freeze placement (số con, số tờ, SHA của pose records đã sắp) vào
``fixtures/nesting_golden/baseline_layout_golden.json``. Sau khi sửa Rust + rebuild native,
chạy lại phải KHỚP từng byte — lệch = có thay đổi đã đổi hình học layout ⇒ soi kỹ trước
khi (nếu chủ đích) bless lại.

Vì sao SHA của pose records, không phải ``layoutFingerprint``: fingerprint gồm locator pin
đổi mỗi lượt (RA-NEST-00), còn pose records (instanceId/partId/sheetIndex/pose) là bất biến
hình học thật — đã kiểm ổn định fresh-vs-cached ở lô PV-CACHE.

Xác định (deterministic): ``timeBudgetMs=None`` ⇒ fixed work-plan + seed cố định, nên hai
lượt cho cùng pose. Không dùng deadline (deadline mode phụ thuộc tốc độ máy).

Tạo/cập nhật golden CÓ CHỦ ĐÍCH (bless): ``PRYNX_BLESS_GOLDEN=1``. Chỉ bless khi thay đổi
layout là chủ ý và đã soi diff — không bao giờ bless để "làm xanh" một hồi quy.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from app.core import mixed_nesting_service as svc


def _native_has_engine() -> bool:
    try:
        svc.reset_engine_cache()
        svc.load_engine()
    except svc.EngineUnavailableError:
        return False
    return True


requires_engine = pytest.mark.skipif(
    not _native_has_engine(),
    reason="pdfcompare_native chưa có MixedNestingRun (cần maturin develop --release).",
)

GOLDEN_PATH = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "nesting_golden"
    / "baseline_layout_golden.json"
)

CARDINAL = {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]}


def _rect(w: float, h: float) -> list[list[float]]:
    return [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]


def _lshape() -> list[list[float]]:
    # Lõm — có chỗ lồng nhau, để golden phủ cả contour không lồi.
    return [[0.0, 0.0], [60.0, 0.0], [60.0, 18.0], [22.0, 18.0], [22.0, 47.0], [0.0, 47.0]]


def _request(*, intent: str, parts: list[dict], sheet_w: float, sheet_h: float,
             margin: float, gap: float, max_sheets: int, seed: int = 42) -> dict:
    return {
        "protocolVersion": 2,
        "seed": seed,
        "profile": "fast",
        # KHÔNG timeBudgetMs → fixed work-plan, xác định (không phụ thuộc tốc độ máy).
        "sheet": {
            "widthMm": sheet_w,
            "heightMm": sheet_h,
            "marginMm": {"left": margin, "right": margin, "top": margin, "bottom": margin},
            "maxSheets": max_sheets,
        },
        "gapMm": gap,
        "layoutIntent": intent,
        "orientationPolicy": {"defaultRotation": dict(CARDINAL), "reflection": "forbidden"},
        "parts": parts,
    }


def _autofill_part(part_id: str, outer: list[list[float]]) -> dict:
    # Autofill KHÔNG nhận quantity (engine chặn AUTOFILL_QUANTITY_MUST_BE_ABSENT).
    return {"partId": part_id, "outer": outer, "holes": [], "rotationConstraint": {"mode": "inherit"}}


def _qty_part(part_id: str, outer: list[list[float]], quantity: int) -> dict:
    return {
        "partId": part_id, "quantity": quantity, "outer": outer, "holes": [],
        "rotationConstraint": {"mode": "inherit"},
    }


# Ca đủ nhỏ để nhanh + xác định, nhưng đủ con để lôi ra vòng blocker O(N²) của baseline.
CASES: dict[str, dict] = {
    "autofill_rect_cardinal": _request(
        intent="autofill_single_sheet",
        parts=[_autofill_part("r", _rect(30.0, 20.0))],
        sheet_w=170.0, sheet_h=130.0, margin=5.0, gap=2.0, max_sheets=1,
    ),
    "autofill_lshape_cardinal": _request(
        intent="autofill_single_sheet",
        parts=[_autofill_part("l", _lshape())],
        sheet_w=240.0, sheet_h=190.0, margin=5.0, gap=2.0, max_sheets=1,
    ),
    "autofill_mixed_cardinal": _request(
        intent="autofill_single_sheet",
        parts=[
            _autofill_part("a", _rect(28.0, 18.0)),
            _autofill_part("b", _lshape()),
            _autofill_part("c", _rect(20.0, 20.0)),
        ],
        sheet_w=260.0, sheet_h=200.0, margin=5.0, gap=2.0, max_sheets=1,
    ),
    "quantity_rect_cardinal": _request(
        intent="quantity_fulfillment",
        parts=[_qty_part("r", _rect(30.0, 20.0), quantity=18)],
        sheet_w=170.0, sheet_h=130.0, margin=5.0, gap=2.0, max_sheets=3,
    ),
    # §NEST-B9: ca QUY MÔ (đa mẫu, ~vài trăm con) để lôi đúng đường incremental theo
    # (mẫu, góc) và khoá layout B9 làm mốc chống trôi. Chậm hơn các ca trên nhưng vẫn
    # xác định (timeBudgetMs=None). Đây là ca chính bảo vệ tính ổn định của incremental.
    "autofill_scale_mixed_cardinal": _request(
        intent="autofill_single_sheet",
        parts=[
            _autofill_part("a", _rect(28.0, 18.0)),
            _autofill_part("b", _lshape()),
            _autofill_part("c", _rect(20.0, 20.0)),
            _autofill_part("d", _rect(24.0, 14.0)),
        ],
        sheet_w=380.0, sheet_h=300.0, margin=5.0, gap=2.0, max_sheets=1,
    ),
}


def _solve_snapshot(request: dict) -> dict:
    """Giải một ca, trả bất biến hình học ổn định: số con, số tờ, SHA pose records."""
    manifest = svc.create_run().solve(request)
    stats = manifest.get("stats") or {}
    records = []
    for p in manifest.get("placements") or ():
        pose = p.get("pose") or {}
        records.append({
            "instanceId": p.get("instanceId"),
            "partId": p.get("partId"),
            "sheetIndex": p.get("sheetIndex"),
            "rotationDeg": round(float(pose.get("rotationDeg") or 0.0), 6),
            "translateXmm": round(float(pose.get("translateXmm") or 0.0), 6),
            "translateYmm": round(float(pose.get("translateYmm") or 0.0), 6),
        })
    records.sort(key=lambda r: (r["partId"], r["instanceId"], r["sheetIndex"]))
    canonical = json.dumps(records, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {
        "placedCount": int(stats.get("placedCount") or 0),
        "sheetCount": int(stats.get("sheetCount") or 0),
        "unplacedCount": int(stats.get("unplacedCount") or 0),
        "posesSha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def _bless() -> bool:
    return os.environ.get("PRYNX_BLESS_GOLDEN") == "1"


@pytest.fixture(scope="module")
def golden() -> dict:
    if _bless():
        data = {
            "_note": "Golden layout baseline nesting — mốc bất biến. Đang khoá layout sau "
                     "B9 (miền hợp lệ tăng dần): ca nhỏ byte-identical, ca autofill_scale_* "
                     "khoá layout B9 ở quy mô. Bless lại CHỈ khi đổi layout là chủ ý "
                     "(PRYNX_BLESS_GOLDEN=1) và đã soi diff — không bao giờ để giấu hồi quy.",
            "cases": {cid: _solve_snapshot(req) for cid, req in CASES.items()},
        }
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if not GOLDEN_PATH.exists():
        pytest.fail(
            "Chưa có golden. Chạy một lần với PRYNX_BLESS_GOLDEN=1 để tạo mốc "
            f"({GOLDEN_PATH})."
        )
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))["cases"]


@requires_engine
@pytest.mark.parametrize("case_id", list(CASES))
def test_layout_golden_khong_doi(case_id: str, golden: dict) -> None:
    """Layout của mỗi ca phải KHỚP golden. Lệch = có thay đổi đã đổi hình học layout."""
    assert case_id in golden, f"golden thiếu ca {case_id!r} — bless lại."
    actual = _solve_snapshot(CASES[case_id])
    assert actual == golden[case_id], (
        f"Layout ca {case_id!r} ĐÃ ĐỔI so với golden.\n"
        f"  golden = {golden[case_id]}\n  actual = {actual}\n"
        "Nếu KHÔNG chủ ý đổi layout (vd lô spatial-index) thì đây là hồi quy — sửa engine, "
        "KHÔNG bless. Chỉ bless khi đổi hình học là chủ đích và đã soi diff."
    )

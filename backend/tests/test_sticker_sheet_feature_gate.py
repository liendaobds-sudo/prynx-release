"""Free phải bị 403 ở MỌI endpoint của Sticker Sheet.

SEC (audit 2026-08-28 §SEC.14)
─────────────────────────────────────────────────────────────────────────────────
`test_sticker_sheet_api.py` dài 2133 dòng nhưng KHÔNG có một assert 403 nào, trong khi
router này có 10 endpoint đều gate `prepress.cutline` (quyền PRO). Nghĩa là toàn bộ lớp
entitlement của công cụ tem bế chưa từng được kiểm: nếu ai đó gỡ một `dependencies=[...]`
khỏi decorator thì không test nào đỏ và không tính năng nào gãy — đúng hình dạng lỗ
§SEC.01 vừa tìm được ở `cut_export`.

Test này chỉ kiểm ENTITLEMENT (403 trước khi chạm engine), không kiểm hình học/xuất file —
phần đó là việc của `test_sticker_sheet_api.py`.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core import feature_entitlements
from app.core.license_guard import require_license
from app.main import app

FEATURE_ID = "prepress.cutline"

#: (method, path) của cả 10 endpoint. `session_id`/`asset` là giá trị giả: entitlement
#: phải chặn TRƯỚC khi route đi tìm session, nên 404 ở đây là hồi quy chứ không phải OK.
_ENDPOINTS = [
    ("post", "/api/sticker-sheet/inspect"),
    ("post", "/api/sticker-sheet/phien-gia/detect"),
    ("post", "/api/sticker-sheet/phien-gia/refine"),
    ("post", "/api/sticker-sheet/phien-gia/cutline-preview"),
    ("post", "/api/sticker-sheet/phien-gia/confirm"),
    ("post", "/api/sticker-sheet/analyze"),
    ("post", "/api/sticker-sheet/warmup"),
    ("get", "/api/sticker-sheet/phien-gia/assets/preview"),
    ("delete", "/api/sticker-sheet/phien-gia"),
    ("post", "/api/sticker-sheet/phien-gia/export"),
]

_FREE = {
    "license_key": "FREE",
    "hwid": "TEST",
    "verified": True,
    "plan": "free",
    "features": [],
}


@pytest.fixture(autouse=True)
def _bat_gate_quyen(monkeypatch):
    # Chạy từ source thì gate mặc định TẮT (`_feature_gating_enabled`), nên không bật
    # tường minh ở đây là mọi assert 403 dưới đây xanh GIẢ.
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    yield
    app.dependency_overrides.clear()


def _goi(method: str, path: str):
    with TestClient(app) as client:
        return getattr(client, method)(path)


@pytest.mark.parametrize(("method", "path"), _ENDPOINTS)
def test_free_bi_chan_403_o_moi_endpoint(method: str, path: str) -> None:
    app.dependency_overrides[require_license] = lambda: _FREE
    response = _goi(method, path)
    assert response.status_code == 403, f"{method.upper()} {path} → {response.status_code}"
    assert FEATURE_ID in response.json().get("detail", "")


def test_grant_rieng_prepress_cutline_mo_duoc_cho_free() -> None:
    """Gate là QUYỀN, không phải hạng gói: Free có grant lẻ vẫn đi qua entitlement.

    Không assert 200 — sau entitlement, request thiếu body sẽ dừng ở validation (422).
    Điều cần chứng minh là nó KHÔNG còn dừng ở 403.
    """
    app.dependency_overrides[require_license] = lambda: {**_FREE, "features": [FEATURE_ID]}
    response = _goi("post", "/api/sticker-sheet/inspect")
    assert response.status_code != 403, response.text


@pytest.mark.parametrize("grant_khac", ["impo.diecut", "impo.cnc", "packaging.dieline"])
def test_grant_cua_tool_khac_khong_mo_duoc(grant_khac: str) -> None:
    """`impo.diecut`/`impo.cnc`/`packaging.dieline` KHÔNG phải bí danh của cutline."""
    app.dependency_overrides[require_license] = lambda: {**_FREE, "features": [grant_khac]}
    response = _goi("post", "/api/sticker-sheet/inspect")
    assert response.status_code == 403, grant_khac

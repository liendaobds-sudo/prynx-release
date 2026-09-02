"""License và rollout gate của "Bình lồng ghép tự do" — phase P7b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §8, §16.3.

Điểm khác biệt so với ``test_mixed_nesting_entitlement_contract.py``: file kia kiểm
**danh mục quyền** (dữ liệu), file này kiểm **đường HTTP thật** — và quan trọng nhất là
chứng minh engine **chưa bị gọi** khi bị chặn. Cách chứng minh: thay
``mixed_nesting_service.create_run``/``engine_capabilities`` bằng hàm làm test đỏ nếu bị
gọi. Nếu gate đặt sai thứ tự, test đỏ ngay chứ không "chỉ chậm hơn".

Ba lớp gate, độc lập nhau:

1. **License/entitlement** → 403. Free bị chặn; Pro và grant đúng tên đi được; grant của
   tool khác **không** mở tool này.
2. **Rollout flag** → 404, mặc định HOLD. Chỉ chặn TẠO job; Status/Cancel/Delete của job
   đã tồn tại vẫn phục vụ (§8 quy tắc 3) để không rò thread, slot hay handle.
3. **Native** → 503 ``ENGINE_UNAVAILABLE``, và **không** fallback sang solver cũ.
"""

from __future__ import annotations

from contextlib import nullcontext
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.routes import mixed_nesting as route
from app.core import feature_entitlements as entitlements
from app.core import mixed_nesting_service as svc
from app.core.license_guard import require_license
from app.core.mixed_nesting_jobs import MixedNestingJobRegistry
from app.main import app

CAPABILITY = "impo.mixed_nesting"


def _license(plan: str, features: list[str] | None) -> dict[str, Any]:
    return {
        "license_key": f"TEST-{plan.upper()}",
        "hwid": "HWID-GATE",
        "license_token": "",
        "verified": True,
        "plan": plan,
        "features": features,
    }


def _rect(w: float, h: float) -> list[list[float]]:
    return [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]


def _body() -> dict[str, Any]:
    return {
        "protocolVersion": svc.MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 20260826,
        "profile": "fast",
        "timeBudgetMs": 2000,
        "sheet": {
            "widthMm": 400.0,
            "heightMm": 500.0,
            "marginMm": {"left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0},
            "maxSheets": 4,
        },
        "gapMm": 3.0,
        "orientationPolicy": {
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": "part-a",
                "quantity": 2,
                "outer": _rect(90.0, 60.0),
                "holes": [],
                "rotationConstraint": {"mode": "inherit"},
            }
        ],
    }


class _EngineKhongDuocGoi(AssertionError):
    """Ném ra khi engine bị chạm trong lúc lẽ ra đã bị chặn."""


@pytest.fixture()
def gate(monkeypatch):
    """Client + registry riêng; engine bị thay bằng bẫy: gọi tới là test đỏ."""
    goi: list[str] = []

    def bay_create_run():
        goi.append("create_run")
        raise _EngineKhongDuocGoi("create_run bị gọi dù request lẽ ra đã bị chặn")

    def bay_capabilities():
        goi.append("capabilities")
        raise _EngineKhongDuocGoi("engine_capabilities bị gọi dù đã bị chặn")

    registry = MixedNestingJobRegistry(
        max_queued=4,
        ttl_seconds=60.0,
        slot_factory=lambda: nullcontext(),
        run_factory=bay_create_run,
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setattr(route, "engine_capabilities", bay_capabilities)
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)
    hien_tai: dict[str, Any] = {"license": _license("pro", ["*"])}
    app.dependency_overrides[require_license] = lambda: hien_tai["license"]
    try:
        with TestClient(app) as client:
            yield client, hien_tai, goi, registry
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


# ─────────────────────────────────────────────────────────────────────────────
#  1. License / entitlement → 403
# ─────────────────────────────────────────────────────────────────────────────


def test_free_bi_chan_403_va_engine_chua_duoc_goi(gate, monkeypatch):
    client, hien_tai, goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    hien_tai["license"] = _license("free", [])

    for method, path in (
        ("post", "/api/mixed-nesting/jobs"),
        ("get", "/api/mixed-nesting/capabilities"),
        ("get", "/api/mixed-nesting/jobs/abc"),
        ("get", "/api/mixed-nesting/jobs/abc/result"),
        ("post", "/api/mixed-nesting/jobs/abc/cancel"),
        ("delete", "/api/mixed-nesting/jobs/abc"),
    ):
        kwargs = {"json": _body()} if method == "post" and path.endswith("/jobs") else {}
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 403, f"{method.upper()} {path} → {response.status_code}"

    assert goi == [], f"engine bị chạm dù Free đã bị chặn: {goi}"


def test_grant_dung_ten_mo_duoc(gate, monkeypatch):
    client, hien_tai, _goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    hien_tai["license"] = _license("free", [CAPABILITY])
    # Qua được lớp quyền: request hợp lệ nên KHÔNG còn là 403.
    response = client.post("/api/mixed-nesting/jobs", json=_body())
    assert response.status_code == 202, response.text


@pytest.mark.parametrize(
    "grant_khac",
    ["impo.diecut", "packaging.dieline", "impo.nup", "impo.cnc", "impo.booklet"],
)
def test_grant_cua_tool_khac_khong_mo_duoc(gate, monkeypatch, grant_khac):
    """§8 quy tắc 6: quyền cũ không được dùng làm tên thay thế."""
    client, hien_tai, goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    hien_tai["license"] = _license("free", [grant_khac])
    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 403
    assert goi == [], f"engine bị chạm với grant {grant_khac}: {goi}"


def test_pro_va_dev_mo_duoc(gate, monkeypatch):
    client, hien_tai, _goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    for plan in ("pro", "dev"):
        hien_tai["license"] = _license(plan, None)
        response = client.post("/api/mixed-nesting/jobs", json=_body())
        assert response.status_code == 202, f"{plan}: {response.text}"


def test_grant_sao_mo_duoc(gate, monkeypatch):
    client, hien_tai, _goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    hien_tai["license"] = _license("free", ["*"])
    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 202


# ─────────────────────────────────────────────────────────────────────────────
#  2. Rollout flag → 404
# ─────────────────────────────────────────────────────────────────────────────


def test_hold_chan_404_truoc_khi_cham_engine(gate, monkeypatch):
    client, _hien_tai, goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "false")
    monkeypatch.setattr(route.settings, "DEV_MODE", False)

    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 404
    assert client.get("/api/mixed-nesting/capabilities").status_code == 404
    assert goi == [], f"engine bị chạm dù đang HOLD: {goi}"


def test_thieu_bien_moi_truong_la_hold(gate, monkeypatch):
    client, _hien_tai, goi, _registry = gate
    monkeypatch.delenv("PRYNX_MIXED_NESTING_ENABLED", raising=False)
    monkeypatch.setattr(route.settings, "DEV_MODE", False)
    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 404
    assert goi == []


def test_tat_co_giua_dong_van_huy_va_xoa_duoc_job_dang_ton_tai(gate, monkeypatch):
    """§8 quy tắc 3: tắt cờ không được biến job đang chạy thành rác không dọn được."""
    client, _hien_tai, _goi, _registry = gate
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]

    # Cờ bị tắt giữa lúc job còn trong registry.
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "false")
    monkeypatch.setattr(route.settings, "DEV_MODE", False)

    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 404
    # Nhưng job cũ vẫn quản được:
    assert client.get(f"/api/mixed-nesting/jobs/{job_id}").status_code == 200
    assert client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel").status_code == 200
    assert client.delete(f"/api/mixed-nesting/jobs/{job_id}").status_code == 200


def test_quyen_va_co_la_hai_lop_doc_lap(gate, monkeypatch):
    """Free + cờ bật → 403. Pro + cờ tắt → 404. Hai lớp không thay nhau được."""
    client, hien_tai, _goi, _registry = gate
    monkeypatch.setattr(route.settings, "DEV_MODE", False)

    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    hien_tai["license"] = _license("free", [])
    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 403

    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "false")
    hien_tai["license"] = _license("pro", None)
    assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
#  3. Native thiếu → 503, KHÔNG fallback
# ─────────────────────────────────────────────────────────────────────────────


def test_native_thieu_tra_503_va_khong_fallback(monkeypatch):
    """§20 ghi rõ fallback sang solver cũ là NO-GO."""
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)

    def khong_co_native():
        raise svc.EngineUnavailableError(
            "Chưa cài phần lõi tính toán (pdfcompare_native)."
        )

    registry = MixedNestingJobRegistry(
        max_queued=2,
        ttl_seconds=60.0,
        slot_factory=lambda: nullcontext(),
        run_factory=khong_co_native,
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setattr(route, "engine_capabilities", khong_co_native)
    app.dependency_overrides[require_license] = lambda: _license("pro", None)
    try:
        with TestClient(app) as client:
            capabilities = client.get("/api/mixed-nesting/capabilities")
            assert capabilities.status_code == 503, capabilities.text
            assert capabilities.json()["detail"]["code"] == "ENGINE_UNAVAILABLE"

            # Job vẫn nhận 202 (đã qua gate) rồi FAIL với mã rõ ràng — không có nhánh
            # nào âm thầm chuyển sang solver bình bài cũ.
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            import time

            deadline = time.monotonic() + 20.0
            while time.monotonic() < deadline:
                status = client.get(f"/api/mixed-nesting/jobs/{job_id}").json()
                if status["terminal"]:
                    break
                time.sleep(0.02)
            else:
                pytest.fail("job không về terminal")

            assert status["status"] == "failed"
            assert status["errorCode"] == "ENGINE_UNAVAILABLE"
            assert client.get(f"/api/mixed-nesting/jobs/{job_id}/result").status_code == 409
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def _moi_module_duoc_import(path) -> set[str]:
    """Danh sách module thật sự được import, lấy bằng AST.

    Cố ý KHÔNG dùng ``in source``: cách đó đỏ oan vì tên biến (``nfp_raw_mb``) hay vì
    doc comment nhắc tới đường dẫn crate Rust (``imposition_core/src/...``). Chỉ có câu
    import mới là bằng chứng phụ thuộc.
    """
    import ast

    tree = ast.parse(path.read_text(encoding="utf-8"))
    ten: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            ten.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            ten.add(node.module)
    return ten


def test_route_khong_import_solver_cu():
    """Bằng chứng cấu trúc: không có đường nào để fallback, kể cả vô tình."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    #: Module của các solver/tính năng cũ. Chạm tới là mở đường fallback im lặng.
    CAM = (
        "app.core.imposition",
        "app.api.routes.imposition",
        "app.core.sticker_engine",
        "app.core.nfp",
        "app.core.print_engine",
        "app.workers.cut_export",
        "app.core.dieline",
        "app.api.routes.dieline",
    )
    for relative in (
        "backend/app/api/routes/mixed_nesting.py",
        "backend/app/core/mixed_nesting_jobs.py",
        "backend/app/core/mixed_nesting_service.py",
        "backend/app/schemas/mixed_nesting.py",
    ):
        modules = _moi_module_duoc_import(root / relative)
        for module in modules:
            for cam in CAM:
                assert not (module == cam or module.startswith(cam + ".")), (
                    f"{relative} import {module} — chạm solver/tính năng cũ"
                )

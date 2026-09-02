"""API "Bình lồng ghép tự do" — phase P7a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §8, §9.2, §12, §16.2.

Bộ test này **không cần native**: registry được tiêm ``run_factory`` giả lập để kiểm tầng
HTTP + vòng đời job một cách xác định. Đường đi qua engine thật là gate của P7b.

Sáu nhóm, khớp từng câu của gate P7a:

1. Cờ rollout mặc định **HOLD** → 404 trước cả bước dò native.
2. ``POST /jobs`` trả **202** ngay; status/result/cancel/delete đủ chuyển trạng thái.
3. **Owner isolation**: job của owner khác trả **404**, không phải 403.
4. **Bounded body**: quá trần thì 413 **trước** khi parse JSON.
5. **Server-owned ``jobId``**: client gửi ``jobId``/``geometryHash``/``sourceRevision``
   thì 422; mã trả về không phải mã client gửi.
6. **TTL và shutdown**: job terminal hết TTL bị dọn; ``close()`` dừng sweeper và hủy job.
"""

from __future__ import annotations

import re
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.routes import mixed_nesting as route
from app.core import mixed_nesting_jobs as jobs_module
from app.core import mixed_nesting_service as nesting_service
from app.core.license_guard import require_license
from app.core.mixed_nesting_jobs import MixedNestingJobRegistry, derive_owner
from app.main import app
from app.schemas.mixed_nesting import (
    MAX_REQUEST_BYTES,
    MIXED_NESTING_PROTOCOL_VERSION,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]

PRO_A = {
    "license_key": "TEST-PRO-A",
    "hwid": "HWID-A",
    "license_token": "",
    "verified": True,
    "plan": "pro",
    "features": ["*"],
}
PRO_B = {
    "license_key": "TEST-PRO-B",
    "hwid": "HWID-B",
    "license_token": "",
    "verified": True,
    "plan": "pro",
    "features": ["*"],
}
FREE = {
    "license_key": "TEST-FREE",
    "hwid": "HWID-A",
    "license_token": "",
    "verified": True,
    "plan": "free",
    "features": [],
}


# ─────────────────────────────────────────────────────────────────────────────
#  Engine giả lập
# ─────────────────────────────────────────────────────────────────────────────


class FakeRun:
    """Engine giả: đủ hình dạng API thật, nhưng thời gian chạy do test điều khiển."""

    def __init__(self, *, hold: threading.Event | None = None, raise_exc: BaseException | None = None):
        self._hold = hold
        self._raise = raise_exc
        self._cancelled = threading.Event()
        self.solve_started = threading.Event()

    def solve(self, request: dict[str, Any]) -> dict[str, Any]:
        self.solve_started.set()
        if self._hold is not None:
            # Chờ có kiểm cancel để test hủy được job đang chạy.
            while not self._hold.wait(0.01):
                if self._cancelled.is_set():
                    from app.core.mixed_nesting_service import MixedNestingError

                    raise MixedNestingError(
                        "MIXED_NESTING_CANCELLED", "Đã hủy.", 409
                    )
        if self._raise is not None:
            raise self._raise
        return {
            "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
            "engineVersion": "0.2.0",
            "jobId": request.get("jobId"),
            "seed": request.get("seed"),
            "status": "completed",
            "placements": [
                {
                    "instanceId": "part-a#0001",
                    "partId": "part-a",
                    "sheetIndex": 0,
                    "pose": {
                        "rotationDeg": 13.372849,
                        "translateXmm": 123.456789,
                        "translateYmm": 67.891234,
                    },
                }
            ],
            "unplaced": [],
            "stats": {"sheetCount": 1, "placedCount": 1, "unplacedCount": 0},
            "validation": {"valid": True, "validatorVersion": 1},
        }

    def progress(self) -> dict[str, Any]:
        return {
            "phase": "nesting",
            "progress": 0.42,
            "attempt": 3,
            "elapsedMs": 120,
            "messageCode": "NESTING",
        }

    def cancel(self) -> None:
        self._cancelled.set()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()


class FakeRunTraManifestSauCancel(FakeRun):
    """Mô phỏng wheel cũ/race: cancel đã đến nhưng solve vẫn trả manifest completed."""

    def solve(self, request: dict[str, Any]) -> dict[str, Any]:
        self.solve_started.set()
        if self._hold is not None:
            self._hold.wait(5.0)
        # Cố tình bỏ qua `_cancelled`: registry phải là publication fence độc lập.
        return FakeRun().solve(request)

    def progress(self) -> dict[str, Any]:
        progress = super().progress()
        progress.update(
            phase="completed", progress=1.0, messageCode="finished"
        )
        return progress


class FakeRunKetThucTheoNganSach(FakeRun):
    """Deadline/work budget là completed best-barrier, không phải cancel."""

    def solve(self, request: dict[str, Any]) -> dict[str, Any]:
        manifest = super().solve(request)
        manifest["stats"]["terminationReason"] = "work_budget_exhausted"
        return manifest


def _rect(w: float, h: float) -> list[list[float]]:
    return [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]


def _body(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 20260826,
        "profile": "fast",
        "sheet": {
            "widthMm": 700.0,
            "heightMm": 1000.0,
            "marginMm": {"left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0},
            "maxSheets": 20,
        },
        "gapMm": 3.0,
        "orientationPolicy": {
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": "part-a",
                "quantity": 4,
                "outer": _rect(90.0, 60.0),
                "holes": [],
                "rotationConstraint": {"mode": "inherit"},
            }
        ],
    }
    payload.update(overrides)
    return payload


# ─────────────────────────────────────────────────────────────────────────────
#  Fixture
# ─────────────────────────────────────────────────────────────────────────────


def _cho_run_factory(runs: list[FakeRun], timeout: float = 5.0) -> FakeRun:
    """Chờ executor gọi ``run_factory`` xong rồi mới trả engine giả đầu tiên.

    ``POST /jobs`` trả 202 **ngay khi** job vào registry và được submit; thread của executor
    chạy sau đó. Đọc ``runs`` liền sau POST là một cuộc đua — và ``assert runs and ...``
    short-circuit nên nó đỏ NGAY, không hề chờ hết timeout. Đo được: đỏ 1/6 lượt, lượt đỏ chỉ
    tốn 3,4s (bằng lượt xanh), đúng dấu hiệu short-circuit chứ không phải hết giờ chờ.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if runs:
            return runs[0]
        time.sleep(0.01)
    pytest.fail(f"executor không gọi run_factory trong {timeout}s")


@pytest.fixture()
def api(monkeypatch):
    """Client + registry riêng, engine giả, cờ rollout BẬT, license Pro A."""
    runs: list[FakeRun] = []

    def run_factory():
        run = FakeRun()
        runs.append(run)
        return run

    registry = MixedNestingJobRegistry(
        max_queued=3,
        ttl_seconds=60.0,
        # `nullcontext` để test không phụ thuộc suất whole-machine của scheduler thật;
        # phần scheduler đã có test riêng ở `test_heavy_scheduler_kind_gate.py`.
        slot_factory=lambda: nullcontext(),
        run_factory=run_factory,
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            yield client, registry, runs
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def _cho_terminal(client: TestClient, job_id: str, timeout: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/mixed-nesting/jobs/{job_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["terminal"]:
            return payload
        time.sleep(0.02)
    pytest.fail(f"job {job_id} không về terminal trong {timeout}s")


# ─────────────────────────────────────────────────────────────────────────────
#  1. Cờ rollout mặc định HOLD
# ─────────────────────────────────────────────────────────────────────────────


def test_co_rollout_mac_dinh_hold(monkeypatch):
    """Không có cờ, không phải dev thông dịch → HOLD."""
    monkeypatch.delenv("PRYNX_MIXED_NESTING_ENABLED", raising=False)
    assert route._runtime_enabled(is_development=False, is_compiled=True) is False
    assert route._runtime_enabled(is_development=True, is_compiled=True) is False
    # Bản compiled chỉ mở khi cờ bật tường minh.
    assert (
        route._runtime_enabled(is_development=False, is_compiled=True, release_flag="true")
        is True
    )
    # Dev chạy Python thông dịch vẫn mở như các tính năng khác.
    assert route._runtime_enabled(is_development=True, is_compiled=False) is True


@pytest.mark.parametrize("gia_tri", ["", "false", "FALSE", "0", "yes", "on", "  "])
def test_co_rollout_chi_mo_khi_dung_literal_true(gia_tri):
    assert (
        route._runtime_enabled(
            is_development=False, is_compiled=True, release_flag=gia_tri
        )
        is False
    )


def test_hold_tra_404_truoc_khi_cham_native(monkeypatch):
    """Fail-closed phải xảy ra TRƯỚC bước nạp engine."""
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "false")
    monkeypatch.setattr(route.settings, "DEV_MODE", False)

    def _no_dung_goi():  # pragma: no cover - gọi tới là test đỏ
        pytest.fail("HOLD phải chặn trước khi dò native")

    monkeypatch.setattr(route, "engine_capabilities", _no_dung_goi)
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            assert client.get("/api/mixed-nesting/capabilities").status_code == 404
            assert (
                client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 404
            )
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_capabilities_cong_bo_protocol_v2_va_layout_intents(api, monkeypatch):
    client, _registry, _runs = api
    capabilities = nesting_service.EngineCapabilities(
        protocol_version=MIXED_NESTING_PROTOCOL_VERSION,
        engine_version="0.2.0",
        reflection="forbidden",
        default_rotation="free",
        continuous_translation=True,
        profiles=("fast", "balanced", "tight"),
        layout_intents=("quantity_fulfillment", "autofill_single_sheet"),
    )
    monkeypatch.setattr(route, "engine_capabilities", lambda: capabilities)

    response = client.get("/api/mixed-nesting/capabilities")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["protocolVersion"] == MIXED_NESTING_PROTOCOL_VERSION
    assert payload["engineVersion"] == "0.2.0"
    assert payload["reflection"] == "forbidden"
    assert payload["defaultRotation"] == "free"
    assert payload["continuousTranslation"] is True
    assert set(payload["profiles"]) == {"fast", "balanced", "tight"}
    assert set(payload["layoutIntents"]) == {
        "quantity_fulfillment",
        "autofill_single_sheet",
    }
    assert payload["maxRequestBytes"] == MAX_REQUEST_BYTES


def test_free_bi_chan_403_truoc_engine(monkeypatch):
    """Quyền là lớp riêng với cờ: Free bị 403 kể cả khi cờ đã bật."""
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    monkeypatch.setattr("app.core.feature_entitlements.FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: FREE
    try:
        with TestClient(app) as client:
            assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 403
            assert client.get("/api/mixed-nesting/jobs/khong-ton-tai").status_code == 403
    finally:
        app.dependency_overrides.pop(require_license, None)


# ─────────────────────────────────────────────────────────────────────────────
#  2. Vòng đời job
# ─────────────────────────────────────────────────────────────────────────────


def test_post_jobs_tra_202_va_khong_chan(api):
    client, _registry, _runs = api
    started = time.monotonic()
    response = client.post("/api/mixed-nesting/jobs", json=_body())
    elapsed = time.monotonic() - started

    assert response.status_code == 202, response.text
    assert elapsed < 2.0, f"POST /jobs chặn {elapsed:.2f}s — phải trả 202 ngay"
    payload = response.json()
    assert re.fullmatch(r"[0-9a-f]{32}", payload["jobId"]), payload
    # Engine giả có thể xong TRƯỚC khi ta đọc phản hồi, nên trạng thái hợp lệ gồm cả
    # terminal. Điều test này chốt là 202 + jobId server-owned, không phải một pha cụ thể.
    assert payload["status"] in {
        "queued",
        "waiting_resources",
        "normalizing",
        "completed",
        "cancelled",
        "failed",
    }, payload


def test_status_roi_result_day_du(api):
    client, _registry, _runs = api
    job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]

    final = _cho_terminal(client, job_id)
    assert final["status"] == "completed"
    assert final["terminal"] is True
    assert final["cancelRequested"] is False

    result = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
    assert result.status_code == 200, result.text
    manifest = result.json()
    assert manifest["validation"]["valid"] is True
    assert manifest["jobId"] == job_id, "manifest phải mang đúng jobId server sinh"
    # Pose giữ nguyên precision qua JSON: góc không-cardinal và X/Y phần lẻ.
    pose = manifest["placements"][0]["pose"]
    assert pose["rotationDeg"] == 13.372849
    assert pose["translateXmm"] == 123.456789
    assert pose["translateYmm"] == 67.891234


def test_result_khi_chua_xong_tra_409(monkeypatch):
    hold = threading.Event()
    run = FakeRun(hold=hold)
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            assert run.solve_started.wait(5.0), "job phải bắt đầu chạy"
            response = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
            assert response.status_code == 409, response.text
            assert "chưa hoàn tất" in response.json()["detail"]
    finally:
        hold.set()
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_job_that_bai_thi_status_mang_ma_loi(monkeypatch):
    from app.core.mixed_nesting_service import MixedNestingError

    run = FakeRun(
        raise_exc=MixedNestingError(
            "MIXED_NESTING_INVALID_GEOMETRY", "Contour tự cắt.", 422
        )
    )
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            final = _cho_terminal(client, job_id)
            assert final["status"] == "failed"
            assert final["errorCode"] == "MIXED_NESTING_INVALID_GEOMETRY"
            # Result của job failed trả 409 kèm mã, không trả layout dở dang.
            response = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "MIXED_NESTING_INVALID_GEOMETRY"
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_cancel_dang_chay_va_idempotent(monkeypatch):
    hold = threading.Event()
    run = FakeRun(hold=hold)
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            assert run.solve_started.wait(5.0)

            first = client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
            assert first.status_code == 200, first.text
            assert first.json()["cancelled"] is True
            assert first.json()["alreadyCancelled"] is False

            final = _cho_terminal(client, job_id)
            assert final["status"] == "cancelled"

            # Hủy lại job terminal: no-op, không lỗi.
            second = client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
            assert second.status_code == 200
            assert second.json()["terminal"] is True
            assert second.json()["alreadyCancelled"] is True
            third = client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
            assert third.json() == second.json(), "hủy nhiều lần phải cho cùng kết quả"

            # Cancel không được publish layout.
            assert client.get(f"/api/mixed-nesting/jobs/{job_id}/result").status_code == 409
    finally:
        hold.set()
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_cancel_thang_manifest_completed_tra_ve_sau_publication_fence(monkeypatch):
    """Cancel đến trong solve: registry phải bỏ manifest dù engine vẫn trả completed."""
    hold = threading.Event()
    run = FakeRunTraManifestSauCancel(hold=hold)
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            assert run.solve_started.wait(5.0)
            cancelled = client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
            assert cancelled.status_code == 200, cancelled.text
            waiting = client.get(f"/api/mixed-nesting/jobs/{job_id}").json()
            assert waiting["status"] == "cancel_requested"
            assert waiting["terminal"] is False
            assert waiting["cancelRequested"] is True
            assert waiting["progress"]["phase"] == waiting["status"]
            hold.set()

            final = _cho_terminal(client, job_id)
            assert final["status"] == "cancelled"
            assert final["errorCode"] == "MIXED_NESTING_CANCELLED"
            assert final["cancelRequested"] is True
            assert final["progress"]["phase"] == final["status"]
            assert registry.get_result(job_id, derive_owner(PRO_A)) is None

            result = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
            assert result.status_code == 409, result.text
            detail = result.json()["detail"]
            assert detail["code"] == "MIXED_NESTING_CANCELLED"
            assert detail["status"] == "cancelled"
    finally:
        hold.set()
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_het_ngan_sach_van_completed_va_result_200(monkeypatch):
    run = FakeRunKetThucTheoNganSach()
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            final = _cho_terminal(client, job_id)
            assert final["status"] == "completed"
            assert final["cancelRequested"] is False

            result = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
            assert result.status_code == 200, result.text
            assert result.json()["stats"]["terminationReason"] == "work_budget_exhausted"
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_cancel_khi_con_trong_hang_doi(monkeypatch):
    """Job thứ hai còn xếp hàng: hủy phải chuyển terminal ngay và nhả suất."""
    hold = threading.Event()
    runs: list[FakeRun] = []

    def run_factory():
        run = FakeRun(hold=hold)
        runs.append(run)
        return run

    registry = MixedNestingJobRegistry(
        max_queued=3,
        ttl_seconds=60.0,
        slot_factory=lambda: nullcontext(),
        run_factory=run_factory,
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            first = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            assert _cho_run_factory(runs).solve_started.wait(5.0)
            # Executor chỉ 1 worker nên job này nằm chờ.
            second = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]

            outcome = client.post(f"/api/mixed-nesting/jobs/{second}/cancel").json()
            assert outcome["cancelled"] is True
            status = client.get(f"/api/mixed-nesting/jobs/{second}").json()
            assert status["status"] == "cancelled"
            assert status["terminal"] is True

            # Nhả suất đúng một lần: vẫn nhận được job mới.
            assert client.post("/api/mixed-nesting/jobs", json=_body()).status_code == 202
            assert first != second
    finally:
        hold.set()
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_delete_job(api):
    client, _registry, _runs = api
    job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
    _cho_terminal(client, job_id)

    response = client.delete(f"/api/mixed-nesting/jobs/{job_id}")
    assert response.status_code == 200
    assert response.json() == {"jobId": job_id, "deleted": True}

    # Đã xóa thì mọi endpoint đều 404.
    assert client.get(f"/api/mixed-nesting/jobs/{job_id}").status_code == 404
    assert client.get(f"/api/mixed-nesting/jobs/{job_id}/result").status_code == 404
    assert client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel").status_code == 404
    assert client.delete(f"/api/mixed-nesting/jobs/{job_id}").status_code == 404


def test_job_khong_ton_tai_tra_404(api):
    client, _registry, _runs = api
    for path, method in (
        ("/api/mixed-nesting/jobs/deadbeef", "get"),
        ("/api/mixed-nesting/jobs/deadbeef/result", "get"),
        ("/api/mixed-nesting/jobs/deadbeef/cancel", "post"),
        ("/api/mixed-nesting/jobs/deadbeef", "delete"),
    ):
        response = getattr(client, method)(path)
        assert response.status_code == 404, f"{method.upper()} {path} → {response.status_code}"


def test_progress_doc_duoc_trong_luc_job_chay(monkeypatch):
    hold = threading.Event()
    run = FakeRun(hold=hold)
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            assert run.solve_started.wait(5.0)
            status = client.get(f"/api/mixed-nesting/jobs/{job_id}").json()
            assert status["progress"] is not None
            assert status["progress"]["phase"] == "nesting"
            assert status["progress"]["progress"] == pytest.approx(0.42)
            assert status["progress"]["messageCode"] == "NESTING"
    finally:
        hold.set()
        app.dependency_overrides.pop(require_license, None)
        registry.close()


# ─────────────────────────────────────────────────────────────────────────────
#  3. Owner isolation
# ─────────────────────────────────────────────────────────────────────────────


def test_owner_dan_xuat_tu_license_khong_phai_tu_client():
    a = derive_owner(PRO_A)
    b = derive_owner(PRO_B)
    assert a != b
    assert len(a) == 32 and re.fullmatch(r"[0-9a-f]{32}", a)
    # Không lộ license key trong owner id.
    assert PRO_A["license_key"] not in a
    # Cùng cặp (key, hwid) → cùng owner; đổi một trong hai → owner khác.
    assert derive_owner(dict(PRO_A)) == a
    assert derive_owner({**PRO_A, "hwid": "HWID-KHAC"}) != a
    assert derive_owner({**PRO_A, "license_key": "KHAC"}) != a
    # Không có khóa nào của client tham gia: `ownerId` client khai bị bỏ qua hoàn toàn.
    assert derive_owner({**PRO_A, "owner_id": "ai-cung-khai-duoc"}) == a


def test_job_cua_owner_khac_tra_404_khong_phai_403(monkeypatch):
    """404 để không tiết lộ job có tồn tại (§16.2)."""
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=FakeRun
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")

    hien_tai: dict[str, Any] = {"license": PRO_A}
    app.dependency_overrides[require_license] = lambda: hien_tai["license"]
    try:
        with TestClient(app) as client:
            job_id = client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
            _cho_terminal(client, job_id)
            assert client.get(f"/api/mixed-nesting/jobs/{job_id}").status_code == 200

            hien_tai["license"] = PRO_B
            assert client.get(f"/api/mixed-nesting/jobs/{job_id}").status_code == 404
            assert client.get(f"/api/mixed-nesting/jobs/{job_id}/result").status_code == 404
            assert client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel").status_code == 404
            assert client.delete(f"/api/mixed-nesting/jobs/{job_id}").status_code == 404

            # Owner thật vẫn dùng được: owner B không xóa được job của A.
            hien_tai["license"] = PRO_A
            assert client.get(f"/api/mixed-nesting/jobs/{job_id}/result").status_code == 200
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def test_tran_so_job_moi_owner():
    registry = MixedNestingJobRegistry(
        max_queued=64,
        ttl_seconds=60.0,
        max_jobs_per_owner=2,
        slot_factory=lambda: nullcontext(),
        run_factory=FakeRun,
    )
    try:
        owner = derive_owner(PRO_A)
        for _ in range(2):
            registry.submit(owner=owner, build_request=lambda job_id: {"jobId": job_id})
        with pytest.raises(jobs_module.MixedNestingQueueFull):
            registry.submit(owner=owner, build_request=lambda job_id: {"jobId": job_id})
        # Owner khác không bị ảnh hưởng bởi trần của owner này.
        registry.submit(
            owner=derive_owner(PRO_B), build_request=lambda job_id: {"jobId": job_id}
        )
    finally:
        registry.close()


# ─────────────────────────────────────────────────────────────────────────────
#  4. Bounded body
# ─────────────────────────────────────────────────────────────────────────────


def test_content_length_qua_lon_tra_413_truoc_khi_parse(api, monkeypatch):
    client, _registry, _runs = api

    def _no_dung_parse(_raw):  # pragma: no cover - gọi tới là test đỏ
        pytest.fail("phải chặn theo byte TRƯỚC khi parse JSON")

    monkeypatch.setattr(route, "_parse_create_request", _no_dung_parse)
    response = client.post(
        "/api/mixed-nesting/jobs",
        content=b"{}",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(MAX_REQUEST_BYTES + 1),
        },
    )
    assert response.status_code == 413, response.text


def test_body_thuc_te_qua_lon_tra_413(api, monkeypatch):
    """Trần phải áp cả khi client không khai Content-Length trung thực."""
    client, _registry, _runs = api
    monkeypatch.setattr(route, "MAX_REQUEST_BYTES", 512)
    payload = b'{"parts":"' + b"x" * 4096 + b'"}'
    response = client.post(
        "/api/mixed-nesting/jobs",
        content=payload,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413, response.text


def test_content_length_khong_hop_le_tra_400(api):
    client, _registry, _runs = api
    response = client.post(
        "/api/mixed-nesting/jobs",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "khong-phai-so"},
    )
    assert response.status_code in {400, 422}, response.text


def test_body_rong_va_json_xau(api):
    client, _registry, _runs = api
    assert client.post("/api/mixed-nesting/jobs", content=b"").status_code == 422
    assert client.post("/api/mixed-nesting/jobs", content=b"khong-phai-json").status_code == 422
    assert client.post("/api/mixed-nesting/jobs", content=b"[1,2,3]").status_code == 422


# ─────────────────────────────────────────────────────────────────────────────
#  5. Server-owned jobId/revision, và hợp đồng dữ liệu
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "truong",
    ["jobId", "geometryHash", "sourceRevision", "translationStepMm", "angleStepDeg"],
)
def test_client_khong_duoc_gui_truong_server_owned(api, truong):
    client, _registry, _runs = api
    response = client.post("/api/mixed-nesting/jobs", json=_body(**{truong: "x"}))
    assert response.status_code == 422, f"{truong} phải bị từ chối, không bị bỏ qua"


@pytest.mark.parametrize("truong", ["referencePointMm", "geometryHash", "sourceRevision"])
def test_part_khong_duoc_gui_truong_server_owned(api, truong):
    client, _registry, _runs = api
    body = _body()
    body["parts"][0][truong] = [1.0, 2.0] if truong == "referencePointMm" else "x"
    assert client.post("/api/mixed-nesting/jobs", json=body).status_code == 422


def test_job_id_do_server_sinh_khong_theo_client(api):
    client, _registry, _runs = api
    # Client không gửi được jobId (test trên), nên chỉ cần chứng minh hai job liên tiếp
    # có mã khác nhau và đúng dạng CSPRNG hex 32.
    ids = {
        client.post("/api/mixed-nesting/jobs", json=_body()).json()["jobId"]
        for _ in range(3)
    }
    assert len(ids) == 3
    assert all(re.fullmatch(r"[0-9a-f]{32}", value) for value in ids)


@pytest.mark.parametrize(
    "sua",
    [
        {"protocolVersion": MIXED_NESTING_PROTOCOL_VERSION - 1},
        {"protocolVersion": 0},
        {"protocolVersion": MIXED_NESTING_PROTOCOL_VERSION + 1},
        {"seed": -1},
        {"gapMm": -1.0},
        {"profile": "turbo"},
        {"timeBudgetMs": 0},
        {"parts": []},
        {"orientationPolicy": {"defaultRotation": {"mode": "free"}, "reflection": "allowed"}},
        {"orientationPolicy": {"defaultRotation": {"mode": "inherit"}, "reflection": "forbidden"}},
    ],
)
def test_request_sai_hop_dong_tra_422(api, sua):
    client, _registry, _runs = api
    assert client.post("/api/mixed-nesting/jobs", json=_body(**sua)).status_code == 422


@pytest.mark.parametrize(
    "case",
    [
        "quantity_missing",
        "quantity_null",
        "autofill_quantity",
        "autofill_quantity_null",
        "autofill_many_sheets",
    ],
)
def test_layout_intent_sai_tra_422_truoc_khi_tao_run(api, case):
    client, _registry, runs = api
    body = _body()
    if case == "quantity_missing":
        del body["parts"][0]["quantity"]
    elif case == "quantity_null":
        body["parts"][0]["quantity"] = None
    else:
        body["layoutIntent"] = "autofill_single_sheet"
        body["sheet"]["maxSheets"] = 1
        if case == "autofill_quantity_null":
            body["parts"][0]["quantity"] = None
        elif case == "autofill_many_sheets":
            del body["parts"][0]["quantity"]
            body["sheet"]["maxSheets"] = 2

    response = client.post("/api/mixed-nesting/jobs", json=body)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "MIXED_NESTING_INVALID_REQUEST"
    assert runs == [], "request sai phải bị chặn trước khi tạo engine run"


@pytest.mark.parametrize(
    "rotation",
    [
        {"mode": "free"},
        {"mode": "fixed", "angleDeg": 13.372849},
        {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]},
        {"mode": "discrete", "anglesDeg": [12.5, 41.25]},
        {"mode": "ranges", "arcs": [{"startDeg": 350.0, "sweepDeg": 20.0}]},
        {"mode": "inherit"},
    ],
)
def test_moi_mode_rotation_hop_le_deu_nhan(api, rotation):
    client, _registry, _runs = api
    body = _body()
    body["parts"][0]["rotationConstraint"] = rotation
    assert client.post("/api/mixed-nesting/jobs", json=body).status_code == 202


@pytest.mark.parametrize(
    "rotation",
    [
        {"mode": "khong-co"},
        {"mode": "fixed"},
        {"mode": "fixed", "angleDeg": 0.0, "angleStepDeg": 90.0},
        {"mode": "discrete", "anglesDeg": []},
        {"mode": "free", "anglesDeg": [0.0]},
        {"mode": "ranges", "arcs": []},
        {"mode": "ranges", "arcs": [{"startDeg": 0.0, "sweepDeg": 0.0}]},
        {"mode": "ranges", "arcs": [{"startDeg": 0.0, "sweepDeg": 361.0}]},
        {"mode": "ranges", "rangesDeg": [{"startDeg": 0.0, "sweepDeg": 10.0}]},
    ],
)
def test_rotation_sai_bi_tu_choi(api, rotation):
    client, _registry, _runs = api
    body = _body()
    body["parts"][0]["rotationConstraint"] = rotation
    assert client.post("/api/mixed-nesting/jobs", json=body).status_code == 422


def test_part_id_trung_bi_tu_choi(api):
    client, _registry, _runs = api
    body = _body()
    body["parts"].append(dict(body["parts"][0]))
    assert client.post("/api/mixed-nesting/jobs", json=body).status_code == 422


def test_gia_tri_khong_huu_han_bi_tu_choi(api):
    client, _registry, _runs = api
    # JSON không có NaN/Infinity; gửi dạng literal thì phải là 422, không phải 500.
    for raw in (b'{"gapMm": NaN}', b'{"gapMm": Infinity}'):
        assert client.post("/api/mixed-nesting/jobs", content=raw).status_code == 422


def test_gioi_han_schema_khop_hop_dong_rust():
    """Giới hạn của Pydantic phải khớp `model.rs`, nếu không engine sẽ từ chối sau."""
    from app.schemas import mixed_nesting as schema

    source = (
        _REPO_ROOT / "imposition_core" / "src" / "mixed_nesting" / "model.rs"
    ).read_text(encoding="utf-8")

    def _rust(name: str) -> int:
        match = re.search(
            rf"pub const {name}:\s*\w+\s*=\s*([0-9_]+(?:\s*\*\s*[0-9_]+)*)\s*;", source
        )
        assert match is not None, f"không thấy {name} trong model.rs"
        return eval(match.group(1).replace("_", ""))  # noqa: S307 - chỉ số và dấu *

    for name in (
        "MAX_PARTS",
        "MAX_QUANTITY_PER_PART",
        "MAX_INSTANCES_TOTAL",
        "MAX_RING_VERTICES",
        "MAX_TOTAL_VERTICES",
        "MAX_HOLES_PER_PART",
        "MAX_SHEETS_LIMIT",
        "MAX_PART_ID_LEN",
        "MAX_ROTATION_ANGLES",
        "MAX_ROTATION_ARCS",
        "MAX_TIME_BUDGET_MS",
    ):
        assert getattr(schema, name) == _rust(name), name
    assert schema.MIXED_NESTING_PROTOCOL_VERSION == _rust(
        "MIXED_NESTING_PROTOCOL_VERSION"
    )


def test_request_noi_bo_dung_camel_case_va_bo_none():
    """Request gửi Rust phải khớp `deny_unknown_fields` + `Option` bỏ khi vắng."""
    from app.schemas.mixed_nesting import CreateJobRequest

    body = CreateJobRequest.model_validate(_body())
    payload = body.to_engine_request(job_id="abc123")
    assert payload["jobId"] == "abc123"
    assert "timeBudgetMs" not in payload, "None phải bị loại, không gửi null"
    assert set(payload) == {
        "protocolVersion",
        "seed",
        "profile",
        "sheet",
        "gapMm",
        "layoutIntent",
        "orientationPolicy",
        "parts",
        "jobId",
    }
    assert payload["layoutIntent"] == "quantity_fulfillment"
    assert set(payload["sheet"]) == {"widthMm", "heightMm", "marginMm", "maxSheets"}
    assert set(payload["parts"][0]) == {
        "partId",
        "quantity",
        "outer",
        "holes",
        "rotationConstraint",
    }

    voi_budget = CreateJobRequest.model_validate(_body(timeBudgetMs=5000))
    assert voi_budget.to_engine_request(job_id="x")["timeBudgetMs"] == 5000


def test_layout_intent_kiem_soat_quantity_va_mot_to():
    from app.schemas.mixed_nesting import CreateJobRequest

    # Payload cũ có quantity, thiếu layoutIntent vẫn giữ nguyên hành vi.
    legacy = CreateJobRequest.model_validate(_body())
    assert legacy.layout_intent == "quantity_fulfillment"

    thieu_quantity = _body()
    del thieu_quantity["parts"][0]["quantity"]
    with pytest.raises(ValidationError, match="quantity"):
        CreateJobRequest.model_validate(thieu_quantity)

    null_quantity = _body()
    null_quantity["parts"][0]["quantity"] = None
    with pytest.raises(ValidationError, match="quantity"):
        CreateJobRequest.model_validate(null_quantity)

    autofill = _body(layoutIntent="autofill_single_sheet")
    autofill["sheet"]["maxSheets"] = 1
    del autofill["parts"][0]["quantity"]
    parsed = CreateJobRequest.model_validate(autofill)
    payload = parsed.to_engine_request(job_id="autofill")
    assert payload["layoutIntent"] == "autofill_single_sheet"
    assert "quantity" not in payload["parts"][0]

    for bad_quantity in (4, None):
        invalid = _body(layoutIntent="autofill_single_sheet")
        invalid["sheet"]["maxSheets"] = 1
        invalid["parts"][0]["quantity"] = bad_quantity
        with pytest.raises(ValidationError, match="quantity"):
            CreateJobRequest.model_validate(invalid)

    wrong_sheet = dict(autofill)
    wrong_sheet["sheet"] = {**autofill["sheet"], "maxSheets": 2}
    with pytest.raises(ValidationError, match="maxSheets"):
        CreateJobRequest.model_validate(wrong_sheet)


# ─────────────────────────────────────────────────────────────────────────────
#  6. TTL, queue và shutdown
# ─────────────────────────────────────────────────────────────────────────────


def test_ttl_don_job_terminal():
    registry = MixedNestingJobRegistry(
        ttl_seconds=0.1, slot_factory=lambda: nullcontext(), run_factory=FakeRun
    )
    try:
        owner = derive_owner(PRO_A)
        snapshot = registry.submit(
            owner=owner, build_request=lambda job_id: {"jobId": job_id}
        )
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            current = registry.get(snapshot.job_id, owner)
            if current is not None and current.terminal:
                break
            time.sleep(0.02)
        else:
            pytest.fail("job không về terminal")

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if registry.get(snapshot.job_id, owner) is None:
                break
            time.sleep(0.05)
        else:
            pytest.fail("sweeper không dọn job terminal hết TTL")
    finally:
        registry.close()


def test_hang_doi_day_tra_429(api):
    client, registry, _runs = api
    # max_queued=3 và 1 worker → 4 suất. Job thứ 5 phải bị 429 nếu chưa job nào xong.
    hold = threading.Event()
    registry._run_factory = lambda: FakeRun(hold=hold)
    try:
        ma_loi = []
        for _ in range(8):
            response = client.post("/api/mixed-nesting/jobs", json=_body())
            ma_loi.append(response.status_code)
        assert 429 in ma_loi, f"hàng đợi không có trần: {ma_loi}"
        assert ma_loi.count(202) <= 4, f"nhận quá số suất đã cấp: {ma_loi}"
    finally:
        hold.set()


def test_close_dung_sweeper_va_huy_job_dang_chay():
    hold = threading.Event()
    run = FakeRun(hold=hold)
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=lambda: run
    )
    owner = derive_owner(PRO_A)
    registry.submit(owner=owner, build_request=lambda job_id: {"jobId": job_id})
    assert run.solve_started.wait(5.0)

    started = time.monotonic()
    registry.close()
    elapsed = time.monotonic() - started

    assert run.cancelled is True, "close() phải hủy job đang chạy"
    assert elapsed < 10.0, f"close() mất {elapsed:.1f}s — nghi chờ job vô hạn"
    assert not registry._sweeper_thread.is_alive(), "sweeper phải dừng"
    # Idempotent.
    registry.close()
    hold.set()


def test_close_roi_submit_thi_bi_tu_choi():
    registry = MixedNestingJobRegistry(
        ttl_seconds=60.0, slot_factory=lambda: nullcontext(), run_factory=FakeRun
    )
    registry.close()
    with pytest.raises(jobs_module.MixedNestingQueueFull):
        registry.submit(
            owner=derive_owner(PRO_A), build_request=lambda job_id: {"jobId": job_id}
        )


def test_lifespan_dong_registry_that():
    """`main.py` phải đóng registry thật trong shutdown, không chỉ trong test."""
    source = (_REPO_ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")
    assert "mixed_nesting_jobs" in source
    assert "mixed_nesting_jobs.close" in source
    assert "app.include_router(mixed_nesting.router" in source


def test_route_khong_thuoc_ho_imposition():
    """AppTool standalone: không được lọt vào registry họ Imposition (§7)."""
    source = (
        _REPO_ROOT / "backend" / "app" / "api" / "routes" / "mixed_nesting.py"
    ).read_text(encoding="utf-8")
    assert "imposition" not in source.lower().replace("mixed_nesting", "")
    for module in ("app.core.imposition", "app.api.routes.imposition", "nfp", "sticker"):
        assert f"import {module}" not in source

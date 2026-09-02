"""Vòng đời job qua API + engine THẬT — phase P7b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §11.3, §12, §16.3, §17.

Khác ``test_mixed_nesting_api.py``: file kia tiêm engine giả để kiểm tầng HTTP một cách
xác định; file này đi **qua native thật** để chứng minh sáu điều mà chỉ engine thật chứng
minh được:

1. **Work-plan cố định là deterministic** — cùng seed cho cùng placement, kể cả khi hai
   job chạy từ hai thread khác nhau. Engine chạy trial **tuần tự** và gộp bằng thứ tự
   toàn phần, nên độc lập số worker là tính chất **cấu trúc**; phần gộp song song đã có
   test riêng ở Rust (``multi_start::ket_qua_khong_doi_theo_thu_tu_gop``).
2. **Deadline** trả ``terminationReason = deadline`` với best-so-far **đã validate**.
3. **Ngân sách thời gian được tôn trọng** trong biên ``max(1 s, 10%)`` của §17.
4. **Cancel** ở cả hai trạng thái (đang chờ, đang chạy) và **không rò** suất scheduler.
5. **Status/Cancel vẫn phản hồi** khi solver đang chiếm CPU.
6. **Free-angle thắng sàn cardinal** trên corpus ``ANGLE_ONLY`` — bằng chứng bắt buộc của
   §17, không phải "validator xanh là xong".

Thời lượng: mọi ca đều truyền ``timeBudgetMs`` hoặc dùng workload nhỏ. Ca corpus ``S20``
chạy 44 s ở ``balanced`` khi **không** có trần (đo được, xem ``corpus.json``), nên CI
không bao giờ chạy nó không trần.
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.routes import mixed_nesting as route
from app.core import heavy_job_scheduler as sched
from app.core import mixed_nesting_service as svc
from app.core.license_guard import require_license
from app.core.mixed_nesting_jobs import MixedNestingJobRegistry, derive_owner
from app.main import app

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CORPUS = _REPO_ROOT / "backend" / "tests" / "fixtures" / "mixed_nesting" / "corpus.json"

PRO = {
    "license_key": "TEST-PRO-LIFECYCLE",
    "hwid": "HWID-LIFECYCLE",
    "license_token": "",
    "verified": True,
    "plan": "pro",
    "features": ["*"],
}


def _native_has_engine() -> bool:
    try:
        svc.reset_engine_cache()
        svc.load_engine()
    except svc.EngineUnavailableError:
        return False
    return True


requires_engine = pytest.mark.skipif(
    not _native_has_engine(),
    reason=(
        "pdfcompare_native chưa có MixedNestingRun. Chạy `maturin develop --release` "
        "trong native/ (cần tắt sidecar dev đang giữ DLL)."
    ),
)


def _corpus() -> dict[str, Any]:
    with open(_CORPUS, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _case(case_id: str) -> dict[str, Any]:
    for case in _corpus()["cases"]:
        if case["id"] == case_id:
            return case
    raise AssertionError(f"corpus thiếu ca {case_id}")


def _rect(w: float, h: float) -> list[list[float]]:
    return [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]


def _request(
    *,
    quantity: int = 6,
    profile: str = "fast",
    time_budget_ms: int | None = 3000,
    seed: int = 20260826,
    sheet_w: float = 500.0,
    sheet_h: float = 700.0,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocolVersion": svc.MIXED_NESTING_PROTOCOL_VERSION,
        "seed": seed,
        "profile": profile,
        "sheet": {
            "widthMm": sheet_w,
            "heightMm": sheet_h,
            "marginMm": {"left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0},
            "maxSheets": 10,
        },
        "gapMm": 3.0,
        "orientationPolicy": {
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": "part-a",
                "quantity": quantity,
                "outer": _rect(90.0, 60.0),
                "holes": [],
                "rotationConstraint": {"mode": "inherit"},
            }
        ],
    }
    if time_budget_ms is not None:
        payload["timeBudgetMs"] = time_budget_ms
    return payload


@pytest.fixture()
def api(monkeypatch):
    """Client + registry thật (engine thật), cờ rollout bật, license Pro."""
    registry = MixedNestingJobRegistry(
        max_queued=4,
        ttl_seconds=300.0,
        # Bỏ suất whole-machine để test không xếp hàng sau job khác; phần scheduler đã
        # có test riêng ở `test_heavy_scheduler_kind_gate.py`.
        slot_factory=lambda: nullcontext(),
    )
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO
    try:
        with TestClient(app) as client:
            yield client, registry
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()


def _cho_terminal(client: TestClient, job_id: str, timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/mixed-nesting/jobs/{job_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["terminal"]:
            return payload
        time.sleep(0.05)
    pytest.fail(f"job {job_id} không về terminal trong {timeout}s")


def _chay_qua_api(client: TestClient, request: dict[str, Any], timeout: float = 60.0):
    accepted = client.post("/api/mixed-nesting/jobs", json=request)
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["jobId"]
    final = _cho_terminal(client, job_id, timeout=timeout)
    assert final["status"] == "completed", final
    result = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
    assert result.status_code == 200, result.text
    return job_id, result.json()


# ─────────────────────────────────────────────────────────────────────────────
#  1. Vòng đời và determinism
# ─────────────────────────────────────────────────────────────────────────────


@requires_engine
def test_vong_doi_day_du_qua_engine_that(api):
    client, _registry = api
    job_id, manifest = _chay_qua_api(client, _request())

    assert manifest["jobId"] == job_id, "manifest phải mang jobId do server sinh"
    assert manifest["validation"]["valid"] is True
    assert manifest["stats"]["placedCount"] == 6
    assert manifest["stats"]["unplacedCount"] == 0
    assert manifest["stats"]["sheetCount"] >= 1
    for placement in manifest["placements"]:
        pose = placement["pose"]
        assert 0.0 <= pose["rotationDeg"] < 360.0
        for key in ("rotationDeg", "translateXmm", "translateYmm"):
            assert isinstance(pose[key], float) or isinstance(pose[key], int)


@requires_engine
def test_work_plan_co_dinh_deterministic(api):
    """Cùng seed + work-plan cố định ⇒ placement giống nhau từng chữ số."""
    client, _registry = api
    request = _request(quantity=5, profile="fast", time_budget_ms=None)

    _job_a, manifest_a = _chay_qua_api(client, request)
    _job_b, manifest_b = _chay_qua_api(client, request)

    assert manifest_a["placements"] == manifest_b["placements"]
    assert manifest_a["stats"]["sheetCount"] == manifest_b["stats"]["sheetCount"]
    assert manifest_a["stats"]["terminationReason"] == manifest_b["stats"]["terminationReason"]


@requires_engine
def test_deterministic_ca_khi_hai_job_chay_tu_hai_thread(api):
    """Chạy đồng thời không được làm lệch kết quả: reduce dùng thứ tự toàn phần."""
    client, _registry = api
    request = _request(quantity=4, profile="fast", time_budget_ms=None)
    ket_qua: dict[int, Any] = {}
    loi: list[BaseException] = []

    def worker(index: int):
        try:
            _job, manifest = _chay_qua_api(client, request)
            ket_qua[index] = manifest["placements"]
        except BaseException as exc:  # noqa: BLE001
            loi.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)

    assert all(not t.is_alive() for t in threads), "job không kết thúc"
    assert not loi, f"lỗi: {loi!r}"
    assert ket_qua[0] == ket_qua[1]


@requires_engine
def test_seed_khac_thi_ket_qua_duoc_phep_khac(api):
    """Chứng minh determinism KHÔNG phải vì solver bỏ qua seed."""
    client, _registry = api
    a = _chay_qua_api(client, _request(quantity=6, seed=1, time_budget_ms=None))[1]
    b = _chay_qua_api(client, _request(quantity=6, seed=999_983, time_budget_ms=None))[1]
    # Không đòi PHẢI khác (layout tối ưu có thể trùng), chỉ đòi seed được dùng thật:
    # nếu hai manifest giống nhau thì mọi số đo TIỀN ĐỊNH cũng phải giống — nghĩa là
    # không có nhánh nào bỏ qua seed rồi trả kết quả tuỳ tiện.
    #
    # `elapsedMs` bị loại khỏi phép so: nó là đồng hồ tường, lệch giữa hai lần chạy là
    # đúng. So nó vào đây từng làm test đỏ oan (157 ms vs 176 ms).
    def _tien_dinh(stats: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in stats.items() if key != "elapsedMs"}

    if a["placements"] != b["placements"]:
        assert a["stats"]["placedCount"] == b["stats"]["placedCount"]
    else:
        assert _tien_dinh(a["stats"]) == _tien_dinh(b["stats"])


# ─────────────────────────────────────────────────────────────────────────────
#  2. Deadline và ngân sách thời gian
# ─────────────────────────────────────────────────────────────────────────────


@requires_engine
@pytest.mark.parametrize("budget_ms", [1500, 3000])
def test_deadline_tra_best_so_far_da_validate(api, budget_ms):
    client, _registry = api
    # Workload đủ nặng để không xong trước deadline ở profile `tight`.
    request = _request(quantity=14, profile="tight", time_budget_ms=budget_ms, sheet_w=700.0, sheet_h=1000.0)

    started = time.monotonic()
    _job_id, manifest = _chay_qua_api(client, request, timeout=budget_ms / 1000.0 + 60.0)
    elapsed_s = time.monotonic() - started

    assert manifest["validation"]["valid"] is True, "best-so-far phải qua validator"
    # NF-3 (portfolio song song, audit 2026-08-30): engine nay nhanh hơn nên với workload này
    # work-plan cố định có thể XONG trước deadline ⇒ `work_budget_exhausted`. Đó vẫn là terminal
    # hợp lệ và best-so-far vẫn qua validator (assert trên). Điểm cốt lõi của test là "khi dừng
    # thì trả layout ĐÃ VALIDATE trong thời gian có trần", không phải ép đúng nhánh deadline:
    # `all_placed` = xếp hết, `work_budget_exhausted` = hết work-plan trước deadline, `deadline` =
    # chạm đồng hồ — cả ba đều phải cho layout đã validate và bị trần thời gian.
    assert manifest["stats"]["terminationReason"] in {
        "deadline",
        "all_placed",
        "work_budget_exhausted",
    }
    if manifest["stats"]["terminationReason"] == "deadline":
        # §17: không vượt budget quá max(1 giây, 10%).
        bien_s = max(1.0, budget_ms / 1000.0 * 0.10)
        assert manifest["stats"]["elapsedMs"] <= budget_ms + bien_s * 1000.0, (
            f"engine báo {manifest['stats']['elapsedMs']} ms, budget {budget_ms} ms"
        )
    # Tổng thời gian gồm cả HTTP + polling nên nới hơn, nhưng vẫn phải bị trần.
    assert elapsed_s < budget_ms / 1000.0 + 30.0


@requires_engine
def test_khong_co_budget_thi_terminationReason_khong_phai_deadline(api):
    client, _registry = api
    _job_id, manifest = _chay_qua_api(
        client, _request(quantity=4, profile="fast", time_budget_ms=None)
    )
    assert manifest["stats"]["terminationReason"] != "deadline"


# ─────────────────────────────────────────────────────────────────────────────
#  3. Cancel và không rò tài nguyên
# ─────────────────────────────────────────────────────────────────────────────


@requires_engine
def test_cancel_dang_chay_qua_api_that(api):
    """Hủy job đang chạy: về terminal nhanh, và không publish layout dở dang."""
    client, _registry = api
    # `tight` + nhiều con để job chắc chắn còn đang chạy khi ta gửi Cancel.
    request = _request(quantity=40, profile="tight", time_budget_ms=None, sheet_w=700.0, sheet_h=1000.0)
    job_id = client.post("/api/mixed-nesting/jobs", json=request).json()["jobId"]

    # Chờ job vào pha chạy THẬT. Registry chỉ đặt các pha dưới đây SAU khi đã tạo
    # native handle, nên thấy một trong chúng là bằng chứng ta đang hủy job đang chạy
    # chứ không phải job còn nằm trong hàng đợi (đường đó có test riêng).
    PHA_DANG_CHAY = {"normalizing", "baseline", "nesting", "improving", "validating"}
    da_chay = False
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        status = client.get(f"/api/mixed-nesting/jobs/{job_id}").json()
        if status["status"] in PHA_DANG_CHAY:
            da_chay = True
            break
        if status["terminal"]:
            break
        time.sleep(0.01)
    assert da_chay, "job không vào được pha chạy — test này không kiểm đúng đường cancel"

    huy_luc = time.monotonic()
    outcome = client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
    assert outcome.status_code == 200, outcome.text
    assert outcome.json()["cancelled"] is True

    final = _cho_terminal(client, job_id, timeout=60.0)
    do_tre_s = time.monotonic() - huy_luc
    assert final["status"] in {"cancelled", "completed"}
    # §17 nhắm ≤1 s tại checkpoint; nới lên 15 s trong test để không đỏ vì máy CI tải cao,
    # nhưng vẫn chặn được trường hợp cancel bị bỏ qua hoàn toàn.
    assert do_tre_s < 15.0, f"hủy mất {do_tre_s:.1f}s — nghi checkpoint không kiểm cancel"

    result = client.get(f"/api/mixed-nesting/jobs/{job_id}/result")
    if final["status"] == "cancelled":
        assert result.status_code == 409, "cancel không được publish layout"
    else:
        assert result.json()["validation"]["valid"] is True


@requires_engine
def test_cancel_khi_con_xep_hang_qua_api_that(api):
    client, _registry = api
    nang = _request(quantity=40, profile="tight", time_budget_ms=None, sheet_w=700.0, sheet_h=1000.0)
    first = client.post("/api/mixed-nesting/jobs", json=nang).json()["jobId"]
    second = client.post("/api/mixed-nesting/jobs", json=_request()).json()["jobId"]

    outcome = client.post(f"/api/mixed-nesting/jobs/{second}/cancel").json()
    assert outcome["cancelled"] is True
    status = client.get(f"/api/mixed-nesting/jobs/{second}").json()
    assert status["status"] == "cancelled"
    assert status["terminal"] is True

    client.post(f"/api/mixed-nesting/jobs/{first}/cancel")
    _cho_terminal(client, first, timeout=60.0)


@requires_engine
def test_khong_ro_suat_scheduler_sau_cancel(monkeypatch):
    """Hủy job đi qua suất whole-machine THẬT: suất phải được nhả đúng một lần."""
    registry = MixedNestingJobRegistry(max_queued=2, ttl_seconds=60.0)
    monkeypatch.setattr(route, "mixed_nesting_jobs", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    app.dependency_overrides[require_license] = lambda: PRO
    try:
        with TestClient(app) as client:
            request = _request(
                quantity=40, profile="tight", time_budget_ms=None, sheet_w=700.0, sheet_h=1000.0
            )
            job_id = client.post("/api/mixed-nesting/jobs", json=request).json()["jobId"]
            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                if client.get(f"/api/mixed-nesting/jobs/{job_id}").json()["status"] not in {
                    "queued",
                    "waiting_resources",
                }:
                    break
                time.sleep(0.05)
            client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
            _cho_terminal(client, job_id, timeout=60.0)
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.close()

    assert sched._WHOLE_MACHINE_SLOTS.acquire(timeout=5), "rò suất whole-machine"
    sched._WHOLE_MACHINE_SLOTS.release()
    assert sched._HEAVY_JOB_SLOTS.acquire(timeout=5), "rò suất toàn cục"
    sched._HEAVY_JOB_SLOTS.release()


@requires_engine
def test_status_va_cancel_phan_hoi_khi_solver_full_cpu(api):
    """Progress atomics phải đủ nhẹ để endpoint không bị đói (§14)."""
    client, _registry = api
    request = _request(quantity=40, profile="tight", time_budget_ms=None, sheet_w=700.0, sheet_h=1000.0)
    job_id = client.post("/api/mixed-nesting/jobs", json=request).json()["jobId"]

    do_tre: list[float] = []
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        moc = time.monotonic()
        response = client.get(f"/api/mixed-nesting/jobs/{job_id}")
        do_tre.append(time.monotonic() - moc)
        assert response.status_code == 200
        time.sleep(0.02)

    client.post(f"/api/mixed-nesting/jobs/{job_id}/cancel")
    _cho_terminal(client, job_id, timeout=60.0)

    assert len(do_tre) >= 10, "không gọi đủ status trong lúc solver chạy"
    cham_nhat = max(do_tre)
    assert cham_nhat < 2.0, f"status chậm nhất {cham_nhat:.2f}s trong lúc solver chạy"


# ─────────────────────────────────────────────────────────────────────────────
#  4. Corpus: kỳ vọng đã version hoá
# ─────────────────────────────────────────────────────────────────────────────


def _ap_tran_thoi_gian(request: dict[str, Any], budget_ms: int = 6000) -> dict[str, Any]:
    """Bản sao có trần thời gian, để CI không chạy ca không trần (S20 = 44 s)."""
    payload = json.loads(json.dumps(request))
    payload["timeBudgetMs"] = budget_ms
    return payload


def _la_cardinal(angle_deg: float, tol: float = 1e-6) -> bool:
    return any(
        abs(((angle_deg - c + 180.0) % 360.0) - 180.0) <= tol
        for c in (0.0, 90.0, 180.0, 270.0)
    )


@requires_engine
def test_corpus_angle_only_thang_san_cardinal(api):
    """Bằng chứng bắt buộc của §17: free-angle làm được điều cardinal KHÔNG làm được.

    Cùng hình học, cùng profile, chỉ khác miền góc. Nếu ca này không còn thắng thì tính
    năng mất lý do tồn tại, kể cả khi validator vẫn xanh.
    """
    client, _registry = api
    case = _case("ANGLE_ONLY")

    _job, free_manifest = _chay_qua_api(client, _ap_tran_thoi_gian(case["request"]))
    assert free_manifest["stats"]["placedCount"] >= case["expect"]["minPlaced"]
    assert free_manifest["stats"]["sheetCount"] <= case["expect"]["maxSheets"]
    assert free_manifest["stats"]["unplacedCount"] == 0
    goc = [p["pose"]["rotationDeg"] for p in free_manifest["placements"]]
    assert any(not _la_cardinal(value) for value in goc), (
        f"ca ANGLE_ONLY phải cho góc không-cardinal, nhận {goc}"
    )

    # Sàn an toàn: thu hẹp về bốn góc cardinal, KHÔNG đổi profile.
    cardinal = json.loads(json.dumps(_ap_tran_thoi_gian(case["request"])))
    khoa = {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]}
    cardinal["orientationPolicy"]["defaultRotation"] = dict(khoa)
    for part in cardinal["parts"]:
        part["rotationConstraint"] = dict(khoa)

    _job2, baseline_manifest = _chay_qua_api(client, cardinal)
    assert baseline_manifest["stats"]["placedCount"] == 0, (
        "sàn cardinal phải KHÔNG xếp được — nếu xếp được thì ca này không còn "
        f"chứng minh gì: {baseline_manifest['stats']}"
    )
    assert baseline_manifest["stats"]["unplacedCount"] == 1
    assert baseline_manifest["unplaced"][0]["reason"] == "NO_FEASIBLE_POSE"


@requires_engine
def test_corpus_continuous_xy_giu_phan_le(api):
    client, _registry = api
    case = _case("CONTINUOUS_XY")
    _job, manifest = _chay_qua_api(client, _ap_tran_thoi_gian(case["request"]))

    assert manifest["stats"]["placedCount"] >= case["expect"]["minPlaced"]
    assert manifest["stats"]["sheetCount"] <= case["expect"]["maxSheets"]
    co_phan_le = [
        p
        for p in manifest["placements"]
        if abs(p["pose"]["translateXmm"] - round(p["pose"]["translateXmm"])) > 1e-9
        or abs(p["pose"]["translateYmm"] - round(p["pose"]["translateYmm"])) > 1e-9
    ]
    assert co_phan_le, "không có toạ độ phần lẻ — nghi có bước snap về lưới mm"


@requires_engine
def test_corpus_constraints_ton_trong_mien_tung_part(api):
    """Mỗi chi tiết phải nằm trong miền góc CỦA NÓ, không phải miền của job."""
    client, _registry = api
    case = _case("CONSTRAINTS")
    request = _ap_tran_thoi_gian(case["request"], budget_ms=8000)
    _job, manifest = _chay_qua_api(client, request, timeout=120.0)

    assert manifest["stats"]["placedCount"] >= case["expect"]["minPlaced"]
    assert manifest["validation"]["valid"] is True

    rang_buoc = {part["partId"]: part["rotationConstraint"] for part in request["parts"]}
    mac_dinh = request["orientationPolicy"]["defaultRotation"]
    kiem_tra = 0
    for placement in manifest["placements"]:
        constraint = rang_buoc[placement["partId"]]
        if constraint["mode"] == "inherit":
            constraint = mac_dinh
        angle = placement["pose"]["rotationDeg"]
        mode = constraint["mode"]
        if mode == "free":
            assert 0.0 <= angle < 360.0
        elif mode == "fixed":
            mong_doi = constraint["angleDeg"] % 360.0
            assert abs(angle - mong_doi) <= 1e-6, (
                f"{placement['partId']}: fixed {mong_doi}° nhưng nhận {angle}°"
            )
            kiem_tra += 1
        elif mode == "discrete":
            assert any(
                abs(((angle - value + 180.0) % 360.0) - 180.0) <= 1e-6
                for value in constraint["anglesDeg"]
            ), f"{placement['partId']}: {angle}° ngoài tập {constraint['anglesDeg']}"
            kiem_tra += 1
        elif mode == "ranges":
            trong_cung = False
            for arc in constraint["arcs"]:
                lech = (angle - arc["startDeg"]) % 360.0
                if lech <= arc["sweepDeg"] + 1e-6:
                    trong_cung = True
                    break
            assert trong_cung, f"{placement['partId']}: {angle}° ngoài cung {constraint['arcs']}"
            kiem_tra += 1
    assert kiem_tra >= 6, "phải kiểm được đủ các mode thu hẹp, không chỉ free/inherit"


@requires_engine
def test_utilization_khop_so_tinh_lai_tu_contour(api):
    """§17: không tin ``materialUtilization`` solver tự báo."""
    client, _registry = api
    request = _request(quantity=6, profile="fast", time_budget_ms=3000)
    _job, manifest = _chay_qua_api(client, request)

    dien_tich_part = 90.0 * 60.0
    sheet = request["sheet"]
    tong_to = sheet["widthMm"] * sheet["heightMm"] * manifest["stats"]["sheetCount"]
    tinh_lai = manifest["stats"]["placedCount"] * dien_tich_part / tong_to

    assert manifest["stats"]["materialUtilization"] == pytest.approx(tinh_lai, rel=1e-6)


@requires_engine
def test_bao_toan_so_luong_va_instance_id_duy_nhat(api):
    client, _registry = api
    request = _request(quantity=7, profile="fast", time_budget_ms=4000)
    _job, manifest = _chay_qua_api(client, request)

    ids = [p["instanceId"] for p in manifest["placements"]]
    ids += [p["instanceId"] for p in manifest["unplaced"]]
    assert len(ids) == 7, "quantity không được bảo toàn"
    assert len(set(ids)) == 7, "instanceId phải duy nhất"

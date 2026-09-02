"""Test cầu nối PyO3 ⇄ sidecar cho engine lồng ghép tự do — phase P5.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §6.2, §16.2.

Bộ test này phải chứng minh năm điều của gate P5:

1. ``solve()`` **nhả GIL**: thread Python khác vẫn chạy được trong lúc Rust tính, và
   ``progress()``/``cancel()`` gọi được từ thread đó.
2. Góc **không-cardinal** và X/Y **phần lẻ** round-trip qua JSON **không mất chữ số**.
3. Progress và cancel hoạt động thật, cancel **idempotent**.
4. Native **thiếu hoặc wheel cũ** thì fail rõ bằng ``503 ENGINE_UNAVAILABLE``, và
   **không fallback** sang solver cũ.
5. Panic hoặc input xấu quy về lỗi có mã ổn định, **không làm chết sidecar**.

Một số test cần bản native đã cài có ``MixedNestingRun``. Chúng được ``skip`` có lý do
rõ ràng thay vì đỏ, nhưng phần **hợp đồng lỗi và fail-closed** thì luôn chạy — đó là phần
dễ trôi nhất khi refactor.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import pytest

from app.core import mixed_nesting_service as svc


# ─────────────────────────────────────────────────────────────────────────────
#  Tiện ích
# ─────────────────────────────────────────────────────────────────────────────


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
        "pdfcompare_native chưa có MixedNestingRun. Chạy lại "
        "`maturin develop --release` trong native/ (cần tắt sidecar dev đang giữ DLL)."
    ),
)


def _rect(w: float, h: float) -> list[list[float]]:
    return [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]


def _request(
    parts: list[dict[str, Any]] | None = None,
    *,
    gap: float = 3.0,
    sheet_w: float = 400.0,
    sheet_h: float = 500.0,
    max_sheets: int = 20,
    time_budget_ms: int | None = None,
    profile: str = "balanced",
    job_id: str | None = "test-job",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocolVersion": svc.MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 20260826,
        "profile": profile,
        "sheet": {
            "widthMm": sheet_w,
            "heightMm": sheet_h,
            "marginMm": {"left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0},
            "maxSheets": max_sheets,
        },
        "gapMm": gap,
        "layoutIntent": "quantity_fulfillment",
        "orientationPolicy": {
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": parts
        if parts is not None
        else [
            {
                "partId": "part-a",
                "quantity": 3,
                "outer": _rect(120.0, 80.0),
                "holes": [],
                "rotationConstraint": {"mode": "inherit"},
            }
        ],
    }
    if time_budget_ms is not None:
        payload["timeBudgetMs"] = time_budget_ms
    if job_id is not None:
        payload["jobId"] = job_id
    return payload


@pytest.fixture(autouse=True)
def _clean_cache():
    """Mỗi test bắt đầu với cache nạp native sạch."""
    svc.reset_engine_cache()
    yield
    svc.reset_engine_cache()


# ═════════════════════════════════════════════════════════════════════════════
#  1. Hợp đồng mã lỗi — luôn chạy, không phụ thuộc native
# ═════════════════════════════════════════════════════════════════════════════


def test_ma_loi_khop_voi_rust():
    """Danh sách mã ở Python phải khớp ``native/src/mixed_nesting_py.rs::codes``.

    Nếu Rust thêm mã mới mà quên khai ở đây thì ``_translate_engine_error`` quy nó về 500
    và người dùng nhận thông báo sai lớp. Test này là chốt chống việc đó.
    """
    assert svc.ERROR_CODE_TO_STATUS == {
        "MIXED_NESTING_BAD_JSON": 422,
        "MIXED_NESTING_INVALID_REQUEST": 422,
        "MIXED_NESTING_INVALID_GEOMETRY": 422,
        "MIXED_NESTING_CANCELLED": 409,
        "MIXED_NESTING_ENGINE_ERROR": 500,
    }
    assert svc.MIXED_NESTING_PROTOCOL_VERSION == 2
    assert svc.ENGINE_UNAVAILABLE_CODE == "ENGINE_UNAVAILABLE"


def test_ma_loi_trong_source_rust_khop_python():
    """Đọc thẳng source Rust để bắt lệch, thay vì tin vào ghi nhớ."""
    from pathlib import Path

    source = Path(__file__).resolve().parents[2] / "native" / "src" / "mixed_nesting_py.rs"
    if not source.is_file():  # pragma: no cover - chỉ khi layout repo đổi
        pytest.skip("không tìm thấy native/src/mixed_nesting_py.rs")
    text = source.read_text(encoding="utf-8")
    for code in svc.ERROR_CODE_TO_STATUS:
        assert f'"{code}"' in text, f"mã {code} có ở Python nhưng không có trong Rust"


@pytest.mark.parametrize(
    ("raw", "code", "status"),
    [
        ("MIXED_NESTING_BAD_JSON: hỏng", "MIXED_NESTING_BAD_JSON", 422),
        (
            "MIXED_NESTING_INVALID_REQUEST: EMPTY_PARTS | thiếu chi tiết",
            "MIXED_NESTING_INVALID_REQUEST",
            422,
        ),
        (
            "MIXED_NESTING_INVALID_GEOMETRY: RING_SELF_INTERSECTING | tự cắt",
            "MIXED_NESTING_INVALID_GEOMETRY",
            422,
        ),
        ("MIXED_NESTING_CANCELLED: đã hủy", "MIXED_NESTING_CANCELLED", 409),
        ("MIXED_NESTING_ENGINE_ERROR: lỗi trong", "MIXED_NESTING_ENGINE_ERROR", 500),
    ],
)
def test_dich_loi_tach_dung_ma(raw: str, code: str, status: int):
    error = svc._translate_engine_error(RuntimeError(raw))
    assert error.code == code
    assert error.status == status
    assert error.message
    assert error.to_payload() == {"code": code, "message": error.message}


def test_ma_la_quy_ve_500_khong_doan():
    """Mã lạ phải là 500, không được đoán thành 422.

    Đoán sai hướng này khiến người dùng đi sửa dữ liệu cho một lỗi engine — mất thời gian
    và che mất bug thật.
    """
    error = svc._translate_engine_error(RuntimeError("SOMETHING_ELSE: gì đó"))
    assert error.status == 500
    assert error.code == "MIXED_NESTING_ENGINE_ERROR"
    # Cả thông báo không có dấu ':' cũng phải quy về 500.
    assert svc._translate_engine_error(RuntimeError("khong co ma")).status == 500


# ═════════════════════════════════════════════════════════════════════════════
#  2. Fail-closed khi native thiếu hoặc cũ — không fallback
# ═════════════════════════════════════════════════════════════════════════════


def test_native_thieu_thi_503_khong_fallback(monkeypatch: pytest.MonkeyPatch):
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "pdfcompare_native":
            raise ImportError("giả lập thiếu native")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    svc.reset_engine_cache()
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert caught.value.status == 503
    assert caught.value.code == "ENGINE_UNAVAILABLE"


def test_wheel_cu_thieu_class_thi_503(monkeypatch: pytest.MonkeyPatch):
    """Native có nhưng chưa có ``MixedNestingRun`` ⇒ vẫn phải 503."""

    class FakeNative:
        pass

    monkeypatch.setattr(svc, "_probe_native", _probe_with(FakeNative()))
    svc.reset_engine_cache()
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert caught.value.status == 503
    assert "bản cũ" in caught.value.message or "cập nhật" in caught.value.message


def test_wheel_stale_protocol_lech_thi_503(monkeypatch: pytest.MonkeyPatch):
    """Wheel stale nguy hiểm hơn wheel thiếu: nó CHẠY được nhưng theo hợp đồng khác."""

    class StaleRun:
        @staticmethod
        def capabilities() -> str:
            return json.dumps(
                {
                    "protocolVersion": 1,
                    "engineVersion": "0.1.0",
                    "reflection": "forbidden",
                    "defaultRotation": "free",
                    "continuousTranslation": True,
                    "profiles": ["fast"],
                }
            )

    class FakeNative:
        MixedNestingRun = StaleRun

    monkeypatch.setattr(svc, "_probe_native", _probe_with(FakeNative()))
    svc.reset_engine_cache()
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert "giao thức" in caught.value.message


def test_native_cho_phep_lat_khuon_thi_503(monkeypatch: pytest.MonkeyPatch):
    """Bất biến toàn dự án: bình mặt trước không lật khuôn. Native nói khác ⇒ từ chối."""

    class MirrorRun:
        @staticmethod
        def capabilities() -> str:
            return json.dumps(
                {
                    "protocolVersion": 2,
                    "engineVersion": "0.2.0",
                    "reflection": "allowed",
                    "defaultRotation": "free",
                    "continuousTranslation": True,
                    "profiles": ["fast", "balanced", "tight"],
                    "layoutIntents": [
                        "quantity_fulfillment",
                        "autofill_single_sheet",
                    ],
                }
            )

    class FakeNative:
        MixedNestingRun = MirrorRun

    monkeypatch.setattr(svc, "_probe_native", _probe_with(FakeNative()))
    svc.reset_engine_cache()
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert "lật khuôn" in caught.value.message


def test_native_v2_thieu_layout_intents_thi_503(monkeypatch: pytest.MonkeyPatch):
    """Protocol đã khớp thì mọi field capability v2 bắt buộc phải đọc được."""

    class MissingIntentRun:
        @staticmethod
        def capabilities() -> str:
            return json.dumps(
                {
                    "protocolVersion": 2,
                    "engineVersion": "0.2.0",
                    "reflection": "forbidden",
                    "defaultRotation": "free",
                    "continuousTranslation": True,
                    "profiles": ["fast", "balanced", "tight"],
                }
            )

    class FakeNative:
        MixedNestingRun = MissingIntentRun

    monkeypatch.setattr(svc, "_probe_native", _probe_with(FakeNative()))
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert caught.value.status == 503
    assert "không đọc được" in caught.value.message


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        ("layoutIntents", ["quantity_fulfillment"], "ý định"),
        ("profiles", ["fast"], "hồ sơ"),
        ("continuousTranslation", "false", "dịch chuyển"),
    ],
)
def test_native_v2_capability_khong_du_thi_503(
    monkeypatch: pytest.MonkeyPatch, field: str, value: Any, expected: str
):
    payload: dict[str, Any] = {
        "protocolVersion": 2,
        "engineVersion": "0.2.0",
        "reflection": "forbidden",
        "defaultRotation": "free",
        "continuousTranslation": True,
        "profiles": ["fast", "balanced", "tight"],
        "layoutIntents": ["quantity_fulfillment", "autofill_single_sheet"],
    }
    payload[field] = value

    class InvalidCapabilityRun:
        @staticmethod
        def capabilities() -> str:
            return json.dumps(payload)

    class FakeNative:
        MixedNestingRun = InvalidCapabilityRun

    monkeypatch.setattr(svc, "_probe_native", _probe_with(FakeNative()))
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert caught.value.status == 503
    assert expected in caught.value.message


def _probe_with(fake_native: Any):
    """Dựng lại ``_probe_native`` nhưng đọc từ một module giả."""
    real_probe = svc._probe_native

    def probe():
        import sys
        import types

        module = types.ModuleType("pdfcompare_native")
        for name in dir(fake_native):
            if not name.startswith("_"):
                setattr(module, name, getattr(fake_native, name))
        saved = sys.modules.get("pdfcompare_native")
        sys.modules["pdfcompare_native"] = module
        try:
            return real_probe()
        finally:
            if saved is None:
                sys.modules.pop("pdfcompare_native", None)
            else:
                sys.modules["pdfcompare_native"] = saved

    return probe


def _capability_payload_nf3(**overrides: Any) -> dict[str, Any]:
    """Capability hợp lệ tối thiểu + ba cờ NF-3, cho phép override từng field."""
    payload: dict[str, Any] = {
        "protocolVersion": 2,
        "engineVersion": "0.2.0",
        "reflection": "forbidden",
        "defaultRotation": "free",
        "continuousTranslation": True,
        "profiles": ["fast", "balanced", "tight"],
        "layoutIntents": ["quantity_fulfillment", "autofill_single_sheet"],
        "portfolioParallelEnabled": True,
        "nfpColdMissParallelEnabled": True,
        "nfpCacheByteBudgetEnforced": True,
    }
    payload.update(overrides)
    return payload


def _load_capabilities(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]):
    class _Run:
        @staticmethod
        def capabilities() -> str:
            return json.dumps(payload)

    class _Native:
        MixedNestingRun = _Run

    monkeypatch.setattr(svc, "_probe_native", _probe_with(_Native()))
    svc.reset_engine_cache()
    return svc.load_engine()[1]


def test_capability_nf3_duoc_parse_dung_khi_native_cong_bo(monkeypatch: pytest.MonkeyPatch):
    """NF-3: sidecar phải GHI đúng cờ song song native công bố, không im lặng bỏ qua.

    Đây là chốt cho "log nói đúng sự thật": engine chạy portfolio song song thật, nên
    ``EngineCapabilities`` phải mang đúng ba cờ thay vì để trống (Python coi như false).
    """
    caps = _load_capabilities(monkeypatch, _capability_payload_nf3())
    assert caps.portfolio_parallel_enabled is True
    assert caps.nfp_cold_miss_parallel_enabled is True
    assert caps.nfp_cache_byte_budget_enforced is True


def test_capability_nf3_vang_mat_thi_none_khong_suy_false(monkeypatch: pytest.MonkeyPatch):
    """Wheel cũ không công bố cờ ⇒ ``None`` (thiếu khai báo), KHÔNG phải False nghiệp vụ."""
    payload = _capability_payload_nf3()
    for key in (
        "portfolioParallelEnabled",
        "nfpColdMissParallelEnabled",
        "nfpCacheByteBudgetEnforced",
    ):
        payload.pop(key)
    caps = _load_capabilities(monkeypatch, payload)
    assert caps.portfolio_parallel_enabled is None
    assert caps.nfp_cold_miss_parallel_enabled is None
    assert caps.nfp_cache_byte_budget_enforced is None


def test_capability_nf3_sai_kieu_thi_503(monkeypatch: pytest.MonkeyPatch):
    """Cờ có mặt nhưng sai kiểu (vd chuỗi ``"true"``) ⇒ wheel không đồng bộ, 503."""
    monkeypatch.setattr(
        svc,
        "_probe_native",
        _probe_with(
            type(
                "_N",
                (),
                {
                    "MixedNestingRun": type(
                        "_R",
                        (),
                        {
                            "capabilities": staticmethod(
                                lambda: json.dumps(
                                    _capability_payload_nf3(portfolioParallelEnabled="true")
                                )
                            )
                        },
                    )
                },
            )()
        ),
    )
    svc.reset_engine_cache()
    with pytest.raises(svc.EngineUnavailableError) as caught:
        svc.load_engine()
    assert caught.value.status == 503


def test_loi_nap_native_duoc_cache_khong_do_lai_moi_lan(monkeypatch: pytest.MonkeyPatch):
    calls = {"n": 0}

    def probe():
        calls["n"] += 1
        raise svc.EngineUnavailableError("giả lập thiếu")

    monkeypatch.setattr(svc, "_probe_native", probe)
    svc.reset_engine_cache()
    for _ in range(3):
        with pytest.raises(svc.EngineUnavailableError):
            svc.load_engine()
    assert calls["n"] == 1, "thất bại phải được cache, không dò lại từng lần"


def test_create_run_that_bai_khi_engine_khong_dung_duoc(monkeypatch: pytest.MonkeyPatch):
    def probe():
        raise svc.EngineUnavailableError("giả lập thiếu")

    monkeypatch.setattr(svc, "_probe_native", probe)
    svc.reset_engine_cache()
    with pytest.raises(svc.EngineUnavailableError):
        svc.create_run()


# ═════════════════════════════════════════════════════════════════════════════
#  3. Chạy thật qua native
# ═════════════════════════════════════════════════════════════════════════════


@requires_engine
def test_capabilities_dung_hop_dong():
    caps = svc.engine_capabilities()
    assert caps.protocol_version == 2
    assert caps.engine_version == "0.3.0"
    assert caps.reflection == "forbidden"
    assert caps.default_rotation == "free"
    assert caps.continuous_translation is True
    assert set(caps.profiles) == {"fast", "balanced", "tight"}
    assert set(caps.layout_intents) == {
        "quantity_fulfillment",
        "autofill_single_sheet",
        "step_repeat_single_sheet",
    }


@requires_engine
def test_solve_tra_manifest_hop_le():
    run = svc.create_run()
    manifest = run.solve(_request())
    assert manifest["protocolVersion"] == 2
    assert manifest["jobId"] == "test-job"
    assert manifest["seed"] == 20260826
    assert manifest["status"] == "completed"
    assert manifest["validation"]["valid"] is True
    assert manifest["validation"]["validatorVersion"] == 2
    assert len(manifest["placements"]) + len(manifest["unplaced"]) == 3
    # Tên trường pose đúng hợp đồng §9.3, kể cả chữ thường của `mm`.
    pose = manifest["placements"][0]["pose"]
    assert set(pose) == {"rotationDeg", "translateXmm", "translateYmm"}
    # Thống kê có mặt và là số tính lại được.
    stats = manifest["stats"]
    assert stats["placedCount"] == len(manifest["placements"])
    assert stats["unplacedCount"] == len(manifest["unplaced"])
    assert 0.0 < stats["materialUtilization"] <= 1.0
    assert stats["terminationReason"] in {
        "all_placed",
        "work_budget_exhausted",
        "deadline",
        "max_sheets_reached",
        "cancelled",
    }


@requires_engine
def test_goc_khong_cardinal_va_xy_phan_le_round_trip_du_do_chinh_xac():
    """Chốt gate P5: precision không được mất khi đi qua JSON ⇄ Rust ⇄ JSON.

    Dùng chi tiết chỉ vừa tờ quanh một góc không-cardinal, rồi kiểm pose trả về giữ đủ
    chữ số. Fixture chỉ dùng 0° hoặc toạ độ nguyên **không** chứng minh được điều này.
    """
    run = svc.create_run()
    # Nan 130×10 trong vùng dùng được 100×100: bốn góc cardinal không vừa.
    manifest = run.solve(
        _request(
            parts=[
                {
                    "partId": "part-nan",
                    "quantity": 1,
                    "outer": _rect(130.0, 10.0),
                    "holes": [],
                    "rotationConstraint": {"mode": "free"},
                }
            ],
            gap=0.0,
            sheet_w=120.0,
            sheet_h=120.0,
            max_sheets=3,
            profile="tight",
        )
    )
    assert manifest["validation"]["valid"] is True
    assert len(manifest["placements"]) == 1, "miền tự do phải xếp được con này"
    pose = manifest["placements"][0]["pose"]
    angle = pose["rotationDeg"]
    assert all(abs(angle - c) > 1e-6 for c in (0.0, 90.0, 180.0, 270.0)), (
        f"góc {angle} phải là góc không-cardinal"
    )
    # Giá trị là float thật, không bị làm tròn về số nguyên hay về 1 chữ số.
    assert isinstance(angle, float)
    assert abs(angle - round(angle)) > 1e-9 or abs(
        pose["translateXmm"] - round(pose["translateXmm"])
    ) > 1e-9 or abs(pose["translateYmm"] - round(pose["translateYmm"])) > 1e-9, (
        f"pose phải giữ phần lẻ: {pose}"
    )
    # Round-trip lại qua JSON: không mất chữ số nào.
    again = json.loads(json.dumps(manifest))
    assert again["placements"][0]["pose"] == pose


@requires_engine
def test_solve_deterministic_cung_seed():
    a = svc.create_run().solve(_request())
    b = svc.create_run().solve(_request())
    assert a["placements"] == b["placements"]
    assert a["unplaced"] == b["unplaced"]


@requires_engine
def test_progress_doc_duoc_truoc_va_sau_khi_chay():
    run = svc.create_run()
    before = run.progress()
    assert before["phase"] == "queued"
    assert before["progress"] == 0.0
    assert before["bestSheetCount"] is None
    run.solve(_request())
    after = run.progress()
    assert after["phase"] in {"completed", "cancelled", "failed"}
    assert after["progress"] == pytest.approx(1.0)
    assert after["elapsedMs"] >= 0


@requires_engine
def test_solve_nha_gil_nen_thread_khac_van_chay():
    """Gate P5: ``solve()`` phải nhả GIL.

    Chạy ``solve`` trên thread nền với việc đủ nặng, đồng thời thread chính đếm vòng và
    gọi ``progress()``. Nếu GIL không được nhả thì thread chính bị đói và số vòng đếm
    được sẽ rất nhỏ.
    """
    run = svc.create_run()
    # Workload phải đủ nặng để thread chính đếm được >1000 vòng, nhưng có TRẦN
    # thời gian thật để test không phụ thuộc tốc độ máy. Đo trên máy dev:
    # fast + 10 con ≈ 0,6s không trần; timeBudgetMs=4000 là biên an toàn.
    heavy = _request(
        parts=[
            {
                "partId": "part-a",
                "quantity": 10,
                "outer": _rect(90.0, 60.0),
                "holes": [],
                "rotationConstraint": {"mode": "free"},
            }
        ],
        profile="fast",
        sheet_w=700.0,
        sheet_h=1000.0,
        time_budget_ms=4000,
    )
    result: dict[str, Any] = {}
    error: list[BaseException] = []

    def worker():
        try:
            result["manifest"] = run.solve(heavy)
        except BaseException as exc:  # noqa: BLE001 - test phải thấy mọi lỗi
            error.append(exc)

    thread = threading.Thread(target=worker, name="mixed-nesting-solve")
    thread.start()

    spins = 0
    snapshots = 0
    deadline = time.monotonic() + 20.0
    while thread.is_alive() and time.monotonic() < deadline:
        spins += 1
        if spins % 200 == 0:
            # Gọi được progress() từ thread khác trong lúc solve đang chạy.
            snapshot = run.progress()
            assert "phase" in snapshot
            snapshots += 1
        time.sleep(0)
    thread.join(timeout=20.0)
    assert not thread.is_alive(), "solve không kết thúc trong 20 giây"
    assert not error, f"solve lỗi: {error}"
    assert result["manifest"]["validation"]["valid"] is True
    assert spins > 1000, (
        f"thread chính chỉ chạy được {spins} vòng — dấu hiệu GIL không được nhả"
    )
    assert snapshots > 0, "phải đọc được progress từ thread khác trong lúc solve chạy"


@requires_engine
def test_cancel_tu_thread_khac_dung_duoc_solve():
    run = svc.create_run()
    heavy = _request(
        parts=[
            {
                "partId": "part-a",
                "quantity": 40,
                "outer": _rect(70.0, 50.0),
                "holes": [],
                "rotationConstraint": {"mode": "free"},
            }
        ],
        profile="tight",
        sheet_w=700.0,
        sheet_h=1000.0,
    )
    outcome: list[Any] = []

    def worker():
        try:
            outcome.append(run.solve(heavy))
        except BaseException as exc:  # noqa: BLE001
            outcome.append(exc)

    thread = threading.Thread(target=worker, name="mixed-nesting-cancel")
    started = time.monotonic()
    thread.start()
    time.sleep(0.05)
    run.cancel()
    assert run.cancelled is True
    thread.join(timeout=20.0)
    assert not thread.is_alive(), "hủy phải dừng được solve"
    elapsed = time.monotonic() - started
    assert elapsed < 20.0
    assert outcome, "worker phải trả về gì đó"
    value = outcome[0]
    if isinstance(value, svc.MixedNestingError):
        # Hủy trước khi có phương án nào: mã ổn định, HTTP 409.
        assert value.code == "MIXED_NESTING_CANCELLED"
        assert value.status == 409
    else:
        # Hủy giữa vòng trial: trả best-so-far ĐÃ validate, không phải layout dở dang.
        assert value["validation"]["valid"] is True
        assert value["status"] in {"cancelled", "completed"}


@requires_engine
def test_cancel_idempotent():
    run = svc.create_run()
    assert run.cancelled is False
    run.cancel()
    run.cancel()
    run.cancel()
    assert run.cancelled is True


# ═════════════════════════════════════════════════════════════════════════════
#  4. Input xấu quy về lỗi có mã, không làm chết sidecar
# ═════════════════════════════════════════════════════════════════════════════


@requires_engine
@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda r: r.update(protocolVersion=99), "MIXED_NESTING_INVALID_REQUEST"),
        (lambda r: r.update(gapMm=-1.0), "MIXED_NESTING_INVALID_REQUEST"),
        (lambda r: r.update(parts=[]), "MIXED_NESTING_INVALID_REQUEST"),
        (
            lambda r: r["orientationPolicy"].update(reflection="allowed"),
            "MIXED_NESTING_BAD_JSON",
        ),
        (lambda r: r.update(translationStepMm=0.5), "MIXED_NESTING_BAD_JSON"),
        (
            lambda r: r["parts"][0].update(outer=[[0, 0], [10, 0], [0, 10], [20, 20]]),
            "MIXED_NESTING_INVALID_GEOMETRY",
        ),
        (
            lambda r: r["parts"][0].update(rotationConstraint={"mode": "discrete", "anglesDeg": []}),
            "MIXED_NESTING_INVALID_REQUEST",
        ),
    ],
)
def test_input_xau_quy_ve_ma_on_dinh(mutate, expected_code: str):
    run = svc.create_run()
    payload = _request()
    mutate(payload)
    with pytest.raises(svc.MixedNestingError) as caught:
        run.solve(payload)
    assert caught.value.code == expected_code, caught.value.message
    assert caught.value.status == 422
    # Thông báo không được rỗng và không được chứa toạ độ contour của khách hàng.
    assert caught.value.message
    for leak in ("[[", "]]"):
        assert leak not in caught.value.message


@requires_engine
def test_sidecar_van_song_sau_khi_gap_input_xau():
    """Lỗi dữ liệu không được làm engine không dùng được nữa."""
    run = svc.create_run()
    with pytest.raises(svc.MixedNestingError):
        run.solve(_request(parts=[]))
    # Cùng đối tượng run vẫn phục vụ được request hợp lệ ngay sau đó.
    manifest = svc.create_run().solve(_request())
    assert manifest["validation"]["valid"] is True
    # Và progress vẫn đọc được.
    assert "phase" in run.progress()


def test_gia_tri_khong_huu_han_bi_chan_ngay_o_bien_python(monkeypatch: pytest.MonkeyPatch):
    """``NaN``/``Infinity`` không phải JSON hợp lệ nên phải chặn trước khi tới Rust."""

    class FakeRun:
        def solve(self, payload: str) -> str:  # pragma: no cover - không được gọi tới
            raise AssertionError("không được tới Rust")

        def progress(self) -> str:
            return json.dumps({"phase": "queued"})

        def cancel(self) -> None:
            pass

        def is_cancelled(self) -> bool:
            return False

    handle = object.__new__(svc.MixedNestingRunHandle)
    object.__setattr__(handle, "_run", FakeRun())
    object.__setattr__(
        handle,
        "_capabilities",
        svc.EngineCapabilities(
            protocol_version=2,
            engine_version="0.2.0",
            reflection="forbidden",
            default_rotation="free",
            continuous_translation=True,
            profiles=("fast", "balanced", "tight"),
            layout_intents=("quantity_fulfillment", "autofill_single_sheet"),
        ),
    )
    payload = _request()
    payload["gapMm"] = float("nan")
    with pytest.raises(svc.MixedNestingError) as caught:
        handle.solve(payload)
    assert caught.value.code == "MIXED_NESTING_BAD_JSON"
    assert caught.value.status == 422


@requires_engine
def test_max_sheets_bao_dung_ly_do_khong_bao_sai_la_qua_kho():
    """§11.4: chạm trần số tờ và hình học không vừa là hai lý do khác nhau."""
    run = svc.create_run()
    manifest = run.solve(
        _request(
            parts=[
                {
                    "partId": "part-big",
                    "quantity": 3,
                    "outer": _rect(350.0, 450.0),
                    "holes": [],
                    "rotationConstraint": {"mode": "fixed", "angleDeg": 0.0},
                }
            ],
            max_sheets=1,
        )
    )
    assert manifest["validation"]["valid"] is True
    assert len(manifest["placements"]) == 1
    assert {u["reason"] for u in manifest["unplaced"]} == {"MAX_SHEETS_REACHED"}
    assert manifest["stats"]["terminationReason"] == "max_sheets_reached"


@requires_engine
def test_qua_kho_bao_no_feasible_pose():
    run = svc.create_run()
    manifest = run.solve(
        _request(
            parts=[
                {
                    "partId": "part-huge",
                    "quantity": 2,
                    "outer": _rect(2000.0, 1500.0),
                    "holes": [],
                    "rotationConstraint": {"mode": "free"},
                }
            ]
        )
    )
    assert manifest["validation"]["valid"] is True
    assert manifest["placements"] == []
    assert {u["reason"] for u in manifest["unplaced"]} == {"NO_FEASIBLE_POSE"}


@requires_engine
def test_khong_co_duong_bat_mirror_qua_bien_native():
    """Payload đòi lật khuôn phải bị từ chối rõ, không âm thầm bỏ qua."""
    run = svc.create_run()
    for mutation in (
        {"reflection": "allowed"},
        {"reflection": "mirror"},
        {"mirror": True},
    ):
        payload = _request()
        payload["orientationPolicy"].update(mutation)
        with pytest.raises(svc.MixedNestingError) as caught:
            run.solve(payload)
        assert caught.value.status == 422, mutation


# ── §NFP-CONVEX: khuôn gần lồi không được bị KERNEL_NOT_CONVEX ────────────────

def _almost_convex(sag_mm: float) -> list[list[float]]:
    """Khuôn gần lồi: đỉnh giữa cạnh dưới lõm vào ``sag_mm``.

    Đây là hình dạng của khuôn bế thật sau khi sample bezier và làm tròn toạ độ —
    lồi về ý nghĩa cơ khí nhưng có một đỉnh lõm ở mức nhiễu số học.
    """

    return [
        [0.0, 0.0],
        [50.0, 0.0],
        [100.0, sag_mm],
        [150.0, 0.0],
        [150.0, 80.0],
        [0.0, 80.0],
    ]


@requires_engine
@pytest.mark.parametrize("sag", [0.0, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-3])
def test_khuon_gan_loi_khong_bi_kernel_not_convex(sag: float):
    """Hồi quy §NFP-CONVEX, qua đúng biên native mà người dùng gặp lỗi.

    Lỗi gốc: `geometry::convex_decompose` nhận lồi theo `Tolerance::linear_mm`
    (`1e-6`) còn `kernel::minkowski_convex` đòi `1e-9` — lệch **1000×**. Khuôn có
    đỉnh lõm trong dải đó được trả về **một mảnh**, rồi kernel chặn bằng
    ``KERNEL_NOT_CONVEX`` với thông điệp "Phép Minkowski nhanh chỉ nhận đa giác lồi".

    Nghịch lý xác nhận đúng cơ chế: khuôn lõm **rõ** (sag lớn) lại chạy tốt vì nó mới
    được tam giác hoá đúng; chỉ khuôn **gần lồi** mới hỏng.
    """

    run = svc.create_run()
    manifest = run.solve(
        _request(
            parts=[
                {
                    "partId": "gan-loi",
                    "quantity": 2,
                    "outer": _almost_convex(sag),
                    "holes": [],
                    "rotationConstraint": {"mode": "free"},
                }
            ],
            profile="fast",
            sheet_w=700.0,
            sheet_h=500.0,
            time_budget_ms=8000,
        )
    )

    assert manifest["status"] == "completed", manifest.get("status")
    assert manifest["validation"]["valid"] is True
    assert manifest["stats"]["placedCount"] >= 1


@requires_engine
def test_khuon_co_dinh_trung_lien_ke_van_solve_duoc():
    """Contour từ PDF mang đỉnh trùng; §A4b-2 giữ nguyên chúng nên engine gặp thật.

    Đo được: bộ trích nét dựng hình chữ nhật 4 góc thành **8 đỉnh** (mỗi góc lặp hai
    lần). Trước §NFP-CONVEX các cạnh dài 0 làm tích có hướng bằng 0 và không phân biệt
    được "thẳng" với "trùng".
    """

    run = svc.create_run()
    manifest = run.solve(
        _request(
            parts=[
                {
                    "partId": "dinh-trung",
                    "quantity": 2,
                    "outer": [
                        [0.0, 0.0], [0.0, 0.0],
                        [60.0, 0.0], [60.0, 0.0],
                        [60.0, 40.0], [60.0, 40.0],
                        [0.0, 40.0], [0.0, 40.0],
                    ],
                    "holes": [],
                    "rotationConstraint": {"mode": "free"},
                }
            ],
            profile="fast",
            sheet_w=700.0,
            sheet_h=500.0,
            time_budget_ms=8000,
        )
    )

    assert manifest["validation"]["valid"] is True

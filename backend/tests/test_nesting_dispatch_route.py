"""§B10 — định tuyến TỰ ĐỘNG ở TẦNG DISPATCH (`nup_engine._run_nup_engine_impl`).

`test_nesting_auto_route_custom.py` khoá VỊ NGỮ `route_true_shape` (thuần). File này khoá phần
GHÉP NỐI: đúng job nào gọi `run_true_shape_nesting`, và quy tắc fallback —
  • auto-route chỉ lùi engine cũ cho signal compatibility/quality đã phân loại;
  • lỗi contract/chưa phân loại và token thủ công đều FAIL-CLOSED.

Không cần PDF thật / engine native: điểm dispatch nằm TRƯỚC `pdf_lib.open`, nên ta bẫy
"đã rơi xuống engine cũ" bằng một sentinel ném từ `pdf_lib.open`.
"""

from __future__ import annotations

import pytest

from app.workers import nup_engine


class _ReachedOldEngine(Exception):
    """Ném từ `pdf_lib.open` (mock) để chứng minh dispatch ĐÃ rơi xuống engine cũ."""


@pytest.fixture
def flag_on(monkeypatch):
    # Cờ master true-shape (test DEV_MODE=false ⇒ mặc định tắt). Bật để kiểm auto-route.
    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda **_: True
    )


@pytest.fixture
def trap_old_engine(monkeypatch):
    """Bẫy điểm rơi xuống engine cũ (`pdf_lib.open`) — khỏi cần file thật."""

    def _boom(*_args, **_kwargs):
        raise _ReachedOldEngine()

    monkeypatch.setattr(nup_engine.pdf_lib, "open", _boom)


def _spy_true_shape(monkeypatch, impl):
    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting.run_true_shape_nesting", impl
    )


def _settings(**over):
    base = {
        "isDieCutMode": True,           # tem bế (không phải cnc, không guillotine)
        "gridStrategy": "optimal_auto",  # "Xếp tối ưu"
        "layoutType": "sequential",     # không mixed_guillotine
        "taskMode": "nup",
        "detectedShapesByPage": {"0": "CUSTOM"},
    }
    base.update(over)
    return base


def _call(settings):
    return nup_engine._run_nup_engine_impl("nguon.pdf", "ra.pdf", settings)


# ── Định tuyến ────────────────────────────────────────────────────────────────
def test_dispatch_custom_optimal_runs_true_shape(flag_on, monkeypatch):
    calls = []

    def _fake(source, output, settings, job_id=None, progress_callback=None):
        calls.append(source)
        return "TRUE_SHAPE_OK"

    _spy_true_shape(monkeypatch, _fake)
    assert _call(_settings()) == "TRUE_SHAPE_OK"
    assert calls == ["nguon.pdf"]


def test_dispatch_custom_optimal_cnc_runs_true_shape(flag_on, monkeypatch):
    _spy_true_shape(
        monkeypatch, lambda *a, **k: "TRUE_SHAPE_OK"
    )
    assert _call(_settings(imposerMode="cnc")) == "TRUE_SHAPE_OK"


def test_dispatch_named_skips_true_shape(flag_on, trap_old_engine, monkeypatch):
    def _fail(*_a, **_k):
        raise AssertionError("hình có tên KHÔNG được gọi true-shape")

    _spy_true_shape(monkeypatch, _fail)
    # route_true_shape=False cho named ⇒ dispatch bỏ qua ⇒ rơi xuống engine cũ.
    with pytest.raises(_ReachedOldEngine):
        _call(_settings(detectedShapesByPage={"0": "TRIANGLE"}))


def test_dispatch_simple_grid_skips_true_shape(flag_on, trap_old_engine, monkeypatch):
    def _fail(*_a, **_k):
        raise AssertionError('"Lưới đơn giản" KHÔNG được gọi true-shape')

    _spy_true_shape(monkeypatch, _fail)
    with pytest.raises(_ReachedOldEngine):
        _call(_settings(gridStrategy="simple_auto"))


def test_dispatch_publication_grid_skips_true_shape(
    flag_on, trap_old_engine, monkeypatch
):
    def _fail(*_a, **_k):
        raise AssertionError("publication lưới đã chốt KHÔNG được gọi true-shape")

    _spy_true_shape(monkeypatch, _fail)
    with pytest.raises(_ReachedOldEngine):
        _call(_settings(forceLegacyGrid=True))


def test_dispatch_one_dao_skips_true_shape(flag_on, trap_old_engine, monkeypatch):
    def _fail(*_a, **_k):
        raise AssertionError("1 Dao (chữ nhật) KHÔNG được gọi true-shape")

    _spy_true_shape(monkeypatch, _fail)
    with pytest.raises(_ReachedOldEngine):
        _call(_settings(cutType="one_dao"))


def test_dispatch_off_by_default_skips_true_shape(trap_old_engine, monkeypatch):
    # KHÔNG bật cờ ⇒ auto-route tắt ⇒ CUSTOM vẫn đi engine cũ (hành vi cũ, an toàn).
    def _fail(*_a, **_k):
        raise AssertionError("cờ tắt thì KHÔNG được auto-route true-shape")

    _spy_true_shape(monkeypatch, _fail)
    with pytest.raises(_ReachedOldEngine):
        _call(_settings())


# ── Fallback ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("fallback_kind", ["compatibility", "quality"])
def test_dispatch_auto_chi_fallback_signal_da_phan_loai(
    fallback_kind, flag_on, trap_old_engine, monkeypatch
):
    from app.workers.nup_true_shape_nesting import (
        TrueShapeCompatibilityFallback,
        TrueShapeQualityFallback,
    )

    errors = {
        "compatibility": TrueShapeCompatibilityFallback("capability chưa hỗ trợ"),
        "quality": TrueShapeQualityFallback("lưới tốt hơn"),
    }

    def _raise(*_a, **_k):
        raise errors[fallback_kind]

    _spy_true_shape(monkeypatch, _raise)
    with pytest.raises(_ReachedOldEngine):
        _call(_settings())


@pytest.mark.parametrize(
    "error_kind", ["unclassified", "adapter", "manifest", "identifier", "render"]
)
def test_dispatch_auto_khong_che_loi_contract(
    error_kind, flag_on, trap_old_engine, monkeypatch
):
    """MAP-NEST-12: lỗi contract/chưa phân loại phải giữ nguyên, không fallback."""

    from app.core.nesting_manifest_store import (
        ManifestContractError,
        ManifestIdentifierError,
    )
    from app.core.nesting_production_adapter import ProductionAdapterError
    from app.workers.nesting_imposition_render import ManifestRenderContractError

    errors = {
        "unclassified": ValueError("lỗi ValueError chưa phân loại"),
        "adapter": ProductionAdapterError("TEST_ADAPTER", "adapter lệch contract"),
        "manifest": ManifestContractError("manifest lệch contract"),
        "identifier": ManifestIdentifierError("manifest id không canonical"),
        "render": ManifestRenderContractError("writer lệch contract"),
    }
    expected = type(errors[error_kind])

    def _raise(*_a, **_k):
        raise errors[error_kind]

    _spy_true_shape(monkeypatch, _raise)
    with pytest.raises(expected):
        _call(_settings())


def test_dispatch_manual_fail_closed_on_error(trap_old_engine, monkeypatch):
    # Thủ công (gridStrategy=true_shape_nesting): người dùng CHỦ ĐỘNG chọn ⇒ lỗi thì NÉM,
    # không âm thầm lùi lưới. Không cần cờ (is_true_shape_nesting_requested chỉ đọc gridStrategy).
    def _raise(*_a, **_k):
        raise ValueError("nesting sập thủ công")

    _spy_true_shape(monkeypatch, _raise)
    with pytest.raises(ValueError, match="nesting sập thủ công"):
        _call(_settings(gridStrategy="true_shape_nesting"))

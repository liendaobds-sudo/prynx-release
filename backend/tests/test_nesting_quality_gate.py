"""Cổng chất lượng nesting: "Xếp tối ưu" KHÔNG BAO GIỜ thua "Lưới đơn giản".

Bối cảnh lỗi thật: trên file khách, nesting cho 43 con/tờ trong khi lưới cho 54 (kém 20%).
Bộ test này khoá hai thứ:

1. **Luật so sánh** (`grid_wins`): lưới thắng khi ≥ nesting; lưới không đo được (0) thì KHÔNG
   chặn nesting.
2. **Đo được sức chứa lưới thật** cho một khuôn bế thật, và nó là số dương hợp lý — đây là
   nửa còn lại của phép so; nếu hàm đo luôn trả 0 thì cổng thành vô hiệu mà vẫn "pass".
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

from app.core.nesting_quality_gate import (
    GRID_PROBE_STRATEGY,
    QUALITY_GATE_POLICY_FINGERPRINT,
    QUALITY_GATE_PROOF_FIELD,
    QUALITY_GATE_PROOF_SCHEMA_VERSION,
    GridBeatsNestingSignal,
    build_quality_gate_decision_proof,
    grid_capacity_for_page,
    grid_capacity_from_settings,
    grid_wins,
    parse_quality_gate_decision_proof,
    quality_gate_input_fingerprint,
    verify_quality_gate_decision_proof,
)
from app.workers.imposition_pdf_form import PT_PER_MM

MM = PT_PER_MM
DIE_MM = 40.0


def _make_die_source(path: Path, page_count: int = 1) -> None:
    """Khuôn vuông 40mm vẽ bằng spot CutContour — nét thật để bộ dò trích."""

    size = DIE_MM * MM
    outer = f"0 0 m {size} 0 l {size} {size} l 0 {size} l h "
    pdf = pikepdf.Pdf.new()
    for _ in range(page_count):
        pdf.add_blank_page(page_size=(size, size))
        page = pdf.pages[-1]
        page.contents_add(
            pikepdf.Stream(
                pdf,
                (
                    f"q 0 0 0 rg 0 0 {size} {size} re f Q\n"
                    f"q 0 1 0 0 K 0.5 w {outer}S Q\n"
                ).encode("ascii"),
            )
        )
    pdf.save(str(path))
    pdf.close()


# ── 1. Luật so sánh ──────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "nesting,grid,expected",
    [
        (43, 54, True),    # ca lỗi thật: lưới hơn ⇒ lưới thắng
        (54, 43, False),   # nesting hơn ⇒ dùng nesting
        (50, 50, True),    # HOÀ ⇒ lưới thắng (rẻ hơn, là hành vi trước §B10)
        (43, 44, True),    # hơn 1 con vẫn tính
        (43, 42, False),
        (43, 0, False),    # không đo được lưới ⇒ KHÔNG chặn nesting
        (0, 0, False),
    ],
)
def test_grid_wins(nesting, grid, expected):
    assert grid_wins(nesting, grid) is expected


def test_grid_wins_gia_tri_rac_khong_chan():
    assert grid_wins(None, None) is False
    assert grid_wins("x", "y") is False


def test_signal_khong_phai_valueerror():
    """Tín hiệu KHÔNG được là ValueError: route đổi ValueError thành 422 cho người dùng."""

    signal = GridBeatsNestingSignal(grid_capacity=54, nesting_capacity=43)
    assert not isinstance(signal, ValueError)
    assert isinstance(signal, Exception)
    assert signal.grid_capacity == 54
    assert signal.nesting_capacity == 43
    assert "54" in str(signal) and "43" in str(signal)


def test_chien_luoc_do_la_optimal_auto():
    """Đo đường cũ bằng 'Xếp tối ưu' của engine lưới/tiler — đúng thứ user nhận trước §B10."""

    assert GRID_PROBE_STRATEGY == "optimal_auto"


# ── 2. Đo sức chứa lưới THẬT ────────────────────────────────────────────────
def test_do_duoc_suc_chua_luoi_that(tmp_path):
    """Khuôn 40mm trên tờ 320×430 (lề 5, hở 2) phải ra số dương hợp lý, không phải 0."""

    source = tmp_path / "khuon.pdf"
    _make_die_source(source)

    capacity = grid_capacity_for_page(
        str(source),
        0,
        usable_w_pt=(320.0 - 10.0) * MM,
        usable_h_pt=(430.0 - 10.0) * MM,
        gap_x_pt=2.0 * MM,
        gap_y_pt=2.0 * MM,
        sheet_w_pt=320.0 * MM,
        sheet_h_pt=430.0 * MM,
        margin_left_pt=5.0 * MM,
        margin_bottom_pt=5.0 * MM,
        margin_top_pt=5.0 * MM,
        shape_type="CUSTOM",
    )

    # Trần hình học: (310/42) × (420/42) = 7 × 10 = 70 ô cho khuôn 40mm + hở 2mm.
    assert capacity > 0, "phải đo được lưới, nếu luôn 0 thì cổng thành vô hiệu"
    assert capacity <= 70


def test_trang_ngoai_pham_vi_tra_0(tmp_path):
    """Chỉ số trang không hợp lệ ⇒ 0 ("không có ý kiến"), không ném."""

    source = tmp_path / "khuon.pdf"
    _make_die_source(source)
    assert (
        grid_capacity_for_page(
            str(source),
            5,
            usable_w_pt=300.0 * MM,
            usable_h_pt=400.0 * MM,
            gap_x_pt=2.0 * MM,
            gap_y_pt=2.0 * MM,
            sheet_w_pt=320.0 * MM,
            sheet_h_pt=430.0 * MM,
            margin_left_pt=5.0 * MM,
            margin_bottom_pt=5.0 * MM,
            margin_top_pt=5.0 * MM,
        )
        == 0
    )


def test_file_khong_ton_tai_tra_0():
    """File lỗi ⇒ 0, KHÔNG ném: cổng không được làm hỏng job."""

    assert (
        grid_capacity_for_page(
            "khong-ton-tai-abc.pdf",
            0,
            usable_w_pt=300.0 * MM,
            usable_h_pt=400.0 * MM,
            gap_x_pt=2.0 * MM,
            gap_y_pt=2.0 * MM,
            sheet_w_pt=320.0 * MM,
            sheet_h_pt=430.0 * MM,
            margin_left_pt=5.0 * MM,
            margin_bottom_pt=5.0 * MM,
            margin_top_pt=5.0 * MM,
        )
        == 0
    )


def test_settings_mm_cho_cung_ket_qua_voi_point(tmp_path):
    """`settings` (mm, export) và đối số point (preview) phải ra CÙNG một con số."""

    source = tmp_path / "khuon.pdf"
    _make_die_source(source)

    from_settings = grid_capacity_from_settings(
        str(source),
        {
            "sheetWidth": 320.0,
            "sheetHeight": 430.0,
            "marginLeft": 5.0,
            "marginRight": 5.0,
            "marginTop": 5.0,
            "marginBottom": 5.0,
            "gapX": 2.0,
            "gapY": 2.0,
            "cutType": "default",
            "dieSizeMode": "die",
            "detectedShapesByPage": {"0": "CUSTOM"},
            "pontType": "none",
        },
        0,
    )
    from_points = grid_capacity_for_page(
        str(source),
        0,
        usable_w_pt=(320.0 - 10.0) * MM,
        usable_h_pt=(430.0 - 10.0) * MM,
        gap_x_pt=2.0 * MM,
        gap_y_pt=2.0 * MM,
        sheet_w_pt=320.0 * MM,
        sheet_h_pt=430.0 * MM,
        margin_left_pt=5.0 * MM,
        margin_bottom_pt=5.0 * MM,
        margin_top_pt=5.0 * MM,
        shape_type="CUSTOM",
    )

    assert from_settings == from_points
    assert from_settings > 0


def test_settings_giu_point_chinh_xac_va_bleed_khi_goi_probe(monkeypatch):
    """Adapter export phải truyền point chính xác và bleed thật sang cùng probe của preview."""

    from app.core import nesting_quality_gate as gate

    captured = {}

    def _capture(_source_path, _page_index, **kwargs):
        captured.update(kwargs)
        return 7

    monkeypatch.setattr(gate, "grid_capacity_for_page", _capture)
    settings = {
        "sheetWidth": 320.0,
        "sheetHeight": 430.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "gapX": 2.0,
        "gapY": 2.0,
        "bleed": 1.5,
        "cutType": "default",
        "dieSizeMode": "die",
        "detectedShapesByPage": {"0": "CUSTOM"},
        "pontType": "none",
    }

    assert grid_capacity_from_settings("khuon.pdf", settings, 0) == 7
    assert captured["sheet_w_pt"] == pytest.approx(320.0 * MM, rel=0, abs=1e-12)
    assert captured["usable_w_pt"] == pytest.approx(310.0 * MM, rel=0, abs=1e-12)
    assert captured["gap_x_pt"] == pytest.approx(2.0 * MM, rel=0, abs=1e-12)
    assert captured["bleed_pt"] == pytest.approx(1.5 * MM, rel=0, abs=1e-12)


# ── 3. Nối dây: EXPORT lùi engine cũ khi lưới thắng ──────────────────────────
def _gate_settings(**over):
    base = {
        "isDieCutMode": True,
        "gridStrategy": "optimal_auto",  # AUTO (không phải token thủ công)
        "taskMode": "nup",
        "sheetWidth": 320.0,
        "sheetHeight": 430.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "gapX": 2.0,
        "gapY": 2.0,
        "detectedShapesByPage": {"0": "CUSTOM"},
        "pontType": "none",
    }
    base.update(over)
    return base


def test_export_gate_luoi_thang_thi_nem(monkeypatch):
    """Lưới 54 ≥ nesting 43 ⇒ ném ValueError để dispatch lùi engine cũ."""

    from app.workers import nup_true_shape_nesting as nts

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        lambda *_a, **_k: 54,
    )
    with pytest.raises(ValueError, match="dùng đường cũ"):
        nts._enforce_export_quality_gate(
            "khuon.pdf", _gate_settings(), page_index=0, nesting_capacity=43
        )


def test_export_gate_nesting_thang_thi_im(monkeypatch):
    """Nesting 351 > lưới 316 (ca tem lõm, đo B8) ⇒ KHÔNG ném, giữ nesting."""

    from app.workers import nup_true_shape_nesting as nts

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        lambda *_a, **_k: 316,
    )
    nts._enforce_export_quality_gate(
        "khuon.pdf", _gate_settings(), page_index=0, nesting_capacity=351
    )  # không ném


def test_export_gate_khong_ap_cho_token_thu_cong(monkeypatch):
    """Token thủ công = yêu cầu tường minh ⇒ cổng KHÔNG can thiệp (fail-closed giữ nguyên)."""

    from app.workers import nup_true_shape_nesting as nts

    def _boom(*_a, **_k):
        raise AssertionError("token thủ công thì KHÔNG được đo lưới")

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings", _boom
    )
    nts._enforce_export_quality_gate(
        "khuon.pdf",
        _gate_settings(gridStrategy="true_shape_nesting"),
        page_index=0,
        nesting_capacity=1,
    )  # không ném, không đo


def test_export_gate_khong_do_duoc_luoi_thi_giu_nesting(monkeypatch):
    """Lưới trả 0 (không đo được) ⇒ không chặn nesting."""

    from app.workers import nup_true_shape_nesting as nts

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        lambda *_a, **_k: 0,
    )
    nts._enforce_export_quality_gate(
        "khuon.pdf", _gate_settings(), page_index=0, nesting_capacity=5
    )  # không ném


# ── 4. Nối dây: PREVIEW ném tín hiệu (không phải ValueError) ─────────────────
def test_preview_gate_nem_tin_hieu(monkeypatch):
    """Preview: lưới thắng ⇒ `GridBeatsNestingSignal`, KHÔNG phải ValueError (tránh 422)."""

    from app.core import nesting_preview_capacity as cap

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        lambda *_a, **_k: 54,
    )
    with pytest.raises(GridBeatsNestingSignal) as info:
        cap._enforce_quality_gate(
            "khuon.pdf", _gate_settings(), page_index=0, nesting_capacity=43
        )
    assert info.value.grid_capacity == 54
    assert info.value.nesting_capacity == 43


def test_preview_gate_totals_cho_sr(monkeypatch):
    """S&R quyết theo TỔNG: 40+40 lưới ≥ 43+35 nesting ⇒ tín hiệu."""

    from app.core import nesting_preview_capacity as cap

    with pytest.raises(GridBeatsNestingSignal):
        cap._enforce_quality_gate_totals(nesting_capacity=78, grid_capacity=80)
    # Nesting hơn ⇒ im lặng.
    cap._enforce_quality_gate_totals(nesting_capacity=90, grid_capacity=80)


def test_runner_va_route_dung_cung_chien_luoc():
    """Chiến lược ĐO của cổng phải TRÙNG chiến lược TRẢ VỀ, nếu không số sẽ lệch."""

    import inspect

    from app.core import nesting_preview_jobs as jobs

    source = inspect.getsource(jobs._default_runner)
    assert "GRID_PROBE_STRATEGY" in source
    assert '"strategy": GRID_PROBE_STRATEGY' in source


# ── 5. Luật theo INTENT: hồi quy "so sai đơn vị" ─────────────────────────────
def test_quantity_fulfillment_khong_so_placed_voi_suc_chua():
    """HỒI QUY: đặt 6 con, nesting xếp đúng 6, lưới chứa 18/tờ ⇒ KHÔNG được coi là lưới thắng.

    Bản đầu so `placedCount`(6) với sức chứa lưới(18) ở mọi intent — sai đơn vị, cổng chặn oan
    nesting dù nó đã hoàn thành đơn trong 1 tờ. Đại lượng so được là SỐ TỜ.
    """

    from app.core.nesting_quality_gate import grid_beats_nesting

    assert (
        grid_beats_nesting(
            layout_intent="quantity_fulfillment",
            nesting_placed=6,
            nesting_sheets=1,
            total_quantity=6,
            grid_capacity=18,
        )
        is False
    )


def test_quantity_fulfillment_luoi_it_to_hon_thi_thang():
    """Lưới cần 2 tờ, nesting cần 3 ⇒ lưới thắng (ít tờ hơn = ít vật liệu hơn)."""

    from app.core.nesting_quality_gate import grid_beats_nesting

    assert (
        grid_beats_nesting(
            layout_intent="quantity_fulfillment",
            nesting_placed=100,
            nesting_sheets=3,
            total_quantity=100,
            grid_capacity=50,  # ceil(100/50) = 2 tờ
        )
        is True
    )


def test_quantity_fulfillment_hoa_so_to_thi_giu_nesting():
    """Hoà số tờ ⇒ giữ nesting (không mất vật liệu; nếu nhường thì nesting bị tắt gần hết)."""

    from app.core.nesting_quality_gate import grid_beats_nesting

    assert (
        grid_beats_nesting(
            layout_intent="quantity_fulfillment",
            nesting_placed=100,
            nesting_sheets=2,
            total_quantity=100,
            grid_capacity=50,  # ceil(100/50) = 2 = nesting ⇒ hoà
        )
        is False
    )


def test_autofill_so_theo_con_moi_to():
    """Autofill: so trực tiếp con/tờ; ca lỗi thật 43 vs 54 ⇒ lưới thắng. Hoà ⇒ lưới thắng."""

    from app.core.nesting_quality_gate import grid_beats_nesting

    def _decide(nesting, grid):
        return grid_beats_nesting(
            layout_intent="autofill_single_sheet",
            nesting_placed=nesting,
            nesting_sheets=1,
            total_quantity=0,
            grid_capacity=grid,
        )

    assert _decide(43, 54) is True    # ca lỗi thật
    assert _decide(351, 316) is False  # tem lõm: nesting thắng (đo B8)
    assert _decide(50, 50) is True     # hoà ⇒ lưới (rẻ hơn, hành vi trước §B10)
    assert _decide(43, 0) is False     # không đo được ⇒ giữ nesting


# ── 6. PERF-NEST-05: proof quyết định server-owned ───────────────────────────


def _proof_settings(**changes):
    settings = {
        "sheetWidth": 320.0,
        "sheetHeight": 430.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "gapX": 2.0,
        "gapY": 2.0,
        "bleed": 1.5,
        "cutType": "default",
        "dieSizeMode": "die",
        "dieOffsetMm": 0.25,
        "detectedShapesByPage": {"0": "CUSTOM"},
        "detectedShapeParamsByPage": {"0": {"radius": 3.0, "sides": 4}},
        "pontType": "corner",
        "pontConfig": {"size": 5.0, "enabled": True},
    }
    settings.update(changes)
    return settings


def _sha(character: str) -> str:
    return "sha256:" + character * 64


def _build_proof(settings=None, **changes):
    values = {
        "source_locator_id": "locator-server-1",
        "source_content_hash": _sha("a"),
        "input_hash": _sha("b"),
        "layout_fingerprint": _sha("c"),
        "page_index": 0,
        "layout_intent": "autofill_single_sheet",
        "nesting_placed": 43,
        "nesting_sheets": 1,
        "total_quantity": 0,
        "grid_capacity": 54,
    }
    values.update(changes)
    return build_quality_gate_decision_proof(settings or _proof_settings(), **values)


def _verify_context(**changes):
    values = {
        "source_locator_id": "locator-server-1",
        "source_content_hash": _sha("a"),
        "input_hash": _sha("b"),
        "layout_fingerprint": _sha("c"),
        "page_index": 0,
        "layout_intent": "autofill_single_sheet",
        "nesting_placed": 43,
        "nesting_sheets": 1,
        "total_quantity": 0,
    }
    values.update(changes)
    return values


def test_fingerprint_input_gate_tat_dinh_va_chi_phu_field_co_semantics():
    settings = _proof_settings()
    reordered = dict(reversed(list(settings.items())))
    reordered["fieldKhongLienQuan"] = "không được làm proof miss"

    baseline = quality_gate_input_fingerprint(settings, 0)
    assert quality_gate_input_fingerprint(reordered, 0) == baseline
    assert quality_gate_input_fingerprint(_proof_settings(gapX=2.1), 0) != baseline
    assert quality_gate_input_fingerprint(_proof_settings(gapX=2.0000001), 0) != baseline
    assert quality_gate_input_fingerprint(settings, 1) != baseline


def test_builder_tu_quyet_dinh_va_tra_schema_json_safe():
    proof = _build_proof()

    assert proof["schemaVersion"] == QUALITY_GATE_PROOF_SCHEMA_VERSION
    assert proof["policyFingerprint"] == QUALITY_GATE_POLICY_FINGERPRINT
    assert proof["normalizedInputFingerprint"] == quality_gate_input_fingerprint(
        _proof_settings(), 0
    )
    assert proof["decision"] == "grid"
    assert parse_quality_gate_decision_proof(proof) is not None
    assert QUALITY_GATE_PROOF_FIELD == "qualityGateProof"

    quantity_proof = _build_proof(
        layout_intent="quantity_fulfillment",
        nesting_placed=100,
        nesting_sheets=2,
        total_quantity=100,
        grid_capacity=50,
    )
    assert quantity_proof["decision"] == "nesting", "hoà số tờ phải giữ nesting"


def test_grid_capacity_zero_khong_duoc_tao_hoac_tin_proof():
    with pytest.raises(ValueError, match="grid_capacity=0"):
        _build_proof(grid_capacity=0)

    proof = _build_proof()
    proof_khong_co_y_kien = {
        **proof,
        "gridCapacity": 0,
        "decision": "nesting",
    }
    assert parse_quality_gate_decision_proof(proof_khong_co_y_kien) is None
    assert (
        verify_quality_gate_decision_proof(
            proof_khong_co_y_kien, _proof_settings(), **_verify_context()
        )
        is None
    )


def test_verifier_nhan_proof_khop_toan_bo_identity_server():
    proof = _build_proof()
    verified = verify_quality_gate_decision_proof(
        proof, _proof_settings(), **_verify_context()
    )

    assert verified is not None
    assert verified.decision == "grid"
    assert verified.grid_capacity == 54


@pytest.mark.parametrize(
    ("field", "stale_value"),
    [
        ("source_locator_id", "locator-khac"),
        ("source_content_hash", _sha("d")),
        ("input_hash", _sha("e")),
        ("layout_fingerprint", _sha("f")),
        ("page_index", 1),
        ("layout_intent", "quantity_fulfillment"),
        ("nesting_placed", 42),
        ("nesting_sheets", 2),
        ("total_quantity", 1),
    ],
)
def test_verifier_tra_stale_khi_identity_hay_metrics_doi(field, stale_value):
    proof = _build_proof()
    context = _verify_context(**{field: stale_value})

    assert (
        verify_quality_gate_decision_proof(proof, _proof_settings(), **context) is None
    )


def test_verifier_tra_stale_khi_policy_input_hoac_payload_bi_sua():
    proof = _build_proof()

    assert (
        verify_quality_gate_decision_proof(
            proof, _proof_settings(gapY=9.0), **_verify_context()
        )
        is None
    )

    stale_policy = {**proof, "policyFingerprint": _sha("9")}
    assert (
        verify_quality_gate_decision_proof(
            stale_policy, _proof_settings(), **_verify_context()
        )
        is None
    )

    contradictory = {**proof, "decision": "nesting"}
    assert parse_quality_gate_decision_proof(contradictory) is None
    assert (
        verify_quality_gate_decision_proof(
            contradictory, _proof_settings(), **_verify_context()
        )
        is None
    )


@pytest.mark.parametrize(
    "malformed",
    [
        None,
        {},
        {"decision": "grid"},
        {**_build_proof(), "extra": True},
        {**_build_proof(), "pageIndex": True},
        {**_build_proof(), "sourceContentHash": "không-phải-hash"},
    ],
)
def test_parser_proof_meo_khong_nem_va_khong_duoc_tin(malformed):
    assert parse_quality_gate_decision_proof(malformed) is None
    assert (
        verify_quality_gate_decision_proof(
            malformed, _proof_settings(), **_verify_context()
        )
        is None
    )

"""Hồi quy §NEST-PREVIEW-1: preview và export phải đọc CÙNG một manifest.

## Lỗi gốc

`POST /imposition/preview-layout` đưa `strategy` nguyên văn xuống
`sticker_imposer_pkg/orchestrator.py`, mà dispatch ở đó chỉ biết `optimal_auto`,
`head_to_tail`, `staggered`. `true_shape_nesting` rơi vào ``else: # grid``
(orchestrator.py:460) ⇒ preview tính bằng **lưới chữ nhật thuần**. Không log, không lỗi.
Trên file khách: preview 41 tem/tờ, engine thật 46, layout khác hẳn.

Lỗ thứ hai đi kèm: `attach_preview_session_reference` (route, lúc launch job) chỉ `peek()`
kho phiên. Vì chưa ai tạo phiên nên nó **luôn** no-op ⇒ process con solve lại từ đầu ⇒ bất
biến "preview ≡ output" không có gì bảo đảm.

## Bất biến khoá ở đây

1. Số của preview đến từ manifest, không phải từ lưới.
2. Hình của preview đến từ **cùng seam** mà writer dùng — chỉ có MỘT đường đọc pose.
3. Preview tạo phiên ⇒ export tái dùng ⇒ cùng `manifestId`.
4. Đổi trục Y đúng **một lần**: `diePolylines` là top-down, `absX/absY` là bottom-up.
5. Fail-closed: thiết lập ngoài phạm vi thì báo lỗi, không lặng lẽ rơi về lưới.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.nesting_preview_capacity import (
    PT_PER_MM,
    build_nesting_preview,
    settings_from_preview_request,
)
from app.core.nesting_preview_session import (
    get_preview_session_store,
    reset_preview_session_store,
)

SOURCE = Path(__file__).resolve().parents[2] / "test" / "test nesting.pdf"
requires_real_source = pytest.mark.skipif(
    not SOURCE.is_file(), reason=f"thiếu file nguồn thật: {SOURCE}"
)

SHEET_W_MM = 320.0
SHEET_H_MM = 430.0


def _request(**overrides) -> SimpleNamespace:
    """`PreviewLayoutRequest` tối thiểu — snake_case, đơn vị POINT, như frontend gửi."""

    parts = int(overrides.pop("parts", 3))
    quantities = {str(index): 0 for index in range(parts)}
    base = dict(
        strategy="true_shape_nesting",
        is_die_cut=True,
        imposer_mode=None,
        task_mode="nup",
        layout_type=None,
        grouping_strategy="free_gang",
        page_sheet_mode=False,
        sheet_w=SHEET_W_MM * PT_PER_MM,
        sheet_h=SHEET_H_MM * PT_PER_MM,
        gap_x=2.0 * PT_PER_MM,
        gap_y=2.0 * PT_PER_MM,
        bleed=0.0,
        margin_left=5.0 * PT_PER_MM,
        margin_right=5.0 * PT_PER_MM,
        margin_top=5.0 * PT_PER_MM,
        margin_bottom=5.0 * PT_PER_MM,
        align="center",
        pont_type=None,
        pont_config=None,
        cut_type="default",
        fill_block_gap=0.0,
        die_size_mode="die",
        die_offset_mm=0.0,
        separate_cut_page=True,
        ponts_on_cut_file=True,
        export_unique_sheets=True,
        report_display=None,
        report_material=None,
        report_lamination=None,
        report_lamination_sides=None,
        report_order_code=None,
        target_quantities_by_page=quantities,
        detected_shapes_by_page={key: "CUSTOM" for key in quantities},
        detected_shape_params_by_page={},
        path=str(SOURCE),
        file_id=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def _kho_phien_sach():
    reset_preview_session_store()
    yield
    reset_preview_session_store()


# ─────────────────────────────────────────────────────────────────────────────
#  1. Dịch hợp đồng: point → mm, snake → camel
# ─────────────────────────────────────────────────────────────────────────────


def test_doi_point_sang_mm_dung():
    settings = settings_from_preview_request(_request(bleed=1.5 * PT_PER_MM))

    assert settings["sheetWidth"] == pytest.approx(SHEET_W_MM)
    assert settings["sheetHeight"] == pytest.approx(SHEET_H_MM)
    assert settings["gapX"] == pytest.approx(2.0)
    assert settings["bleed"] == pytest.approx(1.5)
    assert settings["marginTop"] == pytest.approx(5.0)


def test_giu_dung_gridStrategy_de_job_khong_di_duong_khac():
    settings = settings_from_preview_request(_request())

    assert settings["gridStrategy"] == "true_shape_nesting"
    assert settings["isDieCutMode"] is True
    assert settings["groupingStrategy"] == "free_gang"


def test_giu_maximize_area_de_preview_va_export_cung_sinh_zone():
    settings = settings_from_preview_request(
        _request(grouping_strategy="maximize_area")
    )
    assert settings["groupingStrategy"] == "maximize_area"


def test_giu_so_luong_chung_va_cnc_duplex_giong_export():
    """MAP-NEST-01/02: field logic không được rơi ở biên snake_case → camelCase."""

    defaults = settings_from_preview_request(_request())
    assert defaults["targetQuantity"] == 0
    assert defaults["cncTwoSided"] is False
    assert defaults["cncFlipEdge"] == "long"

    settings = settings_from_preview_request(
        _request(
            target_quantity=17,
            target_quantities_by_page={"0": 5, "1": 0},
            imposer_mode="cnc",
            cnc_two_sided=True,
            cnc_flip_edge="short",
        )
    )

    assert settings["targetQuantity"] == 17
    assert settings["targetQuantitiesByPage"] == {"0": 5, "1": 0}
    assert settings["cncTwoSided"] is True
    assert settings["cncFlipEdge"] == "short"


def test_giu_shape_params_theo_trang_giong_export():
    params = {"0": {"outer": [[0, 0], [10, 0], [10, 10], [0, 10]]}}

    settings = settings_from_preview_request(
        _request(detected_shape_params_by_page=params)
    )

    assert settings["detectedShapeParamsByPage"] == params


def _full_report_display() -> dict:
    return {
        "enabled": True,
        "fieldOrder": [
            "orderCode",
            "identifier",
            "gangCount",
            "labelName",
            "material",
            "lamination",
            "labelsPerSheet",
            "actualQty",
            "sheetCount",
            "dimensions",
            "paperSize",
            "cutFileRef",
            "modeLabel",
        ],
        "showIdentifier": True,
        "showGangCount": True,
        "showLabelName": True,
        "showDimensions": True,
        "showPaperSize": True,
        "showLabelsPerSheet": True,
        "showSheetCount": True,
        "showActualQty": True,
        "showMaterial": True,
        "showLamination": True,
        "showCutFileRef": True,
        "showModeLabel": True,
        "labelNameText": "TEM",
        "position": "top",
        "centered": True,
        "offsetX": 5.0,
        "offsetY": 5.0,
        "fontSize": 8.0,
        "removeDiacritics": False,
    }


def _full_export_settings(req, report_display: dict) -> dict:
    """Payload camelCase tương đương đúng serializer export của desktop."""

    return {
        "gridStrategy": "true_shape_nesting",
        "isDieCutMode": True,
        "taskMode": "nup",
        "layoutType": getattr(req, "layout_type", None),
        "groupingStrategy": getattr(req, "grouping_strategy", "maximize_area"),
        "page_sheet_mode": False,
        "sheetWidth": SHEET_W_MM,
        "sheetHeight": SHEET_H_MM,
        "gapX": 2.0,
        "gapY": 2.0,
        "bleed": float(getattr(req, "bleed", 0.0) or 0.0) / PT_PER_MM,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "align": "center",
        "targetQuantitiesByPage": dict(req.target_quantities_by_page),
        "detectedShapesByPage": dict(req.detected_shapes_by_page),
        "detectedShapeParamsByPage": dict(req.detected_shape_params_by_page),
        "pontType": "5mm",
        "pontConfig": dict(_PONT_CONFIG),
        "cutType": "default",
        "fillBlockGap": 0.0,
        "dieSizeMode": "die",
        "dieOffsetMm": 0.0,
        "separateCutPage": True,
        "pontsOnCutFile": True,
        "exportUniqueSheets": True,
        "reportDisplay": report_display,
        "reportMaterial": "Decal PP",
        "reportLamination": 1,
        "reportLaminationSides": 1,
        "reportOrderCode": "DH-001",
    }


def test_khoa_settings_khop_de_phien_tai_dung_duoc_voi_export():
    """Preview và export phải dựng job có CÙNG `job_identity_key`.

    Thêm một khoá lạ vào settings của preview là làm khác identity ⇒ export solve lại ⇒
    bất biến preview ≡ output vỡ mà không có dấu hiệu nào.
    """

    from app.core.nesting_preview_session import job_identity_key
    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    report_display = _full_report_display()
    req = _request(
        grouping_strategy="maximize_area",
        pont_type="5mm",
        pont_config=dict(_PONT_CONFIG),
        separate_cut_page=True,
        ponts_on_cut_file=True,
        export_unique_sheets=True,
        report_display=report_display,
        report_material="Decal PP",
        report_lamination=1,
        report_lamination_sides=1,
        report_order_code="DH-001",
        bleed=1.5 * PT_PER_MM,
    )
    settings_preview = settings_from_preview_request(req)
    # Đúng những khoá mà `processHandlers` gửi cho job thật, cùng giá trị.
    settings_export = _full_export_settings(req, report_display)
    if not SOURCE.is_file():
        pytest.skip(f"thiếu file nguồn thật: {SOURCE}")

    job_preview = build_true_shape_nesting_job(str(SOURCE), settings_preview)
    job_export = build_true_shape_nesting_job(str(SOURCE), settings_export)

    assert settings_preview["pontType"] == "5mm"
    assert job_preview.grouping_intent == job_export.grouping_intent == "maximize_area"
    assert job_preview.placement_zones == job_export.placement_zones
    assert len(job_preview.placement_zones) == len(job_preview.parts)
    assert job_identity_key(job_preview) == job_identity_key(job_export)


# ─────────────────────────────────────────────────────────────────────────────
#  2. Số và hình đến từ manifest
# ─────────────────────────────────────────────────────────────────────────────


@requires_real_source
def test_so_luong_den_tu_manifest_khong_phai_luoi():
    request = _request(parts=3, grouping_strategy="maximize_area")
    result = build_nesting_preview(request, source_path=str(SOURCE))

    session = get_preview_session_store().peek(_job_for(request))
    assert session is not None
    stats = session.solved.manifest["stats"]
    contract = session.solved.production_request.engine_request["productionContract"]
    assert contract["groupingIntent"] == "maximize_area"
    assert len(contract["placementZones"]) == 3
    assert session.solved.manifest["validation"]["valid"] is True
    assert result["totalItems"] == stats["placedCount"]
    assert result["sheetsNeeded"] == stats["sheetCount"]
    assert result["strategyUsed"] == "true_shape_nesting"


@requires_real_source
def test_preview_nup_chi_gate_khi_auto_route_cho_phep(monkeypatch):
    """Token tường minh giữ nesting; auto-route gate trước khi chiếu geometry."""

    from app.core.nesting_quality_gate import GridBeatsNestingSignal
    from app.core import nesting_preview_capacity as cap

    gate_calls: list[tuple[str, int]] = []
    project_calls: list[int] = []

    def _record_gate(*, settings, job, session, store):
        gate_calls.append((str(session.source_pins[0].snapshot_path), job.parts[0].page_index))
        return {"decision": "grid", "gridCapacity": 43}

    monkeypatch.setattr(
        cap, "_quality_gate_proof_for_session", _record_gate
    )
    real_project = cap._project_sheet_cells

    def _record_project(*args, **kwargs):
        project_calls.append(1)
        return real_project(*args, **kwargs)

    monkeypatch.setattr(cap, "_project_sheet_cells", _record_project)
    strict = build_nesting_preview(
        _request(parts=1, allow_legacy_fallback=False), source_path=str(SOURCE)
    )
    assert strict["strategyUsed"] == "true_shape_nesting"
    assert gate_calls == []
    assert project_calls == [1]

    with pytest.raises(GridBeatsNestingSignal):
        build_nesting_preview(
            _request(parts=1, allow_legacy_fallback=True), source_path=str(SOURCE)
        )
    assert len(gate_calls) == 1
    assert Path(gate_calls[0][0]).name != SOURCE.name
    assert project_calls == [1], "grid thắng phải dừng trước bước chiếu nesting"


def test_quality_gate_dung_snapshot_pin_va_khong_luu_proof_khi_grid_bang_khong(
    monkeypatch,
):
    """Grid 0 là không có ý kiến; proof chỉ được lưu sau verify bằng identity pin."""

    from app.core import nesting_preview_capacity as cap
    from app.core import nesting_quality_gate as gate

    job = SimpleNamespace(
        parts=[SimpleNamespace(part_id="trang-1", page_index=0)]
    )
    session = SimpleNamespace()
    paths: list[str] = []
    remembered: list[dict] = []

    class _Store:
        @staticmethod
        def remember_quality_gate_proof(_job, proof):
            remembered.append(dict(proof))
            return True

    monkeypatch.setattr(
        gate,
        "quality_gate_source_for_session",
        lambda *_args, **_kwargs: {
            "source_path": "snapshot-pin.pdf",
            "source_locator_id": "locator-pin",
            "source_content_hash": "sha256:" + "1" * 64,
        },
    )

    def _grid_capacity(path, _settings, _page_index):
        paths.append(path)
        return 0

    monkeypatch.setattr(gate, "grid_capacity_from_settings", _grid_capacity)
    monkeypatch.setattr(
        gate,
        "build_quality_gate_proof_for_session",
        lambda *_args, **_kwargs: pytest.fail("grid 0 không được tạo proof"),
    )

    proof = cap._quality_gate_proof_for_session(
        settings={}, job=job, session=session, store=_Store()
    )

    assert proof is None
    assert paths == ["snapshot-pin.pdf"]
    assert remembered == []


def test_quality_gate_chi_luu_proof_server_owned_sau_khi_verify(monkeypatch):
    """Proof méo/stale không được vào store; proof hợp lệ được tách bản sao rồi lưu."""

    from app.core import nesting_preview_capacity as cap
    from app.core import nesting_quality_gate as gate

    job = SimpleNamespace(
        parts=[SimpleNamespace(part_id="trang-1", page_index=2)]
    )
    session = SimpleNamespace()
    raw_proof = {"decision": "nesting", "gridCapacity": 17}
    verified_proof = {**raw_proof, "pageIndex": 2}
    remembered: list[dict] = []

    class _Verified:
        @staticmethod
        def to_dict():
            return dict(verified_proof)

    class _Store:
        @staticmethod
        def remember_quality_gate_proof(_job, proof):
            remembered.append(dict(proof))
            return True

    monkeypatch.setattr(
        gate,
        "quality_gate_source_for_session",
        lambda *_args, **_kwargs: {
            "source_path": "snapshot-pin.pdf",
            "source_locator_id": "locator-pin",
            "source_content_hash": "sha256:" + "2" * 64,
        },
    )
    monkeypatch.setattr(gate, "grid_capacity_from_settings", lambda *_args: 17)
    monkeypatch.setattr(
        gate, "build_quality_gate_proof_for_session", lambda *_args, **_kwargs: raw_proof
    )
    monkeypatch.setattr(
        gate, "verify_quality_gate_proof_for_session", lambda *_args: _Verified()
    )

    proof = cap._quality_gate_proof_for_session(
        settings={}, job=job, session=session, store=_Store()
    )

    assert proof == verified_proof
    assert proof is not verified_proof
    assert remembered == [verified_proof]


@requires_real_source
def test_preview_sr_token_tuong_minh_khong_goi_layout_luoi():
    """S&R tường minh giữ từng manifest nesting, không chạy cổng per-design."""

    def _legacy_forbidden(_page_index: int):
        raise AssertionError("Token nesting tường minh không được dựng layout lưới.")

    result = build_nesting_preview(
        _request(
            parts=1,
            task_mode="step_repeat",
            layout_type="repeat",
            allow_legacy_fallback=False,
        ),
        source_path=str(SOURCE),
        legacy_preview_for_page=_legacy_forbidden,
    )
    assert result["strategyUsed"] == "true_shape_nesting"
    assert all(
        sheet["strategyUsed"] == "true_shape_nesting"
        for sheet in result["sheets"]
    )


def _job_for(req):
    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    return build_true_shape_nesting_job(
        str(SOURCE), settings_from_preview_request(req)
    )


@requires_real_source
def test_moi_placement_cua_to_dau_thanh_mot_cell():
    req = _request(parts=3)

    result = build_nesting_preview(req, source_path=str(SOURCE))

    session = get_preview_session_store().peek(_job_for(req))
    tren_to_0 = [
        item
        for item in session.solved.manifest["placements"]
        if int(item["sheetIndex"]) == 0
    ]
    assert len(result["cells"]) == len(tren_to_0)


@requires_real_source
def test_cell_mang_duong_be_that_khong_phai_bbox():
    """Nesting lồng các hình lõm vào nhau nên bbox chồng nhau — vẽ bbox là vẽ sai.

    `diePolylines` phải là contour thật, tức nhiều hơn 4 điểm với khuôn tự do.
    """

    result = build_nesting_preview(_request(parts=3), source_path=str(SOURCE))

    assert result["cells"]
    for cell in result["cells"]:
        assert cell["diePolylines"], "thiếu đường bế thật"
        diem = sum(len(ring) for ring in cell["diePolylines"])
        assert diem > 4, f"chỉ có {diem} điểm — đây là bbox, không phải đường bế"


@requires_real_source
def test_diePolylines_la_top_down_con_abs_la_bottom_up():
    """Hai quy ước Y ngược nhau trong hợp đồng sẵn có; đổi sai một lần là lật cả tờ."""

    result = build_nesting_preview(_request(parts=3), source_path=str(SOURCE))
    sheet_h_pt = SHEET_H_MM * PT_PER_MM

    for cell in result["cells"]:
        ys = [point[1] for ring in cell["diePolylines"] for point in ring]
        # top-down: y của contour + absY(bottom-up) + height ≈ chiều cao tờ.
        assert min(ys) == pytest.approx(
            sheet_h_pt - cell["absY"] - cell["height"], abs=0.05
        )
        assert max(ys) == pytest.approx(sheet_h_pt - cell["absY"], abs=0.05)
        # Và mọi điểm phải nằm trong tờ.
        assert 0.0 <= min(ys) and max(ys) <= sheet_h_pt + 0.05


@requires_real_source
def test_absPlacement_bat_de_frontend_khong_canh_giua_lai():
    result = build_nesting_preview(_request(parts=3), source_path=str(SOURCE))

    assert result["absPlacement"] is True
    assert result["coordinateSpace"] == "sheet_abs_pt"


@requires_real_source
def test_placedByPage_dem_theo_trang_nguon():
    req = _request(parts=3)

    result = build_nesting_preview(req, source_path=str(SOURCE))

    assert sum(result["placedByPage"].values()) == len(result["cells"])
    assert set(result["placedByPage"]) <= {"0", "1", "2"}


# ─────────────────────────────────────────────────────────────────────────────
#  3. Phiên: preview tạo, export tái dùng
# ─────────────────────────────────────────────────────────────────────────────


@requires_real_source
def test_preview_tao_phien_de_export_khong_solve_lai():
    """Đây là mắt xích còn thiếu của bất biến preview ≡ output."""

    req = _request(parts=3)
    assert get_preview_session_store().peek(_job_for(req)) is None

    build_nesting_preview(req, source_path=str(SOURCE))

    job = _job_for(req)
    phien = get_preview_session_store().peek(job)
    assert phien is not None, "preview phải để lại phiên cho export"

    lookup = get_preview_session_store().get_or_solve(job)
    assert lookup.reused is True, "export không được solve lại"
    assert lookup.session.manifest_id == phien.manifest_id


@requires_real_source
def test_file_khach_day_du_contract_export_render_manifest_preview_khong_solve_lai(
    tmp_path: Path, monkeypatch
):
    """Đúng ``test/test nesting.pdf`` + ốc 5mm + CUT/report như lượt UI đã log."""

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        reset_preview_session_store,
    )
    from app.core import nesting_production_pipeline as pipeline
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        attach_preview_session_reference,
        run_true_shape_nesting,
    )

    monkeypatch.setenv(
        "PRYNX_MIXED_NESTING_DATA_DIR", str(tmp_path / "nesting-artifacts")
    )
    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda: True
    )
    report_display = _full_report_display()
    req = _request(
        parts=13,
        layout_type="sequential",
        margin_left=3.0 * PT_PER_MM,
        margin_right=3.0 * PT_PER_MM,
        margin_top=3.0 * PT_PER_MM,
        margin_bottom=3.0 * PT_PER_MM,
        align="center",
        pont_type="5mm",
        pont_config=dict(_PONT_CONFIG),
        report_display=report_display,
        report_material="Decal PP",
        report_lamination=1,
        report_lamination_sides=1,
        report_order_code="DH-001",
    )

    preview = build_nesting_preview(req, source_path=str(SOURCE))
    session = get_preview_session_store().peek(_job_for(req))
    assert session is not None
    assert preview["totalItems"] == session.solved.manifest["stats"]["placedCount"]

    export_settings = _full_export_settings(req, report_display)
    export_settings.update(
        marginLeft=3.0,
        marginRight=3.0,
        marginTop=3.0,
        marginBottom=3.0,
    )
    attach_preview_session_reference(export_settings, str(SOURCE), job_id="realfile1")
    reference = export_settings.get(SESSION_REFERENCE_SETTING)
    assert reference == {
        "manifestId": session.manifest_id,
        "layoutFingerprint": session.layout_fingerprint,
        REPORT_HASH_FIELD: _report_hash_for_job(_job_for(req)),
    }

    # Mô phỏng process con: RAM rỗng nhưng manifest preview đã công bố trên đĩa.
    reset_preview_session_store()
    real_solver = pipeline.solve_production_nesting_job
    solve_calls: list[int] = []

    def _counting_solver(job, **kwargs):
        solve_calls.append(1)
        return real_solver(job, **kwargs)

    monkeypatch.setattr(pipeline, "solve_production_nesting_job", _counting_solver)
    output = tmp_path / "test-nesting-export.pdf"
    run_true_shape_nesting(
        str(SOURCE), str(output), export_settings, job_id="realfile1"
    )

    assert solve_calls == [], "export phải render manifest preview, không solve lại"
    assert output.is_file() and output.stat().st_size > 0


@requires_real_source
def test_hai_lan_preview_cung_thiet_lap_cho_cung_manifest():
    req = _request(parts=3)

    lan_1 = build_nesting_preview(req, source_path=str(SOURCE))
    lan_2 = build_nesting_preview(req, source_path=str(SOURCE))

    assert lan_1["totalItems"] == lan_2["totalItems"]
    assert lan_1["cells"] == lan_2["cells"]


# ─────────────────────────────────────────────────────────────────────────────
#  4. Fail-closed
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"is_die_cut": False, "imposer_mode": None}, "Bình tem bế"),
        ({"page_sheet_mode": True}, "nguyên tấm"),
        ({"layout_type": "mixed_guillotine"}, "nhiều kích thước"),
    ],
)
def test_ngoai_pham_vi_thi_bao_loi_khong_roi_ve_luoi(overrides, match):
    """Trả cho người dùng số của lưới trong khi họ chọn nesting chính là lỗi đang sửa.

    §B10: Bình trang (S&R) KHÔNG còn trong danh sách này — tem đặc biệt S&R nay đi true-shape
    (xem test_nup_true_shape_nesting_entry.test_step_repeat_token_duoc_phep). Ngoài phạm vi giờ
    chỉ còn: không phải tem bế/CNC, nguyên tấm decal, dàn nhiều kích thước.
    """

    with pytest.raises(ValueError, match=match):
        build_nesting_preview(_request(**overrides), source_path=str(SOURCE))


# ─────────────────────────────────────────────────────────────────────────────
#  5. Ốc bế phải vào settings của preview — §NEST-AUD-03
# ─────────────────────────────────────────────────────────────────────────────
#
# Ốc là **vật cản** của solver nên nó ĐỔI sức chứa (đo trên file khách: 46 → 44 con). Bỏ nó
# khỏi settings của preview nghĩa là preview đếm trên tờ trống còn export đếm trên tờ có bốn
# vùng cấm — đúng loại lệch mà lô §NEST-PREVIEW-1 đang sửa.
#
# Client mới gửi cả `pont_type` lẫn `pont_config`; fallback suy `custom` chỉ giữ tương
# thích cho client cũ. Loại thật phải được giữ vì nó nằm trong render/session identity.

_PONT_CONFIG = {
    "shape": "circle",
    "size": 5.0,
    "thickness": 0.5,
    "layerInfoName": "SA info",
    "layerName": "Pont",
    "groupName": "G",
    "itemName": "MKLINE",
    "disableCollision": False,
    "marginTop": 7.0,
    "marginBottom": 7.0,
    "marginLeft": 7.0,
    "marginRight": 7.0,
}


def test_khong_co_pont_config_thi_settings_khong_bat_oc():
    settings = settings_from_preview_request(_request(pont_config=None))

    assert settings["pontType"] == "none"
    assert "pontConfig" not in settings


def test_co_pont_config_thi_settings_bat_oc():
    """Client cũ chưa có ``pont_type`` vẫn được hiểu là ốc custom."""
    settings = settings_from_preview_request(_request(pont_config=dict(_PONT_CONFIG)))

    assert settings["pontType"] == "custom"
    assert settings["pontConfig"]["size"] == 5.0


def test_giu_nguyen_loai_oc_5mm_cua_request():
    settings = settings_from_preview_request(
        _request(pont_type="5mm", pont_config=dict(_PONT_CONFIG))
    )

    assert settings["pontType"] == "5mm"


def test_preview_co_oc_thi_job_co_vat_can():
    """Chốt đường dây: ốc của preview phải thành `fixed_obstacles` như export."""

    if not SOURCE.is_file():
        pytest.skip(f"thiếu file nguồn thật: {SOURCE}")

    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    job = build_true_shape_nesting_job(
        str(SOURCE),
        settings_from_preview_request(_request(pont_config=dict(_PONT_CONFIG))),
    )

    assert len(job.fixed_obstacles) == 4
    assert job.pont.type == "custom"


def test_oc_lam_doi_khoa_phien_giua_preview_va_export():
    """Preview có ốc và preview không ốc **không được** chia một phiên.

    Đây là hệ quả của §NEST-AUD-06 áp lên đúng ca thực tế nhất: người dùng bật/tắt ốc.
    """

    if not SOURCE.is_file():
        pytest.skip(f"thiếu file nguồn thật: {SOURCE}")

    from app.core.nesting_preview_session import job_identity_key
    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    khong_oc = build_true_shape_nesting_job(
        str(SOURCE), settings_from_preview_request(_request(pont_config=None))
    )
    co_oc = build_true_shape_nesting_job(
        str(SOURCE),
        settings_from_preview_request(_request(pont_config=dict(_PONT_CONFIG))),
    )

    assert job_identity_key(khong_oc) != job_identity_key(co_oc)


# ── §B10-4: preview S&R = mỗi mẫu một tờ (sheets[] cho pager) ─────────────────
def _fake_step_repeat_env(
    monkeypatch,
    pages: list[int],
    capacities: dict[int, int],
    *,
    store_capacity: int | None = None,
):
    """Giả lập solve S&R và trả cả store để kiểm publication batch."""

    from app.core import nesting_preview_capacity as cap

    def _fake_jobs(source, settings, *, job_id=None):
        return [
            SimpleNamespace(
                sheet_width_mm=320.0,
                sheet_height_mm=230.0,
                parts=[SimpleNamespace(part_id=f"trang-{p + 1}", page_index=p)],
            )
            for p in pages
        ]

    class _FakeStore:
        def __init__(self):
            self.capacity = store_capacity if store_capacity is not None else len(pages)
            self.reference_batch = None
            self.solve_calls = []
            self.reference_batch_state = None
            self.reference_batch_error = None

        def get_or_solve(self, job, **_kwargs):
            self.solve_calls.append((job, dict(_kwargs)))
            session = SimpleNamespace(solved=SimpleNamespace(manifest={"_job": job}))
            session_callback = _kwargs.get("session_callback")
            if session_callback is not None:
                session_callback(session)
            return SimpleNamespace(session=session, reused=False)

        def remember_reference_batch(self, jobs, references):
            self.reference_batch = (list(jobs), [dict(item) for item in references])

        def begin_reference_batch(self, jobs):
            self.reference_batch_state = object()
            return self.reference_batch_state

        def finish_reference_batch(
            self, jobs, state, *, references=None, error=None
        ):
            assert state is self.reference_batch_state
            if references is not None:
                self.remember_reference_batch(jobs, references)
            else:
                self.reference_batch_error = error

    store = _FakeStore()
    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting.build_true_shape_nesting_jobs", _fake_jobs
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store",
        lambda: store,
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.session_capacity",
        lambda session: capacities[int(session.solved.manifest["_job"].parts[0].page_index)],
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.session_sheet_count", lambda session: 1
    )
    monkeypatch.setattr(
        cap,
        "_project_sheet_cells",
        lambda job, session, *, sheet_index=0, collect_rings=None: [
            {"pageIdx": job.parts[0].page_index, "blockId": 0, "diePolylines": [[[0.0, 0.0]]]}
        ],
    )
    monkeypatch.setattr(
        cap,
        "_placed_by_page",
        lambda job, manifest: {str(job.parts[0].page_index): capacities[job.parts[0].page_index]},
    )
    return cap, store


def test_step_repeat_preview_tra_sheets_moi_mau(monkeypatch):
    """3 mẫu vượt LRU vẫn trả đủ sheets và đăng ký batch reference theo thứ tự."""

    cap, store = _fake_step_repeat_env(
        monkeypatch,
        [0, 1, 2],
        {0: 44, 1: 30, 2: 52},
        store_capacity=1,
    )

    def _commit_reference(session):
        page_index = int(session.solved.manifest["_job"].parts[0].page_index)
        return {
            "manifestId": f"manifest-{page_index}",
            "layoutFingerprint": f"layout-{page_index}",
        }

    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        _commit_reference,
    )
    result = cap._build_step_repeat_preview(
        "khuon.pdf",
        {"taskMode": "step_repeat", "isDieCutMode": True},
        job_id=None,
        cancel_event=None,
        progress_callback=None,
        subscriber_id=None,
        raise_if_cancelled=lambda: None,
    )

    assert result["strategyUsed"] == "true_shape_nesting"
    assert result["isMixedPreview"] is False
    assert result["absPlacement"] is True
    assert result["sheetsNeeded"] == 3
    assert len(result["sheets"]) == 3
    for design_index, sheet in enumerate(result["sheets"]):
        assert sheet["physicalSheetIndex"] == design_index
        assert sheet["cells"][0]["pageIdx"] == design_index
    assert [s["totalItems"] for s in result["sheets"]] == [44, 30, 52]
    # Tờ đang xem mặc định = tờ 0 (mẫu đầu).
    assert result["totalItems"] == 44
    assert result["cells"][0]["pageIdx"] == 0
    assert result["placedByPage"] == {"0": 44, "1": 30, "2": 52}
    assert store.reference_batch is not None
    assert store.reference_batch_error is None
    assert store.reference_batch[1] == [
        {"manifestId": "manifest-0", "layoutFingerprint": "layout-0"},
        {"manifestId": "manifest-1", "layoutFingerprint": "layout-1"},
        {"manifestId": "manifest-2", "layoutFingerprint": "layout-2"},
    ]


def test_step_repeat_preview_mot_mau_khong_pager(monkeypatch):
    """Một mẫu ⇒ sheets[] dài 1 (frontend ẩn pager); vẫn đúng khuôn phản hồi."""

    cap, _store = _fake_step_repeat_env(monkeypatch, [0], {0: 44})
    result = cap._build_step_repeat_preview(
        "khuon.pdf",
        {"taskMode": "step_repeat", "isDieCutMode": True},
        job_id=None,
        cancel_event=None,
        progress_callback=None,
        subscriber_id=None,
        raise_if_cancelled=lambda: None,
    )
    assert len(result["sheets"]) == 1
    assert result["sheetsNeeded"] == 1
    assert result["totalItems"] == 44


def test_step_repeat_preview_nhieu_mau_luon_cong_bo_batch_du_lru(monkeypatch):
    """Batch nhỏ vẫn cần latch/ref để Bình giữa wave không solve lại ở process con."""

    cap, store = _fake_step_repeat_env(
        monkeypatch,
        [0, 1],
        {0: 44, 1: 30},
        store_capacity=99,
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        lambda session: {
            "manifestId": "manifest-"
            + str(session.solved.manifest["_job"].parts[0].page_index),
            "layoutFingerprint": "layout-"
            + str(session.solved.manifest["_job"].parts[0].page_index),
        },
    )

    cap._build_step_repeat_preview(
        "khuon.pdf",
        {"taskMode": "step_repeat", "isDieCutMode": True},
        job_id="preview-batch-nho",
        cancel_event=None,
        progress_callback=None,
        subscriber_id="nguoi-xem",
        raise_if_cancelled=lambda: None,
    )

    assert store.reference_batch is not None
    assert store.reference_batch[1] == [
        {"manifestId": "manifest-0", "layoutFingerprint": "layout-0"},
        {"manifestId": "manifest-1", "layoutFingerprint": "layout-1"},
    ]


def test_step_repeat_preview_warm_batch_tai_dung_reference_khong_persist_lai(
    monkeypatch,
):
    """PERF-NEST-10: reference đã load/verify thì không ghi lại manifest nóng."""

    jobs = [
        SimpleNamespace(
            sheet_width_mm=320.0,
            sheet_height_mm=230.0,
            parts=[SimpleNamespace(part_id=f"trang-{index + 1}", page_index=index)],
        )
        for index in range(2)
    ]
    references = [
        {
            "manifestId": f"manifest-{index}",
            "layoutFingerprint": f"layout-{index}",
        }
        for index in range(2)
    ]

    class _WarmStore:
        capacity = 2

        def __init__(self):
            self.state = object()
            self.finished = None

        def begin_reference_batch(self, _jobs):
            return self.state

        def peek_reference_batch(self, _jobs):
            return [dict(reference) for reference in references]

        def get_or_solve(self, job, **kwargs):
            index = int(job.parts[0].page_index)
            session = SimpleNamespace(
                manifest_id=f"manifest-{index}",
                layout_fingerprint=f"layout-{index}",
                solved=SimpleNamespace(manifest={"_job": job}),
            )
            callback = kwargs.get("session_callback")
            if callback is not None:
                callback(session)
            return SimpleNamespace(session=session, reused=True)

        def finish_reference_batch(self, _jobs, state, *, references=None, error=None):
            assert state is self.state
            self.finished = (references, error)

    store = _WarmStore()
    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting.build_true_shape_nesting_jobs",
        lambda _source, _settings, job_id=None: jobs,
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store",
        lambda: store,
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.session_capacity",
        lambda _session: 44,
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.session_sheet_count",
        lambda _session: 1,
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_capacity._project_sheet_cells",
        lambda job, _session, *, sheet_index=0, collect_rings=None: [
            {
                "pageIdx": job.parts[0].page_index,
                "blockId": 0,
                "diePolylines": [[[0.0, 0.0]]],
            }
        ],
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_capacity._placed_by_page",
        lambda job, _manifest: {str(job.parts[0].page_index): 44},
    )
    persist_calls: list[object] = []
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        lambda session: persist_calls.append(session) or {
            "manifestId": "unexpected",
            "layoutFingerprint": "unexpected",
        },
    )

    result = _build_step_repeat_preview_for_test(monkeypatch)

    assert result["placedByPage"] == {"0": 44, "1": 44}
    assert persist_calls == []
    assert store.finished == (references, None)


def _build_step_repeat_preview_for_test(monkeypatch):
    """Gọi hàm nội bộ sau khi test đã cài store/runner giả."""

    from app.core import nesting_preview_capacity as cap

    return cap._build_step_repeat_preview(
        "khuon.pdf",
        {"taskMode": "step_repeat", "isDieCutMode": True},
        job_id="warm-reference",
        cancel_event=None,
        progress_callback=None,
        subscriber_id="warm-reference",
        legacy_preview_for_page=None,
        allow_legacy_fallback=False,
        raise_if_cancelled=lambda: None,
    )


def test_step_repeat_gate_truoc_commit_va_chi_dung_geometry_cua_duong_thang(
    monkeypatch,
):
    """Proof/reference giữ design_index; nesting thắng không dựng geometry lưới."""

    from app.core.nesting_quality_gate import QUALITY_GATE_PROOF_FIELD

    cap, store = _fake_step_repeat_env(
        monkeypatch,
        [0, 1],
        {0: 44, 1: 30},
        store_capacity=1,
    )
    gated: set[int] = set()
    committed: set[int] = set()
    projected: list[int] = []
    legacy_pages: list[int] = []

    def _proof_for_design(*, settings, job, session, store):
        del settings, session, store
        page_index = int(job.parts[0].page_index)
        gated.add(page_index)
        return {
            "decision": "grid" if page_index == 1 else "nesting",
            "gridCapacity": 35 if page_index == 1 else 40,
            "pageIndex": page_index,
        }

    monkeypatch.setattr(cap, "_quality_gate_proof_for_session", _proof_for_design)

    def _commit_reference(session):
        page_index = int(session.solved.manifest["_job"].parts[0].page_index)
        assert page_index in gated, "gate phải hoàn tất trước commit"
        committed.add(page_index)
        return {
            "manifestId": f"manifest-{page_index}",
            "layoutFingerprint": f"layout-{page_index}",
        }

    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        _commit_reference,
    )

    def _project(job, _session, *, sheet_index=0, collect_rings=None):
        del sheet_index, collect_rings
        page_index = int(job.parts[0].page_index)
        projected.append(page_index)
        return [{"pageIdx": page_index, "geometry": "nesting"}]

    monkeypatch.setattr(cap, "_project_sheet_cells", _project)

    def _legacy(page_index):
        legacy_pages.append(page_index)
        return {
            "success": True,
            "totalItems": 35,
            "strategyUsed": "optimal_auto",
            "cells": [{"pageIdx": page_index, "geometry": "grid"}],
            "sheetsNeeded": 1,
        }

    original_finish = store.finish_reference_batch

    def _finish_after_all_lanes(jobs, state, *, references=None, error=None):
        if references is not None:
            assert gated == committed == {0, 1}
        return original_finish(
            jobs, state, references=references, error=error
        )

    store.finish_reference_batch = _finish_after_all_lanes
    result = cap._build_step_repeat_preview(
        "khuon.pdf",
        {"taskMode": "step_repeat", "isDieCutMode": True},
        job_id="preview-gate",
        cancel_event=None,
        progress_callback=None,
        subscriber_id="nguoi-xem",
        legacy_preview_for_page=_legacy,
        allow_legacy_fallback=True,
        raise_if_cancelled=lambda: None,
    )

    assert result["strategyUsed"] == "per_design_best"
    assert [sheet["strategyUsed"] for sheet in result["sheets"]] == [
        "true_shape_nesting",
        "optimal_auto",
    ]
    assert projected == [0]
    assert legacy_pages == [1]
    assert result["sheets"][0]["cells"][0]["geometry"] == "nesting"
    assert result["sheets"][1]["cells"][0]["geometry"] == "grid"
    assert store.reference_batch is not None
    references = store.reference_batch[1]
    assert [ref[QUALITY_GATE_PROOF_FIELD]["pageIndex"] for ref in references] == [
        0,
        1,
    ]
    assert [ref[QUALITY_GATE_PROOF_FIELD]["decision"] for ref in references] == [
        "nesting",
        "grid",
    ]


def test_step_repeat_preview_spill_commit_loi_phai_fail_closed(monkeypatch):
    """Mất một manifest spill không được trả publication thiếu reference."""

    cap, store = _fake_step_repeat_env(
        monkeypatch,
        [0, 1, 2],
        {0: 44, 1: 30, 2: 52},
        store_capacity=1,
    )

    def _commit_reference(session):
        page_index = int(session.solved.manifest["_job"].parts[0].page_index)
        if page_index == 1:
            raise OSError("ổ đĩa tạm thời không ghi được")
        return {
            "manifestId": f"manifest-{page_index}",
            "layoutFingerprint": f"layout-{page_index}",
        }

    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        _commit_reference,
    )
    with pytest.raises(RuntimeError, match=r"mẫu 2/3") as exc_info:
        cap._build_step_repeat_preview(
            "khuon.pdf",
            {"taskMode": "step_repeat", "isDieCutMode": True},
            job_id=None,
            cancel_event=None,
            progress_callback=None,
            subscriber_id=None,
            raise_if_cancelled=lambda: None,
        )
    assert isinstance(exc_info.value.__cause__, OSError)
    assert store.reference_batch is None
    assert isinstance(store.reference_batch_error, RuntimeError)


def test_step_repeat_preview_spill_batch_loi_phai_fail_closed(monkeypatch):
    """Đủ manifest nhưng không đăng ký được batch cũng không được công bố preview."""

    cap, store = _fake_step_repeat_env(
        monkeypatch,
        [0, 1],
        {0: 44, 1: 30},
        store_capacity=1,
    )

    def _commit_reference(session):
        page_index = int(session.solved.manifest["_job"].parts[0].page_index)
        return {
            "manifestId": f"manifest-{page_index}",
            "layoutFingerprint": f"layout-{page_index}",
        }

    def _remember_failure(_jobs, _references):
        raise OSError("không lưu được batch identity")

    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        _commit_reference,
    )
    monkeypatch.setattr(store, "remember_reference_batch", _remember_failure)
    with pytest.raises(RuntimeError, match=r"batch reference"):
        cap._build_step_repeat_preview(
            "khuon.pdf",
            {"taskMode": "step_repeat", "isDieCutMode": True},
            job_id=None,
            cancel_event=None,
            progress_callback=None,
            subscriber_id=None,
            raise_if_cancelled=lambda: None,
        )


def test_step_repeat_preview_wave_giu_thu_tu_va_chia_dung_worker_grant(
    monkeypatch,
):
    """Completion đảo vẫn giữ thứ tự mẫu, reference và ngân sách từng wave."""

    import threading

    pages = [0, 1, 2, 3, 4]
    capacities = {0: 44, 1: 30, 2: 52, 3: 18, 4: 27}
    cap, store = _fake_step_repeat_env(
        monkeypatch,
        pages,
        capacities,
        # Cố ý nhỏ hơn wave: callback phải chạy khi session còn được LRU bảo vệ.
        store_capacity=1,
    )
    planner_calls: list[int] = []

    class _FakePlan:
        total_worker_grant = 12
        max_parallel_jobs = 2
        reason = "kế hoạch test: hai lane"

        def grants_for_wave(self, active_jobs: int) -> tuple[int, ...]:
            planner_calls.append(active_jobs)
            return (7, 5) if active_jobs == 2 else (12,)

    monkeypatch.setattr(
        "app.core.mixed_nesting_service.plan_batch_hardware",
        lambda job_count: _FakePlan() if job_count == len(pages) else pytest.fail(
            f"planner nhận sai số job: {job_count}"
        ),
    )

    lock = threading.Lock()
    barriers = {0: threading.Barrier(2), 1: threading.Barrier(2)}
    odd_finished = {0: threading.Event(), 1: threading.Event()}
    completions: list[int] = []
    grants_by_page: dict[int, int] = {}
    subscriber_ids: dict[int, str | None] = {}
    cancel_ids: set[int] = set()
    active = 0
    peak_active = 0

    def _solve_out_of_order(job, **kwargs):
        nonlocal active, peak_active
        page_index = int(job.parts[0].page_index)
        with lock:
            # Helper phải chờ hết wave trước rồi mới submit wave kế.
            expected_previous = set(range((page_index // 2) * 2))
            assert expected_previous.issubset(completions)
            active += 1
            peak_active = max(peak_active, active)
            grants_by_page[page_index] = kwargs[
                "runtime_worker_grant_request"
            ].worker_grant
            subscriber_ids[page_index] = kwargs.get("subscriber_id")
            cancel_ids.add(id(kwargs.get("cancel_event")))

        def _finish():
            session = SimpleNamespace(solved=SimpleNamespace(manifest={"_job": job}))
            session_callback = kwargs.get("session_callback")
            assert callable(session_callback)
            session_callback(session)
            with lock:
                completions.append(page_index)
            return SimpleNamespace(session=session, reused=False)

        try:
            if page_index == pages[-1]:
                return _finish()
            wave_index = page_index // 2
            barriers[wave_index].wait(timeout=5.0)
            if page_index % 2 == 1:
                result = _finish()
                odd_finished[wave_index].set()
                return result
            assert odd_finished[wave_index].wait(timeout=5.0)
            return _finish()
        finally:
            with lock:
                active -= 1

    store.get_or_solve = _solve_out_of_order

    commit_order: list[int] = []

    def _commit_reference(session):
        page_index = int(session.solved.manifest["_job"].parts[0].page_index)
        with lock:
            commit_order.append(page_index)
        return {
            "manifestId": f"manifest-{page_index}",
            "layoutFingerprint": f"layout-{page_index}",
        }

    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        _commit_reference,
    )
    result = cap._build_step_repeat_preview(
        "khuon.pdf",
        {"taskMode": "step_repeat", "isDieCutMode": True},
        job_id="preview-wave",
        cancel_event=None,
        progress_callback=None,
        subscriber_id="nguoi-xem-goc",
        raise_if_cancelled=lambda: None,
    )

    assert peak_active == 2
    assert planner_calls == [2, 2, 1]
    assert grants_by_page == {0: 7, 1: 5, 2: 7, 3: 5, 4: 12}
    assert len(set(subscriber_ids.values())) == len(pages)
    assert len(cancel_ids) == 1
    assert completions == [1, 0, 3, 2, 4]
    assert commit_order == completions
    assert [sheet["cells"][0]["pageIdx"] for sheet in result["sheets"]] == pages
    assert [sheet["totalItems"] for sheet in result["sheets"]] == [
        capacities[page] for page in pages
    ]
    assert result["placedByPage"] == {
        str(page): capacities[page] for page in pages
    }
    assert store.reference_batch is not None
    assert store.reference_batch[1] == [
        {
            "manifestId": f"manifest-{page}",
            "layoutFingerprint": f"layout-{page}",
        }
        for page in pages
    ]


@pytest.mark.parametrize(
    ("total_ram_mb", "expected_grant", "expected_parallel"),
    [
        (7 * 1024, 1, 1),
        (12 * 1024, 2, 2),
        (32 * 1024, 15, 13),
    ],
)
def test_step_repeat_batch_planner_chi_giam_may_yeu(
    monkeypatch,
    total_ram_mb,
    expected_grant,
    expected_parallel,
):
    """<8/<16 GB được bảo vệ; máy 32 GB giữ đủ cpu-1 cho toàn wave."""

    from app.core.mixed_nesting_service import (
        WORKER_COUNT_ENV,
        plan_batch_hardware,
    )

    monkeypatch.delenv(WORKER_COUNT_ENV, raising=False)
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (float(total_ram_mb), float(total_ram_mb) * 0.8),
    )
    plan = plan_batch_hardware(13, cpu_count=16)

    assert plan.total_worker_grant == expected_grant
    assert plan.max_parallel_jobs == expected_parallel
    grants = plan.grants_for_wave(plan.max_parallel_jobs)
    assert sum(grants) == expected_grant
    assert max(grants) - min(grants) <= 1


def test_step_repeat_preview_wave_huy_cha_khong_chay_wave_ke(monkeypatch):
    """Cancel cha phải dừng siblings, không submit mẫu của wave kế hay publication."""

    import threading

    cap, store = _fake_step_repeat_env(
        monkeypatch,
        [0, 1, 2],
        {0: 44, 1: 30, 2: 52},
        store_capacity=1,
    )

    class _FakePlan:
        total_worker_grant = 2
        max_parallel_jobs = 2
        reason = "kế hoạch test cancel"

        @staticmethod
        def grants_for_wave(active_jobs: int) -> tuple[int, ...]:
            return (1,) * active_jobs

    monkeypatch.setattr(
        "app.core.mixed_nesting_service.plan_batch_hardware",
        lambda _job_count: _FakePlan(),
    )

    parent_cancel = threading.Event()
    first_wave_ready = threading.Barrier(2)
    started: list[int] = []
    lock = threading.Lock()

    def _cancel_during_first_wave(job, **kwargs):
        page_index = int(job.parts[0].page_index)
        with lock:
            started.append(page_index)
        first_wave_ready.wait(timeout=5.0)
        if page_index == 1:
            parent_cancel.set()
            raise InterruptedError("client đã hủy preview")
        assert kwargs["cancel_event"].wait(timeout=5.0)
        raise InterruptedError("lane sibling nhận cancel")

    store.get_or_solve = _cancel_during_first_wave

    def _raise_if_cancelled():
        if parent_cancel.is_set():
            raise InterruptedError("client đã hủy preview")

    with pytest.raises(InterruptedError):
        cap._build_step_repeat_preview(
            "khuon.pdf",
            {"taskMode": "step_repeat", "isDieCutMode": True},
            job_id="preview-cancel",
            cancel_event=parent_cancel,
            progress_callback=None,
            subscriber_id="nguoi-xem-goc",
            raise_if_cancelled=_raise_if_cancelled,
        )

    assert sorted(started) == [0, 1]
    assert store.reference_batch is None


def test_shared_worker_grant_mot_batch_van_dung_het_ngan_sach():
    """Máy mạnh không bị cap: một batch vẫn đồng thời giữ đủ toàn bộ grant."""

    import threading

    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator

    coordinator = SharedBatchWorkerGrantCoordinator()
    lease = coordinator.register(3)
    entered = threading.Barrier(2)
    active_lock = threading.Lock()
    active = 0
    peak = 0

    def _run(request):
        nonlocal active, peak
        with request.claim() as grant:
            with active_lock:
                active += grant
                peak = max(peak, active)
            entered.wait(timeout=5.0)
            with active_lock:
                active -= grant

    threads = [
        threading.Thread(target=_run, args=(lease.request(grant),))
        for grant in (2, 1)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5.0)
        assert not thread.is_alive(), "coordinator deadlock ở đường một batch"

    assert peak == 3
    assert coordinator.snapshot() == {
        "capacity": 3,
        "held": 0,
        "batches": 1,
        "waiters": 0,
    }
    lease.close()
    assert coordinator.snapshot() == {
        "capacity": 0,
        "held": 0,
        "batches": 0,
        "waiters": 0,
    }


def test_shared_worker_grant_hai_batch_khong_nhan_doi_cpu():
    """Hai preview chia cùng capacity; tổng grant active không được thành 2× máy."""

    import threading
    import time

    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator

    coordinator = SharedBatchWorkerGrantCoordinator()
    leases = {name: coordinator.register(3) for name in ("A", "B")}
    start = threading.Barrier(4)
    lock = threading.Lock()
    active_total = 0
    peak_total = 0
    completed: list[str] = []
    errors: list[BaseException] = []

    def _run(name: str, grant: int) -> None:
        nonlocal active_total, peak_total
        try:
            request = leases[name].request(grant)
            start.wait(timeout=5.0)
            with request.claim() as actual:
                with lock:
                    active_total += actual
                    peak_total = max(peak_total, active_total)
                    assert active_total <= 3
                time.sleep(0.03)
                with lock:
                    active_total -= actual
                    completed.append(name)
        except BaseException as exc:  # pragma: no cover - assert cuối hiện lỗi thread
            with lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=_run, args=(name, grant))
        for name in ("A", "B")
        for grant in (2, 1)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5.0)
        assert not thread.is_alive(), "coordinator deadlock giữa hai batch"

    assert errors == []
    # Bounded bypass có thể chủ đích giữ 1 token để grant 2 không starvation;
    # full-utilization một batch đã được khóa ở test ngay phía trên.
    assert 1 <= peak_total <= 3
    assert sorted(completed) == ["A", "A", "B", "B"]
    assert coordinator.snapshot()["held"] == 0
    for lease in leases.values():
        lease.close()
    assert coordinator.snapshot()["batches"] == 0


def test_shared_worker_grant_giu_token_sau_mot_lan_bypass_de_khong_starve():
    """Chuỗi grant 1 chỉ được bypass waiter 2 một lần rồi phải tích token."""

    import threading
    import time

    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator

    coordinator = SharedBatchWorkerGrantCoordinator()
    holder_lease = coordinator.register(3)
    heavy_lease = coordinator.register(3)
    small_lease = coordinator.register(3)
    holder_entered = threading.Event()
    release_holder = threading.Event()
    heavy_entered = threading.Event()
    release_heavy = threading.Event()
    stop_small = threading.Event()
    small_lock = threading.Lock()
    small_completed = 0

    def _holder() -> None:
        with holder_lease.request(2).claim():
            holder_entered.set()
            assert release_holder.wait(timeout=5.0)

    def _heavy() -> None:
        with heavy_lease.request(2).claim():
            heavy_entered.set()
            assert release_heavy.wait(timeout=5.0)

    def _small_stream() -> None:
        nonlocal small_completed
        while not stop_small.is_set():
            with small_lease.request(1).claim():
                with small_lock:
                    small_completed += 1

    holder_thread = threading.Thread(target=_holder)
    holder_thread.start()
    assert holder_entered.wait(timeout=5.0)
    heavy_thread = threading.Thread(target=_heavy)
    heavy_thread.start()
    deadline = time.monotonic() + 2.0
    while coordinator.snapshot()["waiters"] < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert coordinator.snapshot()["waiters"] >= 1

    small_thread = threading.Thread(target=_small_stream)
    small_thread.start()
    time.sleep(0.2)
    with small_lock:
        completed_before_release = small_completed
    assert completed_before_release <= 1
    assert not heavy_entered.is_set()

    release_holder.set()
    assert heavy_entered.wait(timeout=1.0), "waiter grant 2 bị stream grant 1 làm đói"
    stop_small.set()
    release_heavy.set()
    for thread in (holder_thread, heavy_thread, small_thread):
        thread.join(timeout=5.0)
        assert not thread.is_alive()
    for lease in (holder_lease, heavy_lease, small_lease):
        lease.close()
    assert coordinator.snapshot()["batches"] == 0


def test_shared_worker_grant_cancel_va_exception_khong_ro_quota():
    """Waiter cancel và owner lỗi đều phải trả sạch quota cho batch kế tiếp."""

    import threading
    import time

    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator

    coordinator = SharedBatchWorkerGrantCoordinator()
    holder = coordinator.register(1)
    waiter_lease = coordinator.register(1)
    holder_entered = threading.Event()
    release_holder = threading.Event()
    cancel_waiter = threading.Event()
    waiter_errors: list[BaseException] = []

    def _hold() -> None:
        with holder.request(1).claim():
            holder_entered.set()
            assert release_holder.wait(timeout=5.0)

    def _wait_then_cancel() -> None:
        try:
            with waiter_lease.request(1).claim(cancel_waiter.is_set):
                pytest.fail("waiter đã hủy không được vào vùng solve")
        except BaseException as exc:
            waiter_errors.append(exc)

    holder_thread = threading.Thread(target=_hold)
    holder_thread.start()
    assert holder_entered.wait(timeout=5.0)
    waiter_thread = threading.Thread(target=_wait_then_cancel)
    waiter_thread.start()
    deadline = time.monotonic() + 2.0
    while coordinator.snapshot()["waiters"] != 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert coordinator.snapshot()["waiters"] == 1

    cancel_waiter.set()
    waiter_thread.join(timeout=1.0)
    assert not waiter_thread.is_alive()
    assert len(waiter_errors) == 1
    assert isinstance(waiter_errors[0], InterruptedError)
    assert coordinator.snapshot()["waiters"] == 0

    release_holder.set()
    holder_thread.join(timeout=5.0)
    assert not holder_thread.is_alive()
    holder.close()
    waiter_lease.close()

    next_lease = coordinator.register(1)
    with pytest.raises(RuntimeError, match="boom"):
        with next_lease.request(1).claim():
            raise RuntimeError("boom")
    assert coordinator.snapshot()["held"] == 0
    with next_lease.request(1).claim() as grant:
        assert grant == 1
    next_lease.close()
    assert coordinator.snapshot()["batches"] == 0

    poison_lease = coordinator.register(1)

    def _cancel_callback_loi() -> bool:
        raise RuntimeError("cancel-check-boom")

    with pytest.raises(RuntimeError, match="cancel-check-boom"):
        with poison_lease.request(1).claim(_cancel_callback_loi):
            pytest.fail("cancel callback lỗi không được vào solve")
    assert coordinator.snapshot()["held"] == 0
    assert coordinator.snapshot()["waiters"] == 0
    poison_lease.close()
    assert coordinator.snapshot()["batches"] == 0


def test_shared_worker_grant_close_active_van_giu_capacity_toi_release():
    """Tombstone cap thấp còn active phải chặn batch cap cao vượt ngân sách cũ."""

    import threading

    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator

    coordinator = SharedBatchWorkerGrantCoordinator()
    low_lease = coordinator.register(1)
    low_entered = threading.Event()
    release_low = threading.Event()
    high_entered = threading.Event()

    def _low() -> None:
        with low_lease.request(1).claim():
            low_entered.set()
            assert release_low.wait(timeout=5.0)

    low_thread = threading.Thread(target=_low)
    low_thread.start()
    assert low_entered.wait(timeout=5.0)
    low_lease.close()

    high_lease = coordinator.register(3)

    def _high() -> None:
        with high_lease.request(2).claim():
            high_entered.set()

    high_thread = threading.Thread(target=_high)
    high_thread.start()
    high_thread.join(timeout=0.1)
    assert high_thread.is_alive()
    assert coordinator.snapshot()["capacity"] == 1
    assert coordinator.snapshot()["held"] == 1

    release_low.set()
    low_thread.join(timeout=5.0)
    assert high_entered.wait(timeout=5.0)
    high_thread.join(timeout=5.0)
    assert not low_thread.is_alive() and not high_thread.is_alive()
    high_lease.close()
    assert coordinator.snapshot()["batches"] == 0


def test_step_repeat_dong_lease_neu_khoi_tao_executor_loi(monkeypatch):
    """Constructor executor ném lỗi cũng không được để batch registration treo."""

    from app.workers.nup_true_shape_nesting import run_step_repeat_batch_wave

    closed: list[bool] = []

    class _Plan:
        total_worker_grant = 1
        max_parallel_jobs = 1
        reason = "constructor-error"

    class _Lease:
        def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(
        "app.core.mixed_nesting_service.plan_batch_hardware",
        lambda _count: _Plan(),
    )
    monkeypatch.setattr(
        "app.core.mixed_nesting_service.register_shared_batch_worker_grants",
        lambda _grant: _Lease(),
    )

    def _constructor_error(*_args, **_kwargs):
        raise RuntimeError("executor-constructor-boom")

    monkeypatch.setattr(
        "concurrent.futures.ThreadPoolExecutor",
        _constructor_error,
    )
    with pytest.raises(RuntimeError, match="executor-constructor-boom"):
        run_step_repeat_batch_wave(
            [object()],
            cancel_event=None,
            progress_callback=None,
            runner=lambda *_args, **_kwargs: None,
        )
    assert closed == [True]


def test_singleflight_follower_khong_claim_worker_grant(monkeypatch):
    """Chỉ owner solve giữ quota; follower cùng identity chỉ chờ session."""

    import threading

    from app.core import nesting_preview_session as preview_session
    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator

    monkeypatch.setattr(preview_session, "job_identity_key", lambda _job: ("same",))
    coordinator = SharedBatchWorkerGrantCoordinator()
    owner_lease = coordinator.register(1)
    follower_lease = coordinator.register(1)
    owner_request = owner_lease.request(1)
    follower_request = follower_lease.request(1)
    owner_entered = threading.Event()
    release_owner = threading.Event()
    solve_calls = 0

    def _solver(_job, *, runtime_worker_grant_request, cancel_event, **_kwargs):
        nonlocal solve_calls
        solve_calls += 1
        with runtime_worker_grant_request.claim(cancel_event.is_set):
            owner_entered.set()
            assert release_owner.wait(timeout=5.0)
        return SimpleNamespace(solved=SimpleNamespace(manifest={"stats": {}}))

    store = preview_session.NestingPreviewSessionStore(capacity=2, solver=_solver)
    results: list[object] = []

    def _lookup(subscriber: str, request) -> None:
        results.append(
            store.get_or_solve(
                object(),
                subscriber_id=subscriber,
                runtime_worker_grant_request=request,
            )
        )

    owner_thread = threading.Thread(
        target=_lookup,
        args=("owner", owner_request),
    )
    owner_thread.start()
    assert owner_entered.wait(timeout=5.0)
    follower_thread = threading.Thread(
        target=_lookup,
        args=("follower", follower_request),
    )
    follower_thread.start()

    # Nếu follower claim trước khi chờ owner, coordinator sẽ có một waiter treo.
    follower_thread.join(timeout=0.1)
    assert follower_thread.is_alive()
    assert coordinator.snapshot()["held"] == 1
    assert coordinator.snapshot()["waiters"] == 0

    release_owner.set()
    owner_thread.join(timeout=5.0)
    follower_thread.join(timeout=5.0)
    assert not owner_thread.is_alive() and not follower_thread.is_alive()
    assert solve_calls == 1
    assert len(results) == 2
    assert sorted(result.reused for result in results) == [False, True]

    # Vé follower chưa từng bị claim; vẫn dùng được đúng một lần ở đây.
    with follower_request.claim() as grant:
        assert grant == 1
    owner_lease.close()
    follower_lease.close()
    assert coordinator.snapshot()["batches"] == 0


@requires_real_source
def test_pipeline_claim_worker_grant_va_truyen_dung_xuong_native():
    """Wiring thật: pipeline claim vé rồi native nhận đúng grant đã được cấp."""

    from app.core import nesting_production_pipeline as pipeline
    from app.core.mixed_nesting_service import SharedBatchWorkerGrantCoordinator
    from app.core.nesting_source_pin import discard_source_pin

    coordinator = SharedBatchWorkerGrantCoordinator()
    lease = coordinator.register(1)
    session = None
    try:
        session = pipeline.solve_production_nesting_job(
            _job_for(_request(parts=1)),
            runtime_worker_grant_request=lease.request(1),
        )
        runtime = session.solved.runtime_diagnostics.get("runtimeControl") or {}
        assert runtime.get("workerGrant") == 1
        assert runtime.get("maxConcurrentComputeWorkers") == 1
        assert coordinator.snapshot()["held"] == 0
    finally:
        if session is not None:
            for pin in session.source_pins:
                discard_source_pin(pin)
        lease.close()
    assert coordinator.snapshot()["batches"] == 0

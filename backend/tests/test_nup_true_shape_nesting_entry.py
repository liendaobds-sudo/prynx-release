"""Cổng vào Nesting tối ưu theo đường bế từ đường chạy N-Up thật.

NEST (audit 2026-08-28 §A4b-4). Trước lô này `nesting_production_pipeline` không
có caller production nào. Test ở đây khoá **đoạn nối**, không khoá lại thuật toán
(pipeline đã có test riêng ở `test_nesting_production_pipeline.py` và
`test_nesting_cnc_pipeline.py`).

Ba nhóm bất biến:

1. **Định tuyến**: `_run_nup_engine_impl` phải rẽ sang nesting khi
   `gridStrategy == 'true_shape_nesting'`, và rẽ TRƯỚC nhánh CNC — nếu không, job
   CNC sẽ rơi vào `run_cnc_two_sided` và người dùng nhận lưới grid.
2. **Dịch hợp đồng**: `settings` camelCase/mm → `ProductionNestingJobInput`.
3. **Fail-closed**: mọi nhánh không chạy được phải ném lỗi tiếng Việt, TUYỆT ĐỐI
   không âm thầm rơi về lưới grid. Rơi về lưới là kiểu sai tệ nhất ở đây: người
   dùng nhận một tờ bình khác hẳn kỳ vọng mà không có dấu hiệu nào.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pikepdf
import pytest

from app.workers.imposition_pdf_form import PT_PER_MM
from app.workers.nup_true_shape_nesting import (
    MAX_SHEETS_CEILING,
    TRUE_SHAPE_NESTING_STRATEGY,
    build_true_shape_nesting_job,
    build_true_shape_nesting_jobs,
    is_true_shape_nesting_requested,
)

DIE_MM = 40.0
HOLE_LO_MM = 14.0
HOLE_HI_MM = 26.0


def _make_die_source(path: Path) -> None:
    """Khuôn vuông có cửa sổ, vẽ bằng spot CutContour — nét thật để bộ dò trích."""

    size = DIE_MM * PT_PER_MM
    lo = HOLE_LO_MM * PT_PER_MM
    hi = HOLE_HI_MM * PT_PER_MM
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(size, size))
    page = pdf.pages[0]
    outer = f"0 0 m {size} 0 l {size} {size} l 0 {size} l h "
    hole = f"{lo} {lo} m {lo} {hi} l {hi} {hi} l {hi} {lo} l h "
    page.contents_add(
        pikepdf.Stream(
            pdf,
            (
                f"q 0 0 0 rg 0 0 {size} {size} re f Q\n"
                f"q 0 1 0 0 K 0.5 w {outer}{hole}S Q\n"
            ).encode("ascii"),
        )
    )
    pdf.save(str(path))
    pdf.close()


def _settings(**overrides):
    """Thiết lập tối thiểu đúng như `processHandlers` gửi: camelCase, đơn vị mm."""

    base = {
        "gridStrategy": TRUE_SHAPE_NESTING_STRATEGY,
        "isDieCutMode": True,
        "sheetWidth": 320.0,
        "sheetHeight": 230.0,
        "gapX": 2.0,
        "gapY": 3.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "targetQuantitiesByPage": {"0": 6},
    }
    base.update(overrides)
    return base


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "khuon.pdf"
    _make_die_source(path)
    return path


# ── 1. Nhận diện yêu cầu ─────────────────────────────────────────────────────

def test_nhan_dien_dung_gridstrategy():
    assert is_true_shape_nesting_requested({"gridStrategy": "true_shape_nesting"})
    assert is_true_shape_nesting_requested({"gridStrategy": " true_shape_nesting "})


@pytest.mark.parametrize(
    "strategy",
    ["optimal_auto", "simple_auto", "manual", "", None, "TRUE_SHAPE_NESTING"],
)
def test_khong_nhan_dien_cac_strategy_khac(strategy):
    """Chỉ đúng chuỗi mới kích hoạt — không phân biệt hoa/thường sẽ mở quá rộng."""

    assert not is_true_shape_nesting_requested({"gridStrategy": strategy})


def test_settings_khong_co_gridstrategy_thi_khong_kich_hoat():
    assert not is_true_shape_nesting_requested({})


# ── 2. Dịch hợp đồng settings → job ──────────────────────────────────────────

def test_dich_settings_sang_job_tem_be(source: Path):
    job = build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345")

    assert job.tool == "sticker_imposer"
    assert job.layout_intent == "quantity_fulfillment"
    assert job.sheet_width_mm == 320.0
    assert job.sheet_height_mm == 230.0
    # gapX/gapY vào clearance theo HAI trục, không nén về một số vô hướng.
    assert (job.part_gap.x_mm, job.part_gap.y_mm) == (2.0, 3.0)
    assert job.margin_mm == {"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0}

    assert len(job.parts) == 1
    part = job.parts[0]
    assert part.page_index == 0
    assert part.quantity == 6
    assert part.detected_shape is not None, (
        "lane Tem bế phải giữ DetectedShape.trim làm SSOT kích thước report"
    )
    assert part.detected_shape.page == 0
    assert part.detected_shape.trim.w / PT_PER_MM == pytest.approx(DIE_MM, abs=0.1)
    assert part.detected_shape.trim.h / PT_PER_MM == pytest.approx(DIE_MM, abs=0.1)


@pytest.mark.parametrize("flip_edge", ["long", "short"])
def test_cnc_duplex_dau_canh_vao_job_vat_can_va_identity(
    source: Path,
    monkeypatch,
    flip_edge: str,
):
    """MAP-NEST-08: dấu canh là contract layout thật, không chỉ là nét writer vẽ."""

    def detected_shape(page_index: int) -> SimpleNamespace:
        contour = SimpleNamespace(
            page_index=page_index,
            outer_top_down_user_units=(
                (0.0, 0.0),
                (40.0, 0.0),
                (40.0, 40.0),
                (0.0, 40.0),
            ),
            holes_top_down_user_units=(),
        )
        return SimpleNamespace(page=page_index, page_contour=contour)

    shapes = {0: detected_shape(0), 1: detected_shape(1)}
    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting._detect_shapes_for_nesting",
        lambda _source_path: shapes,
    )

    settings = _settings(
        imposerMode="cnc",
        cncTwoSided=True,
        cncFlipEdge=flip_edge,
        cncDuplexMarks=True,
    )
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")

    assert job.duplex_mode == "duplex"
    assert job.flip_edge == flip_edge
    assert job.duplex_registration is True
    assert job.parts[0].back_page_index == 1
    assert {
        obstacle["obstacleId"]
        for obstacle in job.fixed_obstacles
        if str(obstacle.get("obstacleId", "")).startswith("duplex-registration-")
    } == {
        "duplex-registration-bottom",
        "duplex-registration-top",
        "duplex-registration-left",
        "duplex-registration-right",
    }

    without_marks = build_true_shape_nesting_job(
        str(source),
        {**settings, "cncDuplexMarks": False},
        job_id="abc12345",
    )
    from app.core.nesting_preview_session import job_identity_key

    assert without_marks.duplex_registration is False
    assert job_identity_key(job) != job_identity_key(without_marks)

    simplex = build_true_shape_nesting_job(
        str(source),
        {**settings, "cncTwoSided": False},
        job_id="abc12345",
    )
    assert simplex.duplex_mode == "simplex"
    assert simplex.flip_edge == "none"
    assert simplex.duplex_registration is False
    assert not any(
        str(obstacle.get("obstacleId", "")).startswith("duplex-registration-")
        for obstacle in simplex.fixed_obstacles
    )


def test_report_nup_khong_duplicate_demand_va_co_fallback_mot_trang(source: Path):
    """N-up lấy demand từ engine part; report chỉ materialize fallback có provenance."""

    job = build_true_shape_nesting_job(
        str(source),
        _settings(
            reportDisplay={
                "enabled": True,
                "fieldOrder": ["labelName", "actualQty", "sheetCount"],
            }
        ),
        job_id="abc12345",
    )

    assert job.parts[0].quantity == 6
    assert job.artifact_options.report.requested_qty is None
    assert job.artifact_options.report.label_name == "Trang 1"


def test_manifest_id_dung_dinh_dang_kho_va_rieng_tung_publication(source: Path):
    """Cùng cache identity vẫn phải có ID publication immutable riêng."""

    from app.core.nesting_manifest_store import validate_manifest_id
    from app.core.nesting_preview_session import job_identity_key

    first = build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345")
    second = build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345")

    assert validate_manifest_id(first.manifest_id) == first.manifest_id
    assert validate_manifest_id(second.manifest_id) == second.manifest_id
    assert first.manifest_id != second.manifest_id
    assert job_identity_key(first) == job_identity_key(second)


def test_manifest_id_doi_khi_job_doi(source: Path):
    """Đổi khổ tờ làm đổi cả cache identity, ngoài ID publication riêng."""

    from app.core.nesting_preview_session import job_identity_key

    first = build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345")
    second = build_true_shape_nesting_job(
        str(source), _settings(sheetWidth=450.0), job_id="abc12345"
    )

    assert first.manifest_id != second.manifest_id
    assert job_identity_key(first) != job_identity_key(second)


def test_nhieu_trang_thanh_nhieu_mau(source: Path):
    job = build_true_shape_nesting_job(
        str(source),
        _settings(targetQuantitiesByPage={"0": 4, "2": 7}),
        job_id="abc12345",
    )

    assert [part.page_index for part in job.parts] == [0, 2]
    assert [part.quantity for part in job.parts] == [4, 7]
    assert len({part.part_id for part in job.parts}) == 2, "part_id phải phân biệt"


def test_trang_so_luong_0_bi_loai(source: Path):
    """SL 0 nghĩa là không in trang đó — không được thành mẫu quantity 0."""

    job = build_true_shape_nesting_job(
        str(source),
        _settings(targetQuantitiesByPage={"0": 5, "1": 0}),
        job_id="abc12345",
    )

    assert [part.page_index for part in job.parts] == [0]


def test_khong_khai_so_luong_thi_lap_day_mot_to(source: Path):
    job = build_true_shape_nesting_job(
        str(source), _settings(targetQuantitiesByPage={}), job_id="abc12345"
    )

    assert job.layout_intent == "autofill_single_sheet"
    assert job.max_sheets == 1
    assert job.parts[0].quantity is None


def test_max_sheets_co_tran(source: Path):
    """Trần số tờ chặn solver quay vô hạn khi mẫu không thể vừa tờ."""

    job = build_true_shape_nesting_job(
        str(source),
        _settings(targetQuantitiesByPage={"0": 10_000}),
        job_id="abc12345",
    )

    assert job.max_sheets == MAX_SHEETS_CEILING


def test_job_dung_duoc_pipeline_validator(source: Path):
    """Job dịch ra phải qua validator của pipeline, không chỉ đúng kiểu."""

    from app.core.nesting_production_pipeline import _validate

    _validate(build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345"))
    _validate(
        build_true_shape_nesting_job(
            str(source), _settings(targetQuantitiesByPage={}), job_id="abc12345"
        )
    )


# ── 3. Fail-closed ───────────────────────────────────────────────────────────

def test_cong_cu_ngoai_pham_vi_bi_chan(source: Path):
    """Bình cắt xén/nup không có đường bế ⇒ không thể xếp theo đường bế."""

    with pytest.raises(ValueError, match="Bình tem bế"):
        build_true_shape_nesting_job(
            str(source), _settings(isDieCutMode=False), job_id="abc12345"
        )


def test_step_repeat_token_duoc_phep(source: Path):
    """§B10: S&R tem ĐẶC BIỆT (token/route CUSTOM) NAY được true-shape.

    Trước bị chặn cứng vì kernel kém tiler named ở S&R; nhưng với CUSTOM không có tiler
    chuyên biệt nào để thua — true-shape thắng lưới bbox (số B8). `_settings` dùng token
    (`true_shape_nesting`) nên `_guard_scope` cho qua qua `wants_true_shape_nesting`.
    """

    # Không ném — job S&R đặc biệt dựng được.
    build_true_shape_nesting_job(
        str(source), _settings(taskMode="step_repeat"), job_id="abc12345"
    )


def test_step_repeat_named_van_bi_chan(source: Path):
    """S&R hình CÓ TÊN (không token, không auto-route) vẫn chặn — giữ tiler chuyên biệt.

    Không cờ ⇒ route_true_shape False; gridStrategy=optimal_auto ⇒ không token ⇒
    wants_true_shape_nesting False ⇒ `_guard_scope` chặn S&R như cũ.
    """

    with pytest.raises(ValueError, match="S&R"):
        build_true_shape_nesting_job(
            str(source),
            _settings(
                taskMode="step_repeat",
                gridStrategy="optimal_auto",
                detectedShapesByPage={"0": "TRIANGLE"},
            ),
            job_id="abc12345",
        )


def test_page_sheet_mode_bi_chan(source: Path):
    with pytest.raises(ValueError, match="nguyên tấm"):
        build_true_shape_nesting_job(
            str(source), _settings(page_sheet_mode=True), job_id="abc12345"
        )


def test_mixed_guillotine_bi_chan(source: Path):
    with pytest.raises(ValueError, match="nhiều kích thước"):
        build_true_shape_nesting_job(
            str(source),
            _settings(isDieCutMode=False, layoutType="mixed_guillotine"),
            job_id="abc12345",
        )


@pytest.mark.parametrize("field", ["sheetWidth", "sheetHeight"])
@pytest.mark.parametrize("bad", [0, -5.0, None, "abc"])
def test_kho_to_khong_hop_le_bi_chan(source: Path, field, bad):
    with pytest.raises(ValueError):
        build_true_shape_nesting_job(
            str(source), _settings(**{field: bad}), job_id="abc12345"
        )


def test_khoang_ho_am_bi_chan(source: Path):
    with pytest.raises(ValueError, match="không được âm"):
        build_true_shape_nesting_job(
            str(source), _settings(gapX=-1.0), job_id="abc12345"
        )


def test_so_luong_am_bi_chan(source: Path):
    with pytest.raises(ValueError, match="không được âm"):
        build_true_shape_nesting_job(
            str(source),
            _settings(targetQuantitiesByPage={"0": -3}),
            job_id="abc12345",
        )


def test_co_tat_thi_bao_loi_chu_khong_am_tham_ve_luoi(source: Path, monkeypatch):
    """Bất biến quan trọng nhất của lô.

    Khi cờ rollout tắt, hàm chạy phải NÉM LỖI. Nếu nó lặng lẽ rơi về lưới grid,
    người dùng đã chọn nesting sẽ nhận một tờ bình khác hẳn mà không biết.
    """

    from app.workers import nup_true_shape_nesting as module

    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda: False
    )

    with pytest.raises(ValueError, match="chưa được mở"):
        module.run_true_shape_nesting(
            str(source), str(source.parent / "out.pdf"), _settings(), "abc12345"
        )


# ── 4. Định tuyến trong engine ───────────────────────────────────────────────

def test_engine_re_sang_nesting_truoc_nhanh_cnc(source: Path, monkeypatch, tmp_path):
    """Job CNC + nesting phải vào nesting, KHÔNG vào `run_cnc_two_sided`.

    Thứ tự hai nhánh trong `_run_nup_engine_impl` là bất biến: nếu nhánh CNC đứng
    trước, mọi job CNC chọn nesting sẽ âm thầm nhận lưới grid.
    """

    from app.workers import nup_engine

    called: dict[str, object] = {}

    def _fake_nesting(src, out, settings, job_id=None, progress_callback=None):
        called["nesting"] = True
        return "report-nesting"

    def _fake_cnc(src, out, settings, job_id=None, progress_callback=None):
        called["cnc"] = True
        return "report-cnc"

    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting.run_true_shape_nesting", _fake_nesting
    )
    monkeypatch.setattr("app.workers.cnc_render.run_cnc_two_sided", _fake_cnc)

    report = nup_engine._run_nup_engine_impl(
        str(source),
        str(tmp_path / "ket-qua.pdf"),
        _settings(imposerMode="cnc"),
        job_id="abc12345",
    )

    assert report == "report-nesting"
    assert called == {"nesting": True}, "không được gọi renderer CNC"


def test_engine_khong_re_khi_strategy_khac(source: Path, monkeypatch, tmp_path):
    """Strategy khác phải đi đúng nhánh cũ — nhánh mới không được cướp job."""

    from app.workers import nup_engine

    called: dict[str, object] = {}

    def _fake_nesting(src, out, settings, job_id=None, progress_callback=None):
        called["nesting"] = True
        return "report-nesting"

    def _fake_cnc(src, out, settings, job_id=None, progress_callback=None):
        called["cnc"] = True
        return "report-cnc"

    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting.run_true_shape_nesting", _fake_nesting
    )
    monkeypatch.setattr("app.workers.cnc_render.run_cnc_two_sided", _fake_cnc)

    report = nup_engine._run_nup_engine_impl(
        str(source),
        str(tmp_path / "ket-qua.pdf"),
        _settings(gridStrategy="optimal_auto", imposerMode="cnc"),
        job_id="abc12345",
    )

    assert report == "report-cnc"
    assert called == {"cnc": True}


# ── 5. Chạy thật end-to-end ──────────────────────────────────────────────────

@pytest.fixture
def _flag_on(monkeypatch, tmp_path):
    """Bật cờ tường minh và trỏ kho manifest sang thư mục tạm.

    Không trỏ lại kho thì mỗi lượt test commit manifest vào artifact root DÙNG
    CHUNG (`mixed_nesting_data/manifests` cạnh RESULTS_DIR) — đã đo thấy 5 file rác
    sinh ra trước khi thêm fixture này.
    """

    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda: True
    )
    monkeypatch.setenv(
        "PRYNX_MIXED_NESTING_DATA_DIR", str(tmp_path / "artifact-root")
    )


def test_chay_that_ra_artifact_va_report(source: Path, tmp_path, _flag_on):
    """Đường chạy thật: settings của UI → PDF trên đĩa + report cho ô kết quả.

    Đây là ca quyết định của lô. Mọi test phía trên đều dựng job hoặc dùng fake;
    ca này gọi pipeline thật để chắc đoạn nối chạy được, không chỉ đúng kiểu.
    """

    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    output = tmp_path / "ket-qua.pdf"
    report = run_true_shape_nesting(
        str(source), str(output), _settings(), "abc12345"
    )

    assert output.is_file(), "phải ghi được artifact"
    with pikepdf.Pdf.open(str(output)) as pdf:
        assert len(pdf.pages) >= 2, "ít nhất một tờ với hai mặt front + cut"

    assert "Nesting tối ưu theo đường bế" in report
    assert "Đủ số lượng đặt" in report
    assert "Số tờ cần in" in report


def test_report_tem_be_dung_trim_detector_khong_do_lai_bbox_contour(
    tmp_path: Path,
    _flag_on,
    _clean_session_store,
    monkeypatch,
):
    """Regression runtime 45,3×52,3: Tem bế phải đi cùng SSOT với viewer.

    PDF có contour thật 45,4×52,9mm, còn detector (nguồn viewer) trả trim
    45,3×52,3mm. Test chạy xuyên entrypoint ``run_true_shape_nesting`` và bắt
    chính chuỗi được giao cho hàm đóng report trên artifact.
    """

    from dataclasses import replace

    from app.workers import nup_report
    from app.workers import nup_true_shape_nesting as true_shape
    from app.workers.die_detection import Trim

    source = tmp_path / "tem-lech-kich-thuoc.pdf"
    page_w = 70.0 * PT_PER_MM
    page_h = 80.0 * PT_PER_MM
    x0 = 10.0 * PT_PER_MM
    y0 = 10.0 * PT_PER_MM
    contour_w = 45.4 * PT_PER_MM
    contour_h = 52.9 * PT_PER_MM
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(page_w, page_h))
    page = pdf.pages[0]
    page.contents_add(
        pikepdf.Stream(
            pdf,
            (
                f"q 0 0 0 rg 0 0 {page_w} {page_h} re f Q\n"
                f"q 0 1 0 0 K 0.5 w "
                f"{x0} {y0} m {x0 + contour_w} {y0} l "
                f"{x0 + contour_w} {y0 + contour_h} l "
                f"{x0} {y0 + contour_h} l h S Q\n"
            ).encode("ascii"),
        )
    )
    pdf.save(str(source))
    pdf.close()

    detect_original = true_shape._detect_shapes_for_nesting

    def detect_with_viewer_trim(source_path: str):
        shapes = detect_original(source_path)
        return {
            page_index: replace(
                shape,
                trim=Trim(45.3 * PT_PER_MM, 52.3 * PT_PER_MM),
            )
            for page_index, shape in shapes.items()
        }

    monkeypatch.setattr(
        true_shape,
        "_detect_shapes_for_nesting",
        detect_with_viewer_trim,
    )
    captured: dict[int, str] = {}

    def capture_report(_input, _output, reports_by_page, **_kwargs):
        captured.update(reports_by_page)
        return True

    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", capture_report)
    output = tmp_path / "ket-qua-tem.pdf"
    true_shape.run_true_shape_nesting(
        str(source),
        str(output),
        _settings(
            targetQuantitiesByPage={"0": 1},
            reportDisplay={
                "enabled": True,
                "fieldOrder": ["dimensions"],
            },
        ),
        "dimsticker01",
    )

    assert output.is_file()
    assert captured == {0: "45.3 x 52.3 mm"}


def test_chay_that_lap_day_mot_to(source: Path, tmp_path, _flag_on):
    """Không khai SL ⇒ lấp đầy đúng một tờ, report ghi rõ chế độ."""

    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    output = tmp_path / "mot-to.pdf"
    report = run_true_shape_nesting(
        str(source),
        str(output),
        _settings(targetQuantitiesByPage={}),
        "def67890",
    )

    assert output.is_file()
    assert "Lấp đầy một tờ" in report


def test_chay_that_qua_engine_dung_duong_chay_that(source: Path, tmp_path, _flag_on):
    """Đi qua `_run_nup_engine_impl` chứ không gọi module trực tiếp.

    Khoá cả đoạn nối trong engine, không chỉ bản thân module — đây là hàm mà
    `_spawn_nup_process` gọi thật.
    """

    from app.workers import nup_engine

    output = tmp_path / "qua-engine.pdf"
    report = nup_engine._run_nup_engine_impl(
        str(source), str(output), _settings(), job_id="abc12345"
    )

    assert output.is_file()
    assert "Nesting tối ưu theo đường bế" in report


def test_chay_that_cnc_dung_khuon_da_do(source: Path, tmp_path, _flag_on):
    """Lane CNC: shape dò server-side một lượt rồi truyền object vào pipeline."""

    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    output = tmp_path / "cnc.pdf"
    report = run_true_shape_nesting(
        str(source),
        str(output),
        _settings(imposerMode="cnc"),
        "cnc00001",
    )

    assert output.is_file()
    assert "Nesting tối ưu theo đường bế" in report


def test_lo_khuon_toi_duoc_lop_cut_qua_duong_chay_that(source: Path, tmp_path, _flag_on):
    """Cửa sổ của khuôn phải thành nét dao trên trang CUT của artifact.

    Nối lại chuỗi §A4b-2/§A4b-3 với đường chạy production: nếu đoạn nối này làm
    mất lỗ thì hai lô kia vô nghĩa với người dùng.
    """

    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    output = tmp_path / "co-lo.pdf"
    run_true_shape_nesting(str(source), str(output), _settings(), "abc12345")

    with pikepdf.Pdf.open(str(output)) as pdf:
        cut_page = pdf.pages[1]
        contents = cut_page.obj.get("/Contents")
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        raw = b"".join(stream.read_bytes() for stream in streams)
    cut_stream = raw.decode("latin-1")

    rings = cut_stream.count(" m\n")
    assert rings > 0 and rings % 2 == 0, (
        f"trang CUT phải có số vòng chẵn (biên ngoài + cửa sổ mỗi con), đếm được {rings}"
    )


# ── 6. Preview ≡ output: một lượt solve dùng cho cả hai (§A4b-5) ─────────────

@pytest.fixture
def _clean_session_store():
    """Kho phiên là state cấp process — phải dọn quanh mỗi test dùng nó."""

    from app.core.nesting_preview_session import reset_preview_session_store

    reset_preview_session_store()
    yield
    reset_preview_session_store()


def _count_real_solves(monkeypatch):
    """Đếm số lượt solve THẬT của pipeline, không đếm lượt tra kho."""

    from app.core import nesting_production_pipeline as pipeline

    original = pipeline.solve_production_nesting_job
    calls: list[int] = []

    def _counting(job, **kwargs):
        calls.append(1)
        return original(job, **kwargs)

    monkeypatch.setattr(pipeline, "solve_production_nesting_job", _counting)
    return calls


def test_preview_roi_export_chi_solve_mot_lan(
    source: Path, tmp_path, _flag_on, _clean_session_store, monkeypatch
):
    """Ca quyết định của phương án (c).

    Preview hỏi số trước, export bình sau. Nếu solve hai lần thì hai bên cho hai
    `layoutFingerprint` khác nhau (mỗi `pin_pdf_path` sinh locator mới), tức con số
    trên UI khác tờ bình thật — đúng lỗi A4b-4a cần đóng.
    """

    from app.core.nesting_preview_session import (
        get_preview_session_store,
        session_capacity,
    )
    from app.workers.nup_true_shape_nesting import (
        build_true_shape_nesting_job,
        run_true_shape_nesting,
    )

    calls = _count_real_solves(monkeypatch)
    settings = _settings()

    # (1) Preview: lấy số cho cột "Tem/tờ", chưa ghi file nào.
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")
    preview = get_preview_session_store().get_or_solve(job)
    preview_capacity = session_capacity(preview.session)

    assert len(calls) == 1
    assert preview.reused is False
    assert preview_capacity > 0

    # (2) Export: cùng thiết lập ⇒ phải dùng lại phiên, KHÔNG solve lại.
    output = tmp_path / "ket-qua.pdf"
    report = run_true_shape_nesting(str(source), str(output), settings, "abc12345")

    assert len(calls) == 1, "export không được solve lại"
    assert output.is_file()

    # (3) Con số preview phải khớp con số trong report của tờ bình.
    assert f"{preview_capacity} con" in report


def test_doi_thiet_lap_thi_solve_lai(
    source: Path, tmp_path, _flag_on, _clean_session_store, monkeypatch
):
    """Đổi khổ tờ là bài toán khác — phải solve lại, không phục vụ layout cũ."""

    from app.core.nesting_preview_session import get_preview_session_store
    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    calls = _count_real_solves(monkeypatch)
    store = get_preview_session_store()

    store.get_or_solve(
        build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345")
    )
    store.get_or_solve(
        build_true_shape_nesting_job(
            str(source), _settings(sheetWidth=450.0), job_id="abc12345"
        )
    )

    assert len(calls) == 2


def test_export_hai_lan_cho_artifact_giong_nhau(
    source: Path, tmp_path, _flag_on, _clean_session_store, monkeypatch
):
    """Bình hai lần cùng thiết lập ⇒ hai file giống nhau tới byte, một lượt solve.

    Đây là điều `run_production_nesting_job` KHÔNG cho được: nó solve lại mỗi lượt
    nên hai file khác `layoutFingerprint`.
    """

    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    calls = _count_real_solves(monkeypatch)
    settings = _settings()

    first = tmp_path / "lan-1.pdf"
    second = tmp_path / "lan-2.pdf"
    run_true_shape_nesting(str(source), str(first), settings, "abc12345")
    run_true_shape_nesting(str(source), str(second), settings, "abc12345")

    assert len(calls) == 1, "lượt bình thứ hai phải dùng lại phiên"

    def _page_bytes(path: Path) -> list[bytes]:
        pages: list[bytes] = []
        with pikepdf.Pdf.open(str(path)) as pdf:
            for page in pdf.pages:
                contents = page.obj.get("/Contents")
                streams = (
                    contents if isinstance(contents, pikepdf.Array) else [contents]
                )
                pages.append(b"".join(stream.read_bytes() for stream in streams))
        return pages

    left = _page_bytes(first)
    right = _page_bytes(second)
    assert len(left) == len(right)
    for index, (one, two) in enumerate(zip(left, right)):
        assert one == two, f"trang {index} lệch giữa hai lượt bình"


# ── 7. Ghi tiến trình — hết "0/0" (§NEST-PROGRESS) ───────────────────────────

def test_ghi_tien_trinh_ra_dung_file_ma_status_doc(tmp_path, monkeypatch):
    """UI đọc `nup_prog_<job_id>.txt`; nhánh nesting trước đây không ghi gì.

    Người dùng thấy "Đang bình trang: 0/0..." bất động cả phút và không biết job còn
    sống hay đã treo. Test khoá cả mốc khởi tạo lẫn cập nhật theo snapshot.
    """

    import tempfile

    from app.workers.nup_true_shape_nesting import _progress_writer

    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))

    writer = _progress_writer("prog0001", total_quantity=40)
    path = tmp_path / "nup_prog_prog0001.txt"

    # Mốc đầu ghi ngay, trước cả snapshot đầu tiên.
    assert path.read_text(encoding="utf-8") == "0/40"

    writer({"progress": 0.25})
    assert path.read_text(encoding="utf-8") == "10/40"

    writer({"progress": 1.0})
    assert path.read_text(encoding="utf-8") == "40/40"


def test_tien_trinh_khong_ghi_lai_khi_so_khong_doi(tmp_path, monkeypatch):
    """Snapshot tới 10 lần/giây; chỉ ghi đĩa khi con số thật sự đổi."""

    import tempfile

    from app.workers.nup_true_shape_nesting import _progress_writer

    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    writer = _progress_writer("prog0002", total_quantity=10)
    path = tmp_path / "nup_prog_prog0002.txt"

    writer({"progress": 0.31})
    first_mtime = path.stat().st_mtime_ns
    for _ in range(5):
        writer({"progress": 0.34})  # vẫn làm tròn về 3/10
    assert path.stat().st_mtime_ns == first_mtime


@pytest.mark.parametrize(
    "snapshot", [{}, {"progress": None}, {"progress": "x"}, {"progress": -1.0}, {"progress": 9.0}]
)
def test_tien_trinh_chiu_duoc_snapshot_rac(tmp_path, monkeypatch, snapshot):
    """Snapshot méo không được làm hỏng lượt bình."""

    import tempfile

    from app.workers.nup_true_shape_nesting import _progress_writer

    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    writer = _progress_writer("prog0003", total_quantity=8)
    writer(snapshot)

    content = (tmp_path / "nup_prog_prog0003.txt").read_text(encoding="utf-8")
    done, _, total = content.partition("/")
    assert total == "8"
    assert 0 <= int(done) <= 8


def test_khong_co_job_id_thi_khong_ghi_gi():
    """Caller nội bộ không có job_id (test, preview) không được sinh file rác."""

    from app.workers.nup_true_shape_nesting import _progress_writer

    assert _progress_writer(None, total_quantity=5) is None


# ── 8. Mặc định phải BỊ CHẶN thời gian (§NEST-DEFAULTS) ──────────────────────

def test_mac_dinh_luon_co_tran_thoi_gian(source: Path, monkeypatch):
    """Budget chỉ giảm cho S&R máy yếu; máy mạnh và N-up giữ full."""

    from app.core import system_memory
    from app.workers.nup_true_shape_nesting import (
        AUTOFILL_TIME_BUDGET_MS,
        DEFAULT_TIME_BUDGET_MS,
        build_true_shape_nesting_job,
        build_true_shape_nesting_jobs,
    )

    monkeypatch.delenv("PRYNX_NEST_AUTOFILL_SEARCH_MS", raising=False)
    monkeypatch.setattr(
        system_memory,
        "read_memory_status_mb",
        lambda: (32 * 1024.0, 24 * 1024.0),
    )

    # Quantity và N-up autofill luôn giữ search đầy đủ, bất kể đây là máy mạnh.
    job_q = build_true_shape_nesting_job(str(source), _settings(), job_id="abc12345")
    job_a = build_true_shape_nesting_job(
        str(source), _settings(targetQuantitiesByPage={}), job_id="abc12345"
    )
    assert job_q.time_budget_ms == DEFAULT_TIME_BUDGET_MS
    assert job_a.time_budget_ms == DEFAULT_TIME_BUDGET_MS
    assert job_q.profile == job_a.profile == "fast"

    high_ram_sr = build_true_shape_nesting_jobs(
        str(source),
        _settings(taskMode="step_repeat", targetQuantitiesByPage={}),
        job_id="abc12345",
    )[0]
    assert high_ram_sr.layout_intent == "step_repeat_single_sheet"
    assert high_ram_sr.time_budget_ms == DEFAULT_TIME_BUDGET_MS

    # Chỉ máy dưới 16 GB mới dùng ngân sách đã đo rút gọn.
    monkeypatch.setattr(
        system_memory,
        "read_memory_status_mb",
        lambda: (12 * 1024.0, 8 * 1024.0),
    )
    low_ram_sr = build_true_shape_nesting_jobs(
        str(source),
        _settings(taskMode="step_repeat", targetQuantitiesByPage={}),
        job_id="abc12345",
    )[0]
    assert low_ram_sr.time_budget_ms == AUTOFILL_TIME_BUDGET_MS

    # Không đọc được RAM phải fail-open về full; env tường minh vẫn thắng auto.
    monkeypatch.setattr(system_memory, "read_memory_status_mb", lambda: (None, None))
    unknown_ram_sr = build_true_shape_nesting_jobs(
        str(source),
        _settings(taskMode="step_repeat", targetQuantitiesByPage={}),
        job_id="abc12345",
    )[0]
    assert unknown_ram_sr.time_budget_ms == DEFAULT_TIME_BUDGET_MS
    monkeypatch.setenv("PRYNX_NEST_AUTOFILL_SEARCH_MS", "777")
    forced_sr = build_true_shape_nesting_jobs(
        str(source),
        _settings(taskMode="step_repeat", targetQuantitiesByPage={}),
        job_id="abc12345",
    )[0]
    assert forced_sr.time_budget_ms == 777

    for job in (job_q, job_a, high_ram_sr, low_ram_sr, unknown_ram_sr, forced_sr):
        assert job.time_budget_ms is not None
        assert 0 < job.time_budget_ms <= 10_000

# ── §B10-4: build_true_shape_nesting_jobs — S&R mỗi mẫu một job ──────────────
def test_jobs_nup_tra_mot_job_gang(source: Path):
    """Dàn nhiều mẫu (nup) ⇒ ĐÚNG MỘT job gang, mọi mẫu chung tờ (như cũ)."""

    jobs = build_true_shape_nesting_jobs(
        str(source),
        _settings(
            taskMode="nup",
            targetQuantitiesByPage={"0": 6, "1": 4},
        ),
    )
    assert len(jobs) == 1
    job = jobs[0]
    assert job.layout_intent == "quantity_fulfillment"
    assert {part.page_index for part in job.parts} == {0, 1}
    assert {part.quantity for part in job.parts} == {6, 4}


def test_jobs_nup_khop_singular(source: Path):
    """Nhánh nup: bản plural phải trả job GIỐNG HỆT bản singular (cùng một job gang)."""

    settings = _settings(taskMode="nup", targetQuantitiesByPage={"0": 3, "1": 5})
    plural = build_true_shape_nesting_jobs(str(source), settings)
    single = build_true_shape_nesting_job(str(source), settings)
    assert len(plural) == 1
    assert plural[0].layout_intent == single.layout_intent
    assert [p.page_index for p in plural[0].parts] == [p.page_index for p in single.parts]
    assert [p.quantity for p in plural[0].parts] == [p.quantity for p in single.parts]


def test_jobs_step_repeat_mot_job_moi_mau_autofill(source: Path):
    """S&R autofill (không khai SL): MỖI mẫu đã dò là MỘT job "lấp đầy một tờ"."""

    jobs = build_true_shape_nesting_jobs(
        str(source),
        _settings(
            taskMode="step_repeat",
            targetQuantitiesByPage={},
            detectedShapesByPage={"0": "CUSTOM", "1": "CUSTOM", "2": "CUSTOM"},
        ),
    )
    assert len(jobs) == 3
    for index, job in enumerate(jobs):
        assert job.layout_intent == "step_repeat_single_sheet"
        assert job.max_sheets == 1
        assert len(job.parts) == 1  # single-design: đúng một mẫu mỗi tờ
        assert job.parts[0].page_index == index
        assert job.parts[0].quantity is None
    # Mỗi job một manifest_id riêng ⇒ mỗi mẫu là một publication độc lập.
    assert len({job.manifest_id for job in jobs}) == 3


def test_jobs_step_repeat_ton_trong_trang_sl_duong(source: Path):
    """S&R có khai SL: chỉ mẫu SL>0 lên tờ; trang SL 0 bị loại; mỗi mẫu vẫn autofill."""

    jobs = build_true_shape_nesting_jobs(
        str(source),
        _settings(
            taskMode="step_repeat",
            targetQuantitiesByPage={"0": 6, "1": 0, "2": 3},
            reportDisplay={
                "enabled": True,
                "fieldOrder": ["labelName", "actualQty", "sheetCount"],
            },
        ),
    )
    assert [job.parts[0].page_index for job in jobs] == [0, 2]
    assert [job.artifact_options.report.requested_qty for job in jobs] == [6, 3]
    assert [job.artifact_options.report.label_name for job in jobs] == [
        "Trang 1",
        "Trang 3",
    ]
    for job in jobs:
        assert job.layout_intent == "step_repeat_single_sheet"
        assert job.parts[0].quantity is None  # demand không đi vào solver autofill


def test_jobs_step_repeat_mot_mau_van_mot_job(source: Path):
    """S&R một mẫu (mặc định) ⇒ một job — không hồi quy ca thường."""

    jobs = build_true_shape_nesting_jobs(str(source), _settings(taskMode="step_repeat"))
    assert len(jobs) == 1
    assert jobs[0].layout_intent == "step_repeat_single_sheet"
    assert jobs[0].parts[0].page_index == 0


# ── §B10-4: export S&R = solve+render từng mẫu rồi NỐI tờ ─────────────────────
def test_run_step_repeat_export_noi_n_to(monkeypatch, tmp_path):
    """3 mẫu ⇒ export nối 3 tờ (mỗi tờ front+cut = 2 trang ⇒ 6 trang); report gộp đúng."""

    from app.workers import nup_true_shape_nesting as nts

    designs = [0, 1, 2]
    placed = {0: 44, 1: 30, 2: 52}

    def _fake_jobs(source, settings, *, job_id=None):
        return [
            SimpleNamespace(
                sheet_width_mm=320.0,
                sheet_height_mm=230.0,
                layout_intent="step_repeat_single_sheet",
                artifact_options=SimpleNamespace(report=object()),
                parts=[
                    SimpleNamespace(
                        part_id=f"trang-{p + 1}",
                        page_index=p,
                        quantity=None,
                    )
                ],
            )
            for p in designs
        ]

    monkeypatch.setattr(nts, "build_true_shape_nesting_jobs", _fake_jobs)

    class _FakeStore:
        def get_or_solve(self, job, **_kwargs):
            page = job.parts[0].page_index
            session = SimpleNamespace(
                solved=SimpleNamespace(
                    manifest={"stats": {"placedCount": placed[page], "sheetCount": 1}}
                )
            )
            return SimpleNamespace(session=session, reused=False)

        @staticmethod
        def peek_quality_gate_proof(job):
            return {"designIndex": int(job.parts[0].page_index)}

    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store",
        lambda: _FakeStore(),
    )

    rendered_paths: list[str] = []

    def _fake_render(session, *, output_path, report_override=None):
        assert report_override is not None
        # Mỗi mẫu = một tờ 2 trang (front + CUT là trang riêng).
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(100, 100))
        pdf.add_blank_page(page_size=(100, 100))
        pdf.save(str(output_path))
        pdf.close()
        rendered_paths.append(str(output_path))
        return SimpleNamespace(page_count=2)

    monkeypatch.setattr(
        "app.core.nesting_production_pipeline.render_production_nesting_session",
        _fake_render,
    )
    monkeypatch.setattr(
        "app.core.nesting_production_pipeline.commit_production_nesting_session",
        lambda session, store=None: None,
    )

    # Trang 1 chọn lưới, hai trang sau chọn nesting. Kế hoạch legacy phải được
    # chuẩn hoá về đúng một tờ đại diện dù settings gốc có SL dương và toggle false;
    # SL gốc vẫn phải còn để snapshot report ghi đúng đơn hàng.
    def _khong_probe_lai(*_args, **_kwargs):
        raise AssertionError("proof S&R hợp lệ thì không được probe lưới lại")

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        _khong_probe_lai,
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.quality_gate_source_for_session",
        lambda _session, _job: {"source_path": "snapshot-khuon.pdf"},
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_session",
        lambda proof, _settings, _job, _session: SimpleNamespace(
            decision="grid" if proof["designIndex"] == 0 else "nesting",
            grid_capacity=60 if proof["designIndex"] == 0 else 1,
        ),
    )
    captured_legacy_settings = {}

    class _FakePlan:
        total_sheets = 1

        @staticmethod
        def source_page_for_sheet(sheet_index):
            assert sheet_index == 0
            return 0

    from contextlib import contextmanager
    from app.workers import nup_sheet_render

    @contextmanager
    def _fake_plan(_source, legacy_settings, *, job_id=None):
        captured_legacy_settings.update(legacy_settings)
        yield _FakePlan()

    def _fake_render_grid(
        _plan, _sheet_index, output_path, *, include_report=False
    ):
        assert include_report is True
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(100, 100))
        pdf.add_blank_page(page_size=(100, 100))
        pdf.save(str(output_path))
        pdf.close()
        rendered_paths.append(str(output_path))

    monkeypatch.setattr(nup_sheet_render, "nup_sheet_plan", _fake_plan)
    monkeypatch.setattr(nup_sheet_render, "render_nup_sheet", _fake_render_grid)

    monkeypatch.setenv("PRYNX_PERF", "1")
    from app.core import perf_sampler

    output = tmp_path / "sr-export.pdf"
    stages = perf_sampler.PerfStages()
    report = nts._run_step_repeat_export(
        "khuon.pdf",
        str(output),
        {
            "taskMode": "step_repeat",
            "layoutType": "repeat",
            "gridStrategy": "optimal_auto",
            "isDieCutMode": True,
            "targetQuantitiesByPage": {"0": 100, "1": 80, "2": 70},
            "exportUniqueSheets": False,
        },
        job_id="sr01",
        progress_callback=None,
        store=None,
        cancel_event=None,
    )
    telemetry = stages.finish()

    assert output.is_file()
    with pikepdf.open(str(output)) as out:
        assert len(out.pages) == 2 * len(designs)  # front+cut mỗi mẫu, nối theo thứ tự
    # Report gộp: trang 1 lấy lưới 60; trang 2/3 lấy nesting 30+52; vẫn đúng 3 tờ.
    assert "Số mẫu: 3" in report
    assert "142 con" in report
    assert "3 tờ" in report
    assert "targetQuantity" not in captured_legacy_settings
    assert captured_legacy_settings["targetQuantitiesByPage"] == {
        "0": 100,
        "1": 80,
        "2": 70,
    }
    assert captured_legacy_settings["exportUniqueSheets"] is True
    assert captured_legacy_settings["forceLegacyGrid"] is True
    assert telemetry["sr_merge_input_files"] == len(designs)
    assert telemetry["sr_merge_pages"] == 2 * len(designs)
    assert telemetry["sr_merge_attempts"] == 1
    assert telemetry["sr_merge_successes"] == 1
    assert telemetry["sr_merge_s"] >= 0.0
    # File tạm đã dọn (không còn sót trong thư mục tạm).
    assert all(not Path(p).exists() for p in rendered_paths)


def test_step_repeat_merge_loi_giu_output_cu_va_dem_attempt(monkeypatch, tmp_path):
    """Merge lỗi không thay output cũ và telemetry không báo thành công."""

    from app.core import perf_sampler
    from app.workers import nup_true_shape_nesting as nts

    monkeypatch.setenv("PRYNX_PERF", "1")
    source_a = tmp_path / "a.pdf"
    source_b = tmp_path / "b.pdf"
    for path, count in ((source_a, 1), (source_b, 2)):
        pdf = pikepdf.Pdf.new()
        for _ in range(count):
            pdf.add_blank_page(page_size=(20, 20))
        pdf.save(str(path))
        pdf.close()
    output = tmp_path / "merged.pdf"
    output.write_bytes(b"old-output")
    real_replace = nts.os.replace

    def fail_replace(_source, _target):
        raise OSError("replace lỗi")

    monkeypatch.setattr(nts.os, "replace", fail_replace)
    stages = perf_sampler.PerfStages()
    with pytest.raises(OSError, match="replace lỗi"):
        nts._concat_pdf_pages([str(source_a), str(source_b)], str(output))
    telemetry = stages.finish()

    assert output.read_bytes() == b"old-output"
    assert telemetry["sr_merge_input_files"] == 2
    assert "sr_merge_pages" not in telemetry
    assert telemetry["sr_merge_attempts"] == 1
    assert "sr_merge_successes" not in telemetry
    assert telemetry["sr_merge_s"] >= 0.0
    monkeypatch.setattr(nts.os, "replace", real_replace)


# ── §B10-4: bàn giao phiên S&R = danh sách tham chiếu ────────────────────────
def test_attach_step_repeat_references_list(monkeypatch):
    """Đủ phiên mọi mẫu ⇒ gắn LIST ref theo đúng thứ tự mẫu."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    def _fake_jobs(source, settings, *, job_id=None):
        return [SimpleNamespace(parts=[SimpleNamespace(page_index=p)]) for p in (0, 1, 2)]

    monkeypatch.setattr(nts, "build_true_shape_nesting_jobs", _fake_jobs)
    monkeypatch.setattr(
        nts,
        "_report_hash_for_job",
        lambda job: f"report-{job.parts[0].page_index}",
    )

    class _FakeStore:
        def peek_or_wait(self, job):
            page_index = job.parts[0].page_index
            return SimpleNamespace(
                _p=page_index,
                manifest_id=f"m{page_index}",
                layout_fingerprint=f"f{page_index}",
            )

    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store", lambda: _FakeStore()
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        lambda session, store=None: {
            "manifestId": f"m{session._p}",
            "layoutFingerprint": f"f{session._p}",
        },
    )

    result = nts._attach_step_repeat_references(
        {"taskMode": "step_repeat", "isDieCutMode": True},
        "khuon.pdf",
        job_id=None,
        store=None,
    )
    assert result[SESSION_REFERENCE_SETTING] == [
        {"manifestId": "m0", "layoutFingerprint": "f0", "reportHash": "report-0"},
        {"manifestId": "m1", "layoutFingerprint": "f1", "reportHash": "report-1"},
        {"manifestId": "m2", "layoutFingerprint": "f2", "reportHash": "report-2"},
    ]


def test_attach_step_repeat_spill_dung_report_hash_execute_moi(monkeypatch):
    """Batch cache chỉ sở hữu layout; reportHash cũ không được lọt sang Execute."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    jobs = [
        SimpleNamespace(parts=[SimpleNamespace(page_index=page)])
        for page in (0, 1)
    ]
    monkeypatch.setattr(
        nts,
        "build_true_shape_nesting_jobs",
        lambda *_args, **_kwargs: jobs,
    )
    monkeypatch.setattr(
        nts,
        "_report_hash_for_job",
        lambda job: f"execute-{job.parts[0].page_index}",
    )

    class _FakeStore:
        @staticmethod
        def peek_reference_batch_or_wait(_jobs, **_kwargs):
            return [
                {
                    "manifestId": f"m{page}",
                    "layoutFingerprint": f"f{page}",
                    "reportHash": f"preview-cu-{page}",
                }
                for page in (0, 1)
            ]

        @staticmethod
        def peek_or_wait(job, **_kwargs):
            page = job.parts[0].page_index
            return SimpleNamespace(
                manifest_id=f"m{page}",
                layout_fingerprint=f"f{page}",
            )

    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store",
        lambda: _FakeStore(),
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("batch spill không được persist lại")
        ),
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_session",
        lambda *_args, **_kwargs: None,
    )

    result = nts._attach_step_repeat_references(
        {"taskMode": "step_repeat", "isDieCutMode": True},
        "khuon.pdf",
        job_id="spill-report",
        store=None,
    )

    assert result[SESSION_REFERENCE_SETTING] == [
        {"manifestId": "m0", "layoutFingerprint": "f0", "reportHash": "execute-0"},
        {"manifestId": "m1", "layoutFingerprint": "f1", "reportHash": "execute-1"},
    ]


def test_attach_step_repeat_spill_khong_can_session_nong_va_du_hash(monkeypatch):
    """Mẫu đầu bị LRU loại vẫn phải bàn giao nguyên tử đủ reportHash cả batch."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    jobs = [
        SimpleNamespace(parts=[SimpleNamespace(page_index=page)])
        for page in (0, 1)
    ]
    monkeypatch.setattr(
        nts,
        "build_true_shape_nesting_jobs",
        lambda *_args, **_kwargs: jobs,
    )
    monkeypatch.setattr(
        nts,
        "_report_hash_for_job",
        lambda job: f"execute-{job.parts[0].page_index}",
    )

    class _FakeStore:
        @staticmethod
        def peek_reference_batch_or_wait(_jobs, **_kwargs):
            return [
                {"manifestId": f"m{page}", "layoutFingerprint": f"f{page}"}
                for page in (0, 1)
            ]

        @staticmethod
        def peek_or_wait(job, **_kwargs):
            del job
            raise AssertionError(
                "Durable batch đã đủ identity; không được đòi session nóng đã bị LRU loại"
            )

    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store",
        lambda: _FakeStore(),
    )

    result = nts._attach_step_repeat_references(
        {"taskMode": "step_repeat", "isDieCutMode": True},
        "khuon.pdf",
        job_id="spill-session-loi",
        store=None,
    )

    assert result[SESSION_REFERENCE_SETTING] == [
        {"manifestId": "m0", "layoutFingerprint": "f0", "reportHash": "execute-0"},
        {"manifestId": "m1", "layoutFingerprint": "f1", "reportHash": "execute-1"},
    ]


def test_attach_step_repeat_all_or_nothing(monkeypatch):
    """Thiếu phiên của MỘT mẫu ⇒ KHÔNG gắn gì (con tự solve cả loạt, không nửa nạc nửa mỡ)."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    def _fake_jobs(source, settings, *, job_id=None):
        return [SimpleNamespace(parts=[SimpleNamespace(page_index=p)]) for p in (0, 1, 2)]

    monkeypatch.setattr(nts, "build_true_shape_nesting_jobs", _fake_jobs)

    class _FakeStore:
        def peek_or_wait(self, job):
            # Mẫu 1 chưa có phiên.
            if job.parts[0].page_index == 1:
                return None
            return SimpleNamespace(_p=job.parts[0].page_index)

    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store", lambda: _FakeStore()
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        lambda session, store=None: {"manifestId": "m", "layoutFingerprint": "f"},
    )

    result = nts._attach_step_repeat_references(
        {"taskMode": "step_repeat", "isDieCutMode": True},
        "khuon.pdf",
        job_id=None,
        store=None,
    )
    assert SESSION_REFERENCE_SETTING not in result


def test_run_step_repeat_export_dung_tham_chieu(monkeypatch, tmp_path):
    """Có LIST ref ⇒ export nạp manifest + render_stored, TUYỆT ĐỐI không get_or_solve."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    def _fake_jobs(source, settings, *, job_id=None):
        return [
            SimpleNamespace(
                sheet_width_mm=320.0,
                sheet_height_mm=230.0,
                layout_intent="step_repeat_single_sheet",
                artifact_options=SimpleNamespace(report=object()),
                parts=[SimpleNamespace(page_index=p)],
            )
            for p in (0, 1)
        ]

    monkeypatch.setattr(nts, "build_true_shape_nesting_jobs", _fake_jobs)
    monkeypatch.setattr(
        nts,
        "_report_hash_for_job",
        lambda job: f"report-{job.parts[0].page_index}",
    )

    def _no_store():
        raise AssertionError("có tham chiếu thì KHÔNG được solve lại")

    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store", _no_store
    )
    loaded_batches = []

    def _load_batch(refs, store=None):
        loaded_batches.append(tuple(refs))
        return tuple(
            SimpleNamespace(
                manifest={"stats": {"placedCount": 40, "sheetCount": 1}}
            )
            for _ref in refs
        )

    monkeypatch.setattr(
        "app.core.nesting_preview_session.load_referenced_manifests",
        _load_batch,
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.quality_gate_source_for_stored",
        lambda _stored, _job: {"source_path": "snapshot-khuon.pdf"},
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        lambda *_args, **_kwargs: 0,
    )

    def _fake_render_stored(stored, *, output_path, report_override=None):
        assert report_override is not None
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(100, 100))
        pdf.add_blank_page(page_size=(100, 100))
        pdf.save(str(output_path))
        pdf.close()

    monkeypatch.setattr(
        "app.core.nesting_production_pipeline.render_stored_production_nesting",
        _fake_render_stored,
    )

    settings = {
        "taskMode": "step_repeat",
        "isDieCutMode": True,
        SESSION_REFERENCE_SETTING: [
            {
                "manifestId": "m0",
                "layoutFingerprint": "f0",
                "reportHash": "report-0",
                "qualityGateProof": {"designIndex": 0},
            },
            {
                "manifestId": "m1",
                "layoutFingerprint": "f1",
                "reportHash": "report-1",
                "qualityGateProof": {"designIndex": 1},
            },
        ],
    }
    verified_designs = []

    def _verify_proof(proof, _settings, _job, _stored):
        verified_designs.append(proof["designIndex"])
        return SimpleNamespace(decision="nesting", grid_capacity=40)

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_stored",
        _verify_proof,
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("proof reference hợp lệ thì không được probe lại")
        ),
    )
    output = tmp_path / "sr-refs.pdf"
    report = nts._run_step_repeat_export(
        "khuon.pdf",
        str(output),
        settings,
        job_id="x",
        progress_callback=None,
        store=None,
        cancel_event=None,
    )
    with pikepdf.open(str(output)) as out:
        assert len(out.pages) == 4  # 2 mẫu × 2 trang (render_stored giả lập)
    assert "Số mẫu: 2" in report
    assert len(loaded_batches) == 1
    assert [row["manifestId"] for row in loaded_batches[0]] == ["m0", "m1"]
    assert verified_designs == [0, 1]


def test_run_step_repeat_export_tu_choi_report_hash_lech_truoc_khi_load(
    monkeypatch, tmp_path
):
    """Marker layout đúng nhưng overlay lệch phải fail-closed trước disk/solver."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    jobs = [SimpleNamespace(parts=[SimpleNamespace(page_index=0)])]
    monkeypatch.setattr(
        nts,
        "build_true_shape_nesting_jobs",
        lambda *_args, **_kwargs: jobs,
    )
    monkeypatch.setattr(nts, "_report_hash_for_job", lambda _job: "report-moi")
    monkeypatch.setattr(
        "app.core.nesting_preview_session.load_referenced_manifests",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("reportHash lệch phải dừng trước khi đọc manifest")
        ),
    )

    output = tmp_path / "sr-report-hash-lech.pdf"
    with pytest.raises(ValueError, match="Metadata bản xem trước nesting"):
        nts._run_step_repeat_export(
            "khuon.pdf",
            str(output),
            {
                "taskMode": "step_repeat",
                "isDieCutMode": True,
                SESSION_REFERENCE_SETTING: [
                    {
                        "manifestId": "m0",
                        "layoutFingerprint": "f0",
                        "reportHash": "report-cu",
                    }
                ],
            },
            job_id="report-hash-lech",
            progress_callback=None,
            store=None,
            cancel_event=None,
        )
    assert not output.exists()


def test_attach_step_repeat_commit_loi_van_giu_marker_authoritative(monkeypatch):
    """Đã nhận đủ identity thì lỗi commit phải ép export fail-closed, không solve lại."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    def _fake_jobs(source, settings, *, job_id=None):
        return [SimpleNamespace(parts=[SimpleNamespace(page_index=p)]) for p in (0, 1, 2)]

    class _FakeStore:
        def peek_or_wait(self, job):
            page_index = job.parts[0].page_index
            return SimpleNamespace(
                _p=page_index,
                manifest_id=f"m{page_index}",
                layout_fingerprint=f"f{page_index}",
            )

    def _commit_reference(session, store=None):
        if session._p == 1:
            raise OSError("không ghi được manifest thứ hai")
        return {
            "manifestId": session.manifest_id,
            "layoutFingerprint": session.layout_fingerprint,
        }

    monkeypatch.setattr(nts, "build_true_shape_nesting_jobs", _fake_jobs)
    monkeypatch.setattr(
        nts,
        "_report_hash_for_job",
        lambda job: f"report-{job.parts[0].page_index}",
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store", lambda: _FakeStore()
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference", _commit_reference
    )

    result = nts._attach_step_repeat_references(
        {"taskMode": "step_repeat", "isDieCutMode": True},
        "khuon.pdf",
        job_id=None,
        store=None,
    )
    assert result[SESSION_REFERENCE_SETTING] == [
        {"manifestId": "m0", "layoutFingerprint": "f0", "reportHash": "report-0"},
        {"manifestId": "m1", "layoutFingerprint": "f1", "reportHash": "report-1"},
        {"manifestId": "m2", "layoutFingerprint": "f2", "reportHash": "report-2"},
    ]


def test_run_step_repeat_export_tu_choi_marker_thieu_mau(monkeypatch, tmp_path):
    """Marker có mặt nhưng thiếu reference phải lỗi trước khi gọi solver."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as nts

    def _fake_jobs(source, settings, *, job_id=None):
        return [
            SimpleNamespace(parts=[SimpleNamespace(page_index=p)])
            for p in (0, 1)
        ]

    def _no_store():
        raise AssertionError("marker authoritative méo không được rơi xuống solver")

    monkeypatch.setattr(nts, "build_true_shape_nesting_jobs", _fake_jobs)
    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store", _no_store
    )
    output = tmp_path / "sr-marker-thieu.pdf"
    with pytest.raises(ValueError, match=r"không đủ mọi mẫu"):
        nts._run_step_repeat_export(
            "khuon.pdf",
            str(output),
            {
                "taskMode": "step_repeat",
                "isDieCutMode": True,
                SESSION_REFERENCE_SETTING: [
                    {"manifestId": "m0", "layoutFingerprint": "f0"}
                ],
            },
            job_id="x",
            progress_callback=None,
            store=None,
            cancel_event=None,
        )
    assert not output.exists()


# ── PERF-NEST-05: proof quality gate preview → export ────────────────────────
def _fake_quality_gate_job(page_index: int = 0):
    from app.core.nesting_imposition_bundle import ImpositionArtifactOptions

    return SimpleNamespace(
        layout_intent="step_repeat_single_sheet",
        artifact_options=ImpositionArtifactOptions(),
        parts=[
            SimpleNamespace(
                part_id=f"trang-{page_index + 1}",
                page_index=page_index,
                quantity=None,
            )
        ],
    )


@pytest.mark.parametrize("decision", ["nesting", "grid"])
def test_export_dung_proof_hop_le_khong_probe_luoi(monkeypatch, decision):
    """Proof bind đúng manifest/snapshot phải quyết ngay, không mở PDF lần nữa."""

    from app.workers import nup_true_shape_nesting as nts

    job = _fake_quality_gate_job()
    stored = SimpleNamespace(
        manifest={"stats": {"placedCount": 40, "sheetCount": 1}}
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_stored",
        lambda *_args, **_kwargs: SimpleNamespace(
            decision=decision, grid_capacity=54
        ),
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.quality_gate_source_for_stored",
        lambda *_args, **_kwargs: {"source_path": "snapshot.pdf"},
    )

    def _khong_probe(*_args, **_kwargs):
        raise AssertionError("proof hợp lệ không được gọi grid probe")

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings", _khong_probe
    )

    assert nts._export_quality_gate_decision(
        {"gridStrategy": "optimal_auto"},
        job,
        stored=stored,
        proof_value={"serverProof": True},
    ) == (decision, 54)


def test_export_proof_stale_probe_dung_mot_lan_tren_snapshot(monkeypatch):
    """Proof stale đo lại một lần trên resolved snapshot, không dùng source sống."""

    from app.workers import nup_true_shape_nesting as nts

    job = _fake_quality_gate_job(page_index=2)
    stored = SimpleNamespace(
        manifest={"stats": {"placedCount": 40, "sheetCount": 1}}
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_stored",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.quality_gate_source_for_stored",
        lambda *_args, **_kwargs: {"source_path": "snapshot-resolved.pdf"},
    )
    probes = []

    def _probe(path, _settings, page_index):
        probes.append((path, page_index))
        return 54

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings", _probe
    )

    assert nts._export_quality_gate_decision(
        {"gridStrategy": "optimal_auto"},
        job,
        reference={"qualityGateProof": {"stale": True}},
        stored=stored,
    ) == ("grid", 54)
    assert probes == [("snapshot-resolved.pdf", 2)]


def test_export_grid_capacity_zero_khong_co_y_kien(monkeypatch):
    """Probe 0 là không đo được: giữ nesting, không suy thành proof thắng."""

    from app.workers import nup_true_shape_nesting as nts

    job = _fake_quality_gate_job()
    session = SimpleNamespace(
        solved=SimpleNamespace(
            manifest={"stats": {"placedCount": 40, "sheetCount": 1}}
        )
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_session",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.quality_gate_source_for_session",
        lambda *_args, **_kwargs: {"source_path": "snapshot-session.pdf"},
    )
    calls = []

    def _probe(*args):
        calls.append(args)
        return 0

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings", _probe
    )

    assert nts._export_quality_gate_decision(
        {"gridStrategy": "optimal_auto"}, job, session=session
    ) == ("nesting", 0)
    assert len(calls) == 1


def test_export_token_thu_cong_khong_doc_proof_khong_probe(monkeypatch):
    """Yêu cầu true-shape thủ công không đi quality gate dưới mọi hình thức."""

    from app.workers import nup_true_shape_nesting as nts

    def _khong_duoc_goi(*_args, **_kwargs):
        raise AssertionError("manual true_shape_nesting không được chạy quality gate")

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_stored",
        _khong_duoc_goi,
    )
    monkeypatch.setattr(
        "app.core.nesting_quality_gate.grid_capacity_from_settings", _khong_duoc_goi
    )

    assert nts._export_quality_gate_decision(
        {"gridStrategy": "true_shape_nesting"},
        _fake_quality_gate_job(),
        stored=SimpleNamespace(),
        proof_value={"decision": "grid"},
    ) == ("nesting", 0)


def test_handoff_xoa_marker_va_proof_client_du_khong_route(monkeypatch):
    """Hai field authority giả phải bị xóa cả khi job không đi true-shape."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.core.nesting_quality_gate import QUALITY_GATE_PROOF_FIELD
    from app.workers import nup_true_shape_nesting as nts

    monkeypatch.setattr(nts, "wants_true_shape_nesting", lambda _settings: False)
    settings = {
        "gridStrategy": "manual",
        SESSION_REFERENCE_SETTING: {"manifestId": "client"},
        QUALITY_GATE_PROOF_FIELD: {"decision": "grid"},
    }

    result = nts.attach_preview_session_reference(settings, "khuon.pdf")

    assert SESSION_REFERENCE_SETTING not in result
    assert QUALITY_GATE_PROOF_FIELD not in result


@pytest.mark.parametrize("proof_is_valid", [True, False])
def test_handoff_single_chi_gan_proof_server_da_verify(
    monkeypatch, proof_is_valid
):
    """Handoff bỏ proof client; proof server stale cũng không được chuyển process."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.core.nesting_quality_gate import QUALITY_GATE_PROOF_FIELD
    from app.workers import nup_true_shape_nesting as nts

    job = _fake_quality_gate_job()
    session = SimpleNamespace(manifest_id="m-server", layout_fingerprint="f-server")
    server_proof = {"owner": "server"}

    class _Store:
        @staticmethod
        def peek_or_wait(_job, **_kwargs):
            return session

        @staticmethod
        def peek_quality_gate_proof(_job):
            return server_proof

    store = _Store()
    monkeypatch.setattr(nts, "wants_true_shape_nesting", lambda _settings: True)
    monkeypatch.setattr(nts, "_is_step_repeat", lambda _settings: False)
    monkeypatch.setattr(nts, "build_true_shape_nesting_job", lambda *_a, **_k: job)
    monkeypatch.setattr(nts, "_attach_detected_trim_dimensions", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "app.core.nesting_preview_session.get_preview_session_store", lambda: store
    )
    monkeypatch.setattr(
        "app.core.nesting_preview_session.commit_and_reference",
        lambda _session, store=None: {
            "manifestId": "m-server",
            "layoutFingerprint": "f-server",
        },
    )

    class _Verified:
        @staticmethod
        def to_dict():
            return {"owner": "server", "decision": "nesting"}

    def _verify(candidate, _settings, _job, _session):
        assert candidate is server_proof
        return _Verified() if proof_is_valid else None

    monkeypatch.setattr(
        "app.core.nesting_quality_gate.verify_quality_gate_proof_for_session",
        _verify,
    )
    monkeypatch.setattr(
        "app.core.nesting_debug_trace.nesting_trace_enabled", lambda: False
    )
    settings = {
        "gridStrategy": "true_shape_nesting",
        SESSION_REFERENCE_SETTING: {"manifestId": "client"},
        QUALITY_GATE_PROOF_FIELD: {"owner": "client", "decision": "grid"},
    }

    result = nts.attach_preview_session_reference(settings, "khuon.pdf")
    reference = result[SESSION_REFERENCE_SETTING]

    assert QUALITY_GATE_PROOF_FIELD not in result
    assert reference["manifestId"] == "m-server"
    assert reference["layoutFingerprint"] == "f-server"
    assert reference[nts.REPORT_HASH_FIELD] == nts._report_hash_for_job(job)
    if proof_is_valid:
        assert reference[QUALITY_GATE_PROOF_FIELD] == {
            "owner": "server",
            "decision": "nesting",
        }
    else:
        assert QUALITY_GATE_PROOF_FIELD not in reference

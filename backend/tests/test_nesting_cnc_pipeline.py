"""Ô CNC của Cổng Chặng A — nesting theo đường bế cho Bình Bế Rớt CNC.

NEST (audit 2026-08-28 §A4b-3). Báo cáo Lô A4b-1 đã đóng ô **Tem bế** nhưng để
trống ô **CNC**: pipeline có nhánh `cnc_imposer` và fail-closed khi thiếu
``detected_shape``, nhưng chưa có ca DƯƠNG nào chứng minh đường CNC chạy được.

Khác biệt cốt lõi so với lane tem: CNC **không** dò lại đường bế. Job cha đã dò
một lượt và giữ ``DetectedShape``; resolver chỉ được đọc ``page_contour`` tuyệt
đối từ chính lượt dò đó. Vì vậy test này chạy ``detect_die_shapes`` THẬT trên
snapshot rồi truyền kết quả vào pipeline, thay vì nhồi contour bằng tay — nhồi
tay rất dễ vi phạm bất biến mà vẫn cho test xanh (bài học Lô A4b-1).
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

from app.workers.imposition_pdf_form import PT_PER_MM

MM = PT_PER_MM

SHEET_W_MM = 320.0
SHEET_H_MM = 230.0

DIE_MM = 40.0            # khuôn vuông 40mm
HOLE_LO_MM = 14.0        # cửa sổ 14..26mm
HOLE_HI_MM = 26.0


def _requires_engine():
    try:
        from app.core import nesting_production_adapter  # noqa: F401
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"engine nesting chưa sẵn sàng: {exc}")


requires_engine = pytest.mark.usefixtures("_engine_ready")


@pytest.fixture
def _engine_ready():
    _requires_engine()


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    return tmp_path


def _make_cnc_source(path: Path) -> None:
    """PDF nguồn CNC: nền mực kín + khuôn vuông có cửa sổ, vẽ bằng spot CutContour.

    Biên ngoài và cửa sổ nằm trong CÙNG một lệnh vẽ — đúng cách file khuôn thật
    được xuất, và là ca từng làm mất lỗ trước §A4b-2/§A4b-3.
    """

    size = DIE_MM * MM
    lo = HOLE_LO_MM * MM
    hi = HOLE_HI_MM * MM
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


def _detect_shape(path: Path):
    """Dò đường bế THẬT một lượt, đúng như job cha CNC làm."""

    from app.workers import pdf_wrapper
    from app.workers.die_detection import detect_die_shapes

    doc = pdf_wrapper.open(str(path))
    try:
        result = detect_die_shapes(doc)
    finally:
        doc.close()
    assert len(result.shapes) == 1
    return result.shapes[0]


def _cnc_job(
    workdir: Path,
    *,
    quantity: int | None = 4,
    max_sheets: int = 2,
    detected_shape=...,
    page_index: int = 0,
):
    from app.core.nesting_production_pipeline import (
        AxisGapMm,
        JobPartInput,
        ProductionNestingJobInput,
    )

    source = workdir / "khuon-cnc.pdf"
    _make_cnc_source(source)
    shape = _detect_shape(source) if detected_shape is ... else detected_shape

    part = JobPartInput(
        part_id="chi-tiet",
        source_path=source,
        page_index=page_index,
        quantity=quantity,
        detected_shape=shape,
    )
    return ProductionNestingJobInput(
        manifest_id="00112233445566778899aabbccddeeff",
        tool="cnc_imposer",
        layout_intent="quantity_fulfillment",
        sheet_width_mm=SHEET_W_MM,
        sheet_height_mm=SHEET_H_MM,
        parts=(part,),
        margin_mm={"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0},
        max_sheets=max_sheets,
        seed=7,
        profile="fast",
        time_budget_ms=8000,
        part_gap=AxisGapMm(2.0, 2.0),
    )


def _run(job, workdir: Path, *, name: str = "cnc.pdf"):
    from app.core.nesting_manifest_store import NestingManifestStore
    from app.core.nesting_production_pipeline import run_production_nesting_job

    return run_production_nesting_job(
        job,
        output_path=workdir / name,
        store=NestingManifestStore(root=workdir / "manifests"),
    )


def _raw(path: Path, index: int) -> str:
    data = b""
    with pikepdf.Pdf.open(str(path)) as pdf:
        contents = pdf.pages[index].obj.get("/Contents")
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        for stream in streams:
            data += stream.read_bytes()
    return data.decode("latin-1")


# ── Chốt tự kiểm cho fixture ─────────────────────────────────────────────────

def test_fixture_cnc_cho_dung_contour_co_lo(workdir: Path) -> None:
    """Trước khi tin kết quả pipeline, phải chắc bộ dò trả đúng hình.

    Bài học Lô A4b-1: một contour sai vẫn cho mọi assert khác xanh, vì engine
    tính đúng trên hình sai.
    """

    source = workdir / "kiem-cnc.pdf"
    _make_cnc_source(source)
    shape = _detect_shape(source)

    contour = shape.page_contour
    assert contour is not None, "bộ dò phải trả contour page-space cho production"
    assert len(contour.holes_top_down_user_units) == 1, "cửa sổ phải là lỗ khuôn"

    xs = [x for x, _ in contour.outer_top_down_user_units]
    ys = [y for _, y in contour.outer_top_down_user_units]
    assert max(xs) - min(xs) == pytest.approx(DIE_MM * MM, abs=0.5)
    assert max(ys) - min(ys) == pytest.approx(DIE_MM * MM, abs=0.5)

    hole_xs = [x for x, _ in contour.holes_top_down_user_units[0]]
    assert min(hole_xs) == pytest.approx(HOLE_LO_MM * MM, abs=0.5)
    assert max(hole_xs) == pytest.approx(HOLE_HI_MM * MM, abs=0.5)


# ── Ca dương: đường CNC chạy end-to-end ──────────────────────────────────────

@requires_engine
def test_cnc_solve_va_render_duoc_voi_detected_shape_that(workdir: Path) -> None:
    """Ô CNC Cổng A: validator sạch và bundle giữ trim detector làm SSOT kích thước."""

    from dataclasses import replace

    from app.workers.die_detection import Trim

    job = _cnc_job(workdir, quantity=4)
    original_part = job.parts[0]
    # Regression liên tầng cho số runtime thật: contour fixture vẫn 40×40mm nhưng
    # metadata thành phẩm phải giữ nguyên 45,3×52,3mm từ DetectedShape.trim.
    authoritative_shape = replace(
        original_part.detected_shape,
        trim=Trim(45.3 * MM, 52.3 * MM),
    )
    job = replace(
        job,
        parts=(replace(original_part, detected_shape=authoritative_shape),),
    )
    result = _run(job, workdir)
    manifest = result.solved.manifest

    assert manifest["validation"]["valid"] is True
    assert manifest["unplaced"] == []
    assert manifest["stats"]["placedCount"] == 4
    bundle_part = result.solved.production_request.render_bundle["parts"][0]
    assert bundle_part["dieDimensionsMm"] == {
        "width": pytest.approx(45.3, abs=1e-6),
        "height": pytest.approx(52.3, abs=1e-6),
    }
    contour_x = [point[0] for point in bundle_part["cutContour"]["outer"]]
    contour_y = [point[1] for point in bundle_part["cutContour"]["outer"]]
    assert max(contour_x) - min(contour_x) == pytest.approx(DIE_MM, abs=0.1)
    assert max(contour_y) - min(contour_y) == pytest.approx(DIE_MM, abs=0.1)
    assert result.render.output_path.is_file()
    assert result.render.page_count == result.render.sheet_count * len(
        result.render.sides
    )
    assert result.stored is not None


@requires_engine
def test_cnc_placed_count_khong_vuot_tran_hinh_hoc(workdir: Path) -> None:
    """autofill CNC: số chi tiết phải hợp lý VỀ HÌNH HỌC, không chỉ > 0."""

    job = _cnc_job(workdir, quantity=None, max_sheets=1)
    from dataclasses import replace

    job = replace(job, layout_intent="autofill_single_sheet")
    result = _run(job, workdir)
    manifest = result.solved.manifest

    assert manifest["stats"]["sheetCount"] == 1
    placed = manifest["stats"]["placedCount"]
    usable_w = SHEET_W_MM - 10.0
    usable_h = SHEET_H_MM - 10.0
    upper_bound = int((usable_w * usable_h) // (DIE_MM * DIE_MM))
    assert 1 < placed <= upper_bound, (
        f"placedCount={placed} vượt trần hình học {upper_bound} cho khuôn "
        f"{DIE_MM}x{DIE_MM}mm trên vùng in {usable_w}x{usable_h}mm"
    )


@requires_engine
def test_cnc_lo_khuon_toi_duoc_lop_cut(workdir: Path) -> None:
    """Cửa sổ phải thành nét dao trên trang CUT của artifact CNC.

    Đây là mắt xích §A4b-2b: lane CNC lấy contour qua ``DetectedShape`` nên KHÔNG
    đi qua ``extract_page_die_cut_polygon``; bản vá §A4b-2 một mình không đủ.
    """

    result = _run(_cnc_job(workdir, quantity=3), workdir)
    placed = result.solved.manifest["stats"]["placedCount"]
    assert result.render.sides == ("front", "cut")

    cut_stream = _raw(result.render.output_path, 1)
    front_stream = _raw(result.render.output_path, 0)

    assert cut_stream.count(" m\n") == 2 * placed, (
        "trang CUT phải có biên ngoài VÀ cửa sổ cho từng chi tiết"
    )
    assert front_stream.count(" m\n") == placed, (
        "clip artwork chỉ lấy vòng ngoài — lỗ vẫn phải in mực"
    )
    assert " Do" not in cut_stream
    assert " f\n" not in cut_stream


# ── Fail-closed ──────────────────────────────────────────────────────────────

def test_cnc_thieu_detected_shape_thi_fail_closed(workdir: Path) -> None:
    """Bình CNC không được để resolver dò lại — thiếu shape là lỗi, không đoán."""

    job = _cnc_job(workdir, detected_shape=None)
    with pytest.raises(Exception, match="detected_shape"):
        _run(job, workdir)


def test_cnc_detected_shape_lech_trang_thi_fail_closed(workdir: Path) -> None:
    """Shape của trang khác không được dùng cho trang đang resolve."""

    from dataclasses import replace

    source = workdir / "lech-trang.pdf"
    _make_cnc_source(source)
    shape = _detect_shape(source)
    # Giả lập shape tới từ trang 3 của một job khác.
    from app.workers.die_detection import DetectedPageContour

    moved_contour = DetectedPageContour(
        page_index=3,
        outer_top_down_user_units=shape.page_contour.outer_top_down_user_units,
        holes_top_down_user_units=shape.page_contour.holes_top_down_user_units,
    )
    moved = replace(shape, page=3, page_contour=moved_contour)

    job = _cnc_job(workdir, detected_shape=moved)
    with pytest.raises(Exception):
        _run(job, workdir)


def test_cnc_shape_khong_co_page_contour_thi_fail_closed(workdir: Path) -> None:
    """Shape từ cache/schema cũ không mang page_contour ⇒ không được vào production."""

    from dataclasses import replace

    source = workdir / "khong-contour.pdf"
    _make_cnc_source(source)
    shape = replace(_detect_shape(source), page_contour=None)

    job = _cnc_job(workdir, detected_shape=shape)
    with pytest.raises(Exception, match="contour"):
        _run(job, workdir)

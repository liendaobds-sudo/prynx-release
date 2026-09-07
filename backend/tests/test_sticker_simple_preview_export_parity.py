"""Ghim hợp đồng S&R: lựa chọn lưới trên UI phải tới cả preview và PDF thật.

PARITY (audit 2026-09-07 §TEMPERF.C2): ca hai trang khuôn độc lập từng có
12 ô ở preview ``simple_auto`` nhưng 13 ô ở PDF do full-layout ép optimal_auto.
Không dùng snapshot/golden từ output lỗi: lưới đơn có oracle từ khổ nguồn;
CUT được đọc lại và raster hóa để kiểm cả số lượng lẫn tọa độ top-down.
"""

from __future__ import annotations

import hashlib
import math

import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pytest

from app.api.routes import imposition
from app.core.pdfium_lock import pdfium_guard
from app.workers import nup_engine, pdf_wrapper
from tests.license_helpers import PRO_LICENSE
from tests.test_preview_export_canonical_parity import _make_independent_pages


MM_TO_PT = 2.83465
RASTER_SCALE = 2.0


@pytest.fixture(autouse=True)
def _isolated_layout_cache():
    """Cache của ca khác không được vô tình che lỗi cold hoặc batch-prime."""
    imposition._NEST_A_CACHE.clear()
    yield
    imposition._NEST_A_CACHE.clear()


def _request_and_settings(source, rotate, strategy, fractional):
    """Giữ đúng hai payload live: preview dùng pt, bấm Bình gửi mm."""
    if fractional:
        sheet_w, sheet_h = 525.875, 427.125
        left, right, top, bottom = 11.125, 14.375, 9.625, 17.125
        gap_x, gap_y = 2.125, 1.375
    else:
        sheet_w, sheet_h = 520.0, 420.0
        left = right = top = bottom = 10.0
        gap_x = gap_y = 0.0
    # UI GridPreview: (sheet_mm - margin_mm - margin_mm) * MM_TO_PT.
    width_mm, height_mm = sheet_w / MM_TO_PT, sheet_h / MM_TO_PT
    left_mm, right_mm = left / MM_TO_PT, right / MM_TO_PT
    top_mm, bottom_mm = top / MM_TO_PT, bottom / MM_TO_PT
    usable_w = (width_mm - left_mm - right_mm) * MM_TO_PT
    usable_h = (height_mm - top_mm - bottom_mm) * MM_TO_PT
    common = dict(
        path=source,
        usable_w=usable_w,
        usable_h=usable_h,
        sheet_w=width_mm * MM_TO_PT,
        sheet_h=height_mm * MM_TO_PT,
        margin_left=left_mm * MM_TO_PT,
        margin_right=right_mm * MM_TO_PT,
        margin_top=top_mm * MM_TO_PT,
        margin_bottom=bottom_mm * MM_TO_PT,
        gap_x=gap_x,
        gap_y=gap_y,
        strategy=strategy,
        task_mode="step_repeat",
        grouping_strategy="none",
        is_die_cut=True,
    )
    first_size = (80.0, 180.0) if rotate % 180 else (180.0, 80.0)
    sizes = [first_size, (140.0, 90.0)]
    pages = [
        dict(
            page_idx=index,
            item_w=width,
            item_h=height,
            shape_type="RECTANGLE",
            shape_props={},
        )
        for index, (width, height) in enumerate(sizes)
    ]
    singles = [
        imposition.PreviewLayoutRequest(**common, layout_type="repeat", **page)
        for page in pages
    ]
    batch = imposition.PreviewLayoutBatchRequest(**common, pages=pages)
    settings = dict(
        imposerMode="diecut",
        isDieCutMode=True,
        taskMode="step_repeat",
        layoutType="repeat",
        gridStrategy=strategy,
        groupingStrategy="none",
        sheetWidth=width_mm,
        sheetHeight=height_mm,
        marginLeft=left_mm,
        marginRight=right_mm,
        marginTop=top_mm,
        marginBottom=bottom_mm,
        gapX=gap_x / MM_TO_PT,
        gapY=gap_y / MM_TO_PT,
        bleed=0.0,
        align="center",
        targetQuantity=0,
        pontType="none",
        cutType="default",
        markType="none",
        separateCutPage=True,
        exportUniqueSheets=True,
        detectedShapesByPage={"0": "RECTANGLE", "1": "RECTANGLE"},
        detectedShapeParamsByPage={},
    )
    return singles, batch, settings


def _simple_grid_rectangles(request):
    """Oracle độc lập: thử đúng 2 hướng lưới đều rồi căn giữa vùng hữu dụng."""
    options = []
    for width, height in (
        (request.item_w, request.item_h),
        (request.item_h, request.item_w),
    ):
        cols = math.floor((request.usable_w + request.gap_x) / (width + request.gap_x) + 1e-10)
        rows = math.floor((request.usable_h + request.gap_y) / (height + request.gap_y) + 1e-10)
        options.append((cols * rows, width, height, cols, rows))
    # Hai hướng bằng số ô: giữ hướng nguồn như hợp đồng simple_auto.
    count, width, height, cols, rows = max(options, key=lambda option: option[0])
    block_w = cols * width + (cols - 1) * request.gap_x
    block_h = rows * height + (rows - 1) * request.gap_y
    left = request.margin_left + (request.usable_w - block_w) / 2.0
    top = request.margin_top + (request.usable_h - block_h) / 2.0
    rectangles = [
        (
            left + col * (width + request.gap_x),
            top + row * (height + request.gap_y),
            width,
            height,
        )
        for row in range(rows)
        for col in range(cols)
    ]
    assert count == len(rectangles) == 12
    return rectangles


def _preview_rectangles(result):
    """diePolylines đã là top-down; không suy đoán từ tên absY bottom-up."""
    rectangles = []
    for cell in result["cells"]:
        polylines = cell["diePolylines"]
        assert len(polylines) == 1
        points = np.asarray(polylines[0])
        x0, y0 = points.min(axis=0)
        x1, y1 = points.max(axis=0)
        rectangles.append((float(x0), float(y0), float(x1 - x0), float(y1 - y0)))
    return rectangles


def _cut_rectangles(output, page_idx):
    """Đọc sink PDF sau ghi file, không spy placement trung gian."""
    doc = pdf_wrapper.open(str(output))
    try:
        paths = doc[page_idx].extract_vector_paths()
        assert paths
        assert all(path["color"] == (0.0, 1.0, 0.0, 0.0) for path in paths)
        return [
            (path["rect"].x0, path["rect"].y0, path["rect"].width, path["rect"].height)
            for path in paths
        ]
    finally:
        doc.close()


def _assert_rectangles_match(actual, expected):
    assert len(actual) == len(expected), "Số khuôn trong PDF phải bằng sức chứa preview"
    assert np.asarray(sorted(actual)) == pytest.approx(
        np.asarray(sorted(expected)), abs=1e-4
    )


def _assert_cut_raster(output, page_idx, rectangles):
    """Kiểm raster thật: đủ cạnh ở vị trí yêu cầu và không có nét cắt lạc."""
    with pdfium_guard():
        doc = pdfium.PdfDocument(output)
        try:
            page = doc[page_idx]
            try:
                bitmap = page.render(scale=RASTER_SCALE)
                try:
                    picture = bitmap.to_pil().convert("RGB")
                    try:
                        pixels = np.array(picture)
                    finally:
                        picture.close()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            doc.close()
    mask = (pixels[:, :, 0] > 140) & (pixels[:, :, 1] < 180) & (pixels[:, :, 2] > 100)
    expected_band = np.zeros(mask.shape, dtype=bool)
    sample_points = []
    for x, y, width, height in rectangles:
        x0, y0, x1, y1 = [round(value * RASTER_SCALE) for value in (x, y, x + width, y + height)]
        for edge_x in (x0, x1):
            expected_band[max(0, y0 - 2):y1 + 3, max(0, edge_x - 2):edge_x + 3] = True
        for edge_y in (y0, y1):
            expected_band[max(0, edge_y - 2):edge_y + 3, max(0, x0 - 2):x1 + 3] = True
        for t in (0.25, 0.5, 0.75):
            sample_points.extend(((x + width * t, y), (x + width * t, y + height),
                                  (x, y + height * t), (x + width, y + height * t)))
    for x, y in sample_points:
        px, py = round(x * RASTER_SCALE), round(y * RASTER_SCALE)
        assert mask[max(0, py - 2):py + 3, max(0, px - 2):px + 3].any(), (
            f"Thiếu cạnh CUT trên raster top-down tại {(x, y)}"
        )
    assert not (mask & ~expected_band).any(), "PDF có nét CUT ngoài bố cục preview"


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
@pytest.mark.parametrize("strategy", ["simple_auto", "optimal_auto"])
@pytest.mark.parametrize("fractional", [False, True], ids=["integer", "fractional-margin-gap"])
def test_repeat_preview_batch_and_export_pdf_keep_selected_strategy(tmp_path, rotate, strategy, fractional):
    """Cả hai mẫu, cold/warm/batch và artifact phải giữ cùng lựa chọn Cách xếp."""
    source = _make_independent_pages(tmp_path / "source.pdf", rotate)
    source_hash = hashlib.sha256((tmp_path / "source.pdf").read_bytes()).hexdigest()
    requests, batch_request, settings = _request_and_settings(source, rotate, strategy, fractional)
    cold = [imposition.preview_layout(request, PRO_LICENSE) for request in requests]
    warm = [imposition.preview_layout(request, PRO_LICENSE) for request in requests]
    assert warm == cold
    imposition._NEST_A_CACHE.clear()
    batch = imposition.preview_layouts_batch(batch_request, PRO_LICENSE)
    batch_primed = [imposition.preview_layout(request, PRO_LICENSE) for request in requests]
    assert batch_primed == cold
    assert batch["capacities"] == {index: result["totalItems"] for index, result in enumerate(cold)}

    output = tmp_path / "output.pdf"
    nup_engine.run_nup_engine(source, str(output), settings)
    with pikepdf.Pdf.open(output) as doc:
        assert len(doc.pages) == 4, "Hai mẫu phải có hai cặp trang artwork/CUT"
        for page in doc.pages:
            assert [float(value) for value in page.MediaBox] == pytest.approx(
                [0, 0, requests[0].sheet_w, requests[0].sheet_h], abs=1e-4
            )
    for index, result in enumerate(cold):
        expected = _preview_rectangles(result)
        if strategy == "simple_auto":
            expected = _simple_grid_rectangles(requests[index])
            _assert_rectangles_match(_preview_rectangles(result), expected)
        elif not fractional and index == 0:
            # 13 là chặn diện tích floor(500*400/(180*80)); 12 là lưới đều.
            # Đạt 13 xác nhận nhánh tối ưu không bị hạ thành simple để cho test xanh.
            assert result["totalItems"] == 13
        assert len(expected) == result["totalItems"]
        _assert_rectangles_match(_cut_rectangles(output, index * 2 + 1), expected)
        _assert_cut_raster(output, index * 2 + 1, expected)
    assert hashlib.sha256((tmp_path / "source.pdf").read_bytes()).hexdigest() == source_hash
    assert not imposition._NEST_A_INFLIGHT


@pytest.mark.parametrize("strategy", ["simple_auto", "optimal_auto"])
@pytest.mark.parametrize("fractional", [False, True], ids=["integer", "fractional-margin-gap"])
def test_single_template_nup_consumer_keeps_preview_strategy(tmp_path, strategy, fractional):
    """Nhánh N-up một mẫu cũng đọc full_layouts; không chỉ vá nhánh S&R."""
    two_pages = _make_independent_pages(tmp_path / "two-pages.pdf", 90)
    source = str(tmp_path / "single-page.pdf")
    with pikepdf.Pdf.open(two_pages) as doc:
        del doc.pages[1]
        doc.save(source)
    requests, batch, settings = _request_and_settings(source, 90, strategy, fractional)
    request = requests[0].model_copy(update={"task_mode": "nup", "layout_type": "sequential"})
    batch = batch.model_copy(update={"task_mode": "nup", "pages": batch.pages[:1]})
    settings.update(taskMode="nup", layoutType="sequential", detectedShapesByPage={"0": "RECTANGLE"})
    preview = imposition.preview_layout(request, PRO_LICENSE)
    assert imposition.preview_layout(request, PRO_LICENSE) == preview
    imposition._NEST_A_CACHE.clear()
    assert imposition.preview_layouts_batch(batch, PRO_LICENSE)["capacities"] == {0: preview["totalItems"]}
    assert imposition.preview_layout(request, PRO_LICENSE) == preview
    output = tmp_path / "single-output.pdf"
    nup_engine.run_nup_engine(source, str(output), settings)
    with pikepdf.Pdf.open(output) as doc:
        assert len(doc.pages) == 2
    expected = _preview_rectangles(preview)
    if strategy == "simple_auto":
        expected = _simple_grid_rectangles(request)
        _assert_rectangles_match(_preview_rectangles(preview), expected)
    elif not fractional:
        assert preview["totalItems"] == 13
    _assert_rectangles_match(_cut_rectangles(output, 1), expected)
    _assert_cut_raster(output, 1, expected)


@pytest.mark.parametrize("strategy", ["simple_auto", "optimal_auto"])
@pytest.mark.parametrize("fractional", [False, True], ids=["integer", "fractional-margin-gap"])
def test_homogeneous_nup_sibling_keeps_selected_grid_strategy(tmp_path, strategy, fractional):
    """Một khuôn + artwork không khuôn: sửa full-layout không được làm lệch ngược."""
    two_pages = _make_independent_pages(tmp_path / "two-pages.pdf", 90)
    source = str(tmp_path / "homogeneous.pdf")
    with pikepdf.Pdf.open(two_pages) as doc:
        # Trang thứ hai chỉ có mảng mực đen, không có tín hiệu màu/kênh đường bế.
        doc.pages[1].obj[pikepdf.Name("/Contents")] = doc.make_stream(
            b"0 0 0 rg 20 20 100 60 re f\n"
        )
        doc.save(source)
    requests, _, settings = _request_and_settings(source, 90, strategy, fractional)
    request = requests[0].model_copy(update={
        "task_mode": "nup",
        "layout_type": "sequential",
        "target_quantity": 8,
        "detected_shapes_by_page": {"0": "RECTANGLE", "1": "CUSTOM"},
    })
    settings.update(
        taskMode="nup", layoutType="sequential", targetQuantity=8,
        detectedShapesByPage={"0": "RECTANGLE", "1": "CUSTOM"},
    )
    preview = imposition.preview_layout(request, PRO_LICENSE)
    assert preview.get("isHomogeneousPreview") is True
    assert imposition.preview_layout(request, PRO_LICENSE) == preview
    output = tmp_path / "homogeneous-output.pdf"
    nup_engine.run_nup_engine(source, str(output), settings)
    with pikepdf.Pdf.open(output) as doc:
        # Hợp đồng shared-master: hai tờ in và MỘT tờ khuôn dùng chung ở cuối.
        assert len(doc.pages) == 3
    cut_rectangles = _cut_rectangles(output, 2)
    assert len(cut_rectangles) == preview["totalItems"] == len(preview["cells"])
    preview_rectangles = [
        (cell["absX"], request.sheet_h - cell["absY"] - cell["height"], cell["width"], cell["height"])
        for cell in preview["cells"]
    ]
    if strategy == "simple_auto":
        expected = _simple_grid_rectangles(request)
        _assert_rectangles_match(preview_rectangles, expected)
    else:
        expected = preview_rectangles
        if not fractional:
            assert len(expected) == 13
    _assert_rectangles_match(cut_rectangles, expected)
    _assert_cut_raster(output, 2, expected)

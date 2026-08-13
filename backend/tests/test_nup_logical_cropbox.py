"""Hồi quy N-Up khi trang logic nằm trong CropBox trên MediaBox lớn."""

from __future__ import annotations

import pikepdf
import pytest

from tests.license_helpers import PRO_LICENSE
from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib
from app.api.routes.imposition import (
    PreviewLayoutBatchRequest,
    PreviewLayoutRequest,
    preview_layout,
    preview_layouts_batch,
)
from app.workers.mixed_guillotine_adapter import (
    resolve_guillotine_source_clip,
    resolve_guillotine_trim,
)
from app.workers.nup_diecut import resolve_one_dao_trim
from app.workers.pont_collision import (
    build_collision_base_polygon,
    calculate_forbidden_zones,
    detect_collisions,
)


LARGE_MEDIA = [50.0, 30.0, 956.15, 1383.60]
LOGICAL_CROP = [100.0, 80.0, 517.04, 225.51]
PONT_5MM = {
    "shape": "circle",
    "size": 5.0,
    "thickness": 0.5,
    "isGraphtec": False,
    "layerName": "Marks_Model_",
    "groupName": "MarkLine",
    "itemName": "MKLINE",
    "marginTop": 7.0,
    "marginBottom": 7.0,
    "marginLeft": 7.0,
    "marginRight": 7.0,
    "disableCollision": False,
}


def _make_cropbox_pdf(path, media_box, crop_box):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(
        page_size=(media_box[2] - media_box[0], media_box[3] - media_box[1]),
    )
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(media_box)
    page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array(crop_box)
    if "/TrimBox" in page.obj:
        del page.obj[pikepdf.Name("/TrimBox")]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"q 0 0 0 1 k 100 80 417.04 145.51 re f Q\n",
    )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _make_user_unit_pdf(path, user_unit):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100.0, 50.0))
    if user_unit != 1.0:
        page.obj[pikepdf.Name("/UserUnit")] = user_unit
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"0 0 0 rg 0 0 100 50 re f\n",
    )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _box(path, name):
    with pikepdf.Pdf.open(path) as pdf:
        return [float(value) for value in pdf.pages[0].obj[name]]


def _do_count(path):
    with pikepdf.Pdf.open(path) as pdf:
        return sum(
            str(instruction.operator) == "Do"
            for page in pdf.pages
            for instruction in pikepdf.parse_content_stream(page)
        )


def _minimum_rendered_gray(path):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        bitmap = doc[0].render(scale=0.5)
        return bitmap.to_pil().convert("L").getextrema()[0]
    finally:
        doc.close()


def _rendered_dark_ratio(path):
    import numpy as np
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        bitmap = doc[0].render(scale=0.35)
        gray = np.asarray(bitmap.to_pil().convert("L"))
        return float((gray < 64).mean())
    finally:
        doc.close()


def _rendered_page_ratios(path):
    """Tỷ lệ điểm ảnh để chặn PDF có operator nhưng render thực tế trắng."""
    import numpy as np
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        ratios = []
        for page_index in range(len(doc)):
            bitmap = doc[page_index].render(scale=0.5)
            rgb = np.asarray(bitmap.to_pil().convert("RGB"))
            ratios.append({
                "nonwhite": float(np.any(rgb < 245, axis=2).mean()),
                "colored": float(((rgb.max(axis=2) - rgb.min(axis=2)) > 20).mean()),
            })
        return ratios
    finally:
        doc.close()


def test_canonicalization_preserves_large_logical_cropbox(tmp_path):
    source = _make_cropbox_pdf(
        tmp_path / "large-canvas.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )

    canonical, is_temporary = nup_engine._canonicalize_page_space(
        source,
        "logical-cropbox",
    )
    assert is_temporary is True
    assert _box(canonical, "/MediaBox") == pytest.approx(
        [0.0, 0.0, LARGE_MEDIA[2] - LARGE_MEDIA[0], LARGE_MEDIA[3] - LARGE_MEDIA[1]],
    )
    assert _box(canonical, "/CropBox") == pytest.approx(
        [
            LOGICAL_CROP[0] - LARGE_MEDIA[0],
            LOGICAL_CROP[1] - LARGE_MEDIA[1],
            LOGICAL_CROP[2] - LARGE_MEDIA[0],
            LOGICAL_CROP[3] - LARGE_MEDIA[1],
        ],
    )

    doc = pdf_lib.open(canonical)
    try:
        page = doc[0]
        crop_width = LOGICAL_CROP[2] - LOGICAL_CROP[0]
        crop_height = LOGICAL_CROP[3] - LOGICAL_CROP[1]
        assert resolve_guillotine_trim(page, 0.0) == pytest.approx(
            (
                crop_width,
                crop_height,
            ),
        )
        assert resolve_guillotine_trim(page, 2.0) == pytest.approx(
            (crop_width - 4.0, crop_height - 4.0),
        )
        assert resolve_guillotine_source_clip(page, 2.0) == pytest.approx(
            (
                page.cropbox.x0,
                page.rect.height - page.cropbox.y1,
                page.cropbox.x1,
                page.rect.height - page.cropbox.y0,
            ),
        )
    finally:
        doc.close()


def test_small_crop_difference_keeps_media_as_logical_page(tmp_path):
    """CropBox chỉ hụt vài pt là crop/bleed thường, không phải trang con."""
    media = [50.0, 30.0, 250.0, 130.0]
    crop = [53.0, 33.0, 247.0, 127.0]
    source = _make_cropbox_pdf(tmp_path / "normal-crop.pdf", media, crop)
    canonical, _ = nup_engine._canonicalize_page_space(source, "normal-cropbox")

    doc = pdf_lib.open(canonical)
    try:
        assert resolve_guillotine_trim(doc[0], 0.0) == pytest.approx((200.0, 100.0))
    finally:
        doc.close()


def test_one_dao_individual_sticker_uses_logical_cropbox_for_preview_and_export(
    tmp_path,
):
    """Từng tem + 1 Dao theo trang phải cho 18 tem/tờ, không lấy canvas lớn."""
    source = _make_cropbox_pdf(
        tmp_path / "one-dao-logical-crop.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )
    doc = pdf_lib.open(source)
    try:
        assert resolve_one_dao_trim(
            doc[0], "one_dao", "page", 0,
        ) == pytest.approx((417.04, 145.51))
    finally:
        doc.close()

    mm_to_pt = 72.0 / 25.4
    request_common = {
        "usable_w": 320.0 * mm_to_pt,
        "usable_h": 450.0 * mm_to_pt,
        "gap_x": 2.0 * mm_to_pt,
        "gap_y": 2.0 * mm_to_pt,
        "strategy": "optimal_auto",
        "path": source,
        "bleed": 0.0,
        "task_mode": "step_repeat",
        "is_die_cut": True,
        "page_sheet_mode": False,
        "sheet_w": 320.0 * mm_to_pt,
        "sheet_h": 450.0 * mm_to_pt,
        "cut_type": "one_dao",
        "die_size_mode": "page",
        "die_offset_mm": 0.0,
    }
    preview = preview_layout(
        PreviewLayoutRequest(
            **request_common,
            item_w=417.04,
            item_h=145.51,
            shape_type="RECTANGLE",
            layout_type="repeat",
        ),
        license_info=PRO_LICENSE,
    )
    assert preview["totalItems"] == 18

    batch = preview_layouts_batch(
        PreviewLayoutBatchRequest(
            **request_common,
            pages=[{
                "page_idx": 0,
                "shape_type": "RECTANGLE",
                "shape_props": {},
                "item_w": 417.04,
                "item_h": 145.51,
            }],
        ),
        license_info=PRO_LICENSE,
    )
    assert batch["capacities"] == {0: 18}

    output = tmp_path / "one-dao-logical-crop-out.pdf"
    nup_engine.run_nup_engine(
        source,
        str(output),
        {
            "imposerMode": "sticker_imposer",
            "isDieCutMode": True,
            "sheetWidth": 320.0,
            "sheetHeight": 450.0,
            "layoutType": "repeat",
            "gridStrategy": "optimal_auto",
            "targetQuantity": 0,
            "targetQuantitiesByPage": {},
            "gapX": 2.0,
            "gapY": 2.0,
            "marginTop": 0.0,
            "marginBottom": 0.0,
            "marginLeft": 0.0,
            "marginRight": 0.0,
            "markType": "none",
            "pontType": "none",
            "bleed": 0.0,
            "cutType": "one_dao",
            "dieSizeMode": "page",
            "dieOffsetMm": 0.0,
            "separateCutPage": False,
            "detectedShapesByPage": {"0": "RECTANGLE"},
            "detectedShapeParamsByPage": {"0": {}},
        },
        job_id="one-dao-logical-crop",
    )
    assert _do_count(output) == 18
    assert _minimum_rendered_gray(output) < 64
    assert _rendered_dark_ratio(output) > 0.80


def test_one_dao_rotated_rectangle_avoids_5mm_ponts_in_preview_batch_and_export(
    tmp_path,
):
    """Ca thật 147,1 × 51,3 mm: footprint xoay dọc không được xoay lần hai."""
    source = _make_cropbox_pdf(
        tmp_path / "one-dao-pont-logical-crop.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )
    mm_to_pt = 72.0 / 25.4
    request_common = {
        "usable_w": 320.0 * mm_to_pt,
        "usable_h": 450.0 * mm_to_pt,
        "gap_x": 0.0,
        "gap_y": 0.0,
        "strategy": "optimal_auto",
        "path": source,
        "bleed": 0.0,
        "task_mode": "step_repeat",
        "is_die_cut": True,
        "page_sheet_mode": False,
        "pont_config": dict(PONT_5MM),
        "sheet_w": 320.0 * mm_to_pt,
        "sheet_h": 450.0 * mm_to_pt,
        "margin_left": 0.0,
        "margin_right": 0.0,
        "margin_top": 0.0,
        "margin_bottom": 0.0,
        "cut_type": "one_dao",
        "die_size_mode": "page",
        "die_offset_mm": 0.0,
    }

    preview = preview_layout(
        PreviewLayoutRequest(
            **request_common,
            item_w=417.04,
            item_h=145.51,
            shape_type="RECTANGLE",
            layout_type="repeat",
        ),
        license_info=PRO_LICENSE,
    )
    assert preview["totalItems"] == 16
    assert len(preview["cells"]) == 16

    # Chốt trực tiếp bất biến hình học: mọi footprint sau resolver đều rời 4
    # vùng an toàn quanh ốc, không chỉ kiểm con số 16.
    placements = [{
        "abs_x": cell["absX"],
        "abs_y": cell["absY"],
        "width": cell["width"],
        "height": cell["height"],
        "cell": cell,
    } for cell in preview["cells"]]
    base_poly, base_rect = build_collision_base_polygon(
        None,
        "RECTANGLE",
        placements[0]["width"],
        placements[0]["height"],
        is_rect_cell=True,
    )
    zones = calculate_forbidden_zones(
        PONT_5MM,
        {},
        request_common["sheet_w"],
        request_common["sheet_h"],
    )
    assert detect_collisions(
        placements,
        zones,
        base_poly,
        base_rect,
        request_common["sheet_h"],
    ) == []

    batch = preview_layouts_batch(
        PreviewLayoutBatchRequest(
            **request_common,
            pages=[{
                "page_idx": 0,
                "shape_type": "RECTANGLE",
                "shape_props": {},
                "item_w": 417.04,
                "item_h": 145.51,
            }],
        ),
        license_info=PRO_LICENSE,
    )
    assert batch["capacities"] == {0: 16}

    output = tmp_path / "one-dao-pont-logical-crop-out.pdf"
    nup_engine.run_nup_engine(
        source,
        str(output),
        {
            "imposerMode": "sticker_imposer",
            "isDieCutMode": True,
            "sheetWidth": 320.0,
            "sheetHeight": 450.0,
            "layoutType": "repeat",
            "gridStrategy": "optimal_auto",
            "targetQuantity": 0,
            "targetQuantitiesByPage": {},
            "gapX": 0.0,
            "gapY": 0.0,
            "marginTop": 0.0,
            "marginBottom": 0.0,
            "marginLeft": 0.0,
            "marginRight": 0.0,
            "markType": "none",
            "pontType": "5mm",
            "pontConfig": dict(PONT_5MM),
            "bleed": 0.0,
            "cutType": "one_dao",
            "dieSizeMode": "page",
            "dieOffsetMm": 0.0,
            "separateCutPage": False,
            "detectedShapesByPage": {"0": "RECTANGLE"},
            "detectedShapeParamsByPage": {"0": {}},
        },
        job_id="one-dao-pont-logical-crop",
    )
    assert _do_count(output) == 16
    assert _minimum_rendered_gray(output) < 64
    assert _rendered_dark_ratio(output) > 0.65


def test_default_cut_without_contour_uses_logical_page_for_preview_and_export(
    tmp_path,
):
    """Mặc định không CutContour phải lấy khổ trang, không xuất hai trang trắng."""
    source = _make_cropbox_pdf(
        tmp_path / "default-page-fallback.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )
    mm_to_pt = 72.0 / 25.4
    request_common = {
        "usable_w": 320.0 * mm_to_pt,
        "usable_h": 450.0 * mm_to_pt,
        "gap_x": 0.0,
        "gap_y": 0.0,
        "strategy": "optimal_auto",
        "path": source,
        "bleed": 0.0,
        "task_mode": "step_repeat",
        "is_die_cut": True,
        "page_sheet_mode": False,
        "pont_config": dict(PONT_5MM),
        "sheet_w": 320.0 * mm_to_pt,
        "sheet_h": 450.0 * mm_to_pt,
        "margin_left": 0.0,
        "margin_right": 0.0,
        "margin_top": 0.0,
        "margin_bottom": 0.0,
        "cut_type": "default",
        "die_size_mode": "die",
        "die_offset_mm": 0.0,
    }

    preview = preview_layout(
        PreviewLayoutRequest(
            **request_common,
            item_w=LOGICAL_CROP[2] - LOGICAL_CROP[0],
            item_h=LOGICAL_CROP[3] - LOGICAL_CROP[1],
            # UI có thể chưa kịp đổi từ Đặc biệt; fallback PageBox vẫn là chữ nhật.
            shape_type="CUSTOM",
            shape_props={},
            layout_type="repeat",
        ),
        license_info=PRO_LICENSE,
    )
    assert preview["totalItems"] == 16
    assert len(preview["cells"]) == 16

    batch = preview_layouts_batch(
        PreviewLayoutBatchRequest(
            **request_common,
            pages=[{
                "page_idx": 0,
                "shape_type": "CUSTOM",
                "shape_props": {},
                "item_w": LOGICAL_CROP[2] - LOGICAL_CROP[0],
                "item_h": LOGICAL_CROP[3] - LOGICAL_CROP[1],
            }],
        ),
        license_info=PRO_LICENSE,
    )
    assert batch["capacities"] == {0: 16}

    output = tmp_path / "default-page-fallback-out.pdf"
    nup_engine.run_nup_engine(
        source,
        str(output),
        {
            "imposerMode": "sticker_imposer",
            "isDieCutMode": True,
            "sheetWidth": 320.0,
            "sheetHeight": 450.0,
            "layoutType": "repeat",
            "gridStrategy": "optimal_auto",
            "targetQuantity": 0,
            "targetQuantitiesByPage": {},
            "gapX": 0.0,
            "gapY": 0.0,
            "marginTop": 0.0,
            "marginBottom": 0.0,
            "marginLeft": 0.0,
            "marginRight": 0.0,
            "markType": "none",
            "pontType": "5mm",
            "pontConfig": dict(PONT_5MM),
            "bleed": 0.0,
            "cutType": "default",
            "dieSizeMode": "die",
            "dieOffsetMm": 0.0,
            "separateCutPage": True,
            "pontsOnCutFile": True,
            "detectedShapesByPage": {"0": "CUSTOM"},
            "detectedShapeParamsByPage": {"0": {}},
        },
        job_id="default-page-fallback",
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
    assert _do_count(output) == 16
    page_ratios = _rendered_page_ratios(output)
    assert page_ratios[0]["nonwhite"] > 0.50
    assert page_ratios[1]["colored"] > 0.01

    rendered = pdf_lib.open(str(output))
    try:
        cut_rects = [
            path["rect"]
            for path in rendered[1].extract_vector_paths()
            if path.get("type") == "s"
            and abs(path["rect"].width - (LOGICAL_CROP[3] - LOGICAL_CROP[1])) < 1.0
            and abs(path["rect"].height - (LOGICAL_CROP[2] - LOGICAL_CROP[0])) < 1.0
        ]
        assert len(cut_rects) == 16
    finally:
        rendered.close()


def test_ui_bleed_overrides_embedded_trimbox(tmp_path):
    """Bleed người dùng chọn là nguồn duy nhất để suy ra khổ thành phẩm."""
    media = [0.0, 0.0, 200.0, 100.0]
    source = _make_cropbox_pdf(tmp_path / "explicit-trim.pdf", media, media)
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as pdf:
        pdf.pages[0].obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(
            [3.0, 3.0, 197.0, 97.0],
        )
        pdf.save(source)

    doc = pdf_lib.open(source)
    try:
        assert resolve_guillotine_trim(doc[0], 2.0) == pytest.approx((196.0, 96.0))
        assert resolve_guillotine_trim(doc[0], 3.0) == pytest.approx((194.0, 94.0))
        assert resolve_guillotine_source_clip(doc[0], 2.0) is None
    finally:
        doc.close()


def test_export_capacity_follows_ui_bleed_not_embedded_trimbox(tmp_path):
    """Hồi quy S&R: UI 2 mm → 16 con/tờ, UI 3 mm → 17 con/tờ."""
    mm_to_pt = 72.0 / 25.4
    media = [0.0, 0.0, 434.0452, 162.5179]
    source = _make_cropbox_pdf(tmp_path / "sr-explicit-trim.pdf", media, media)
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as pdf:
        inset = 3.0 * mm_to_pt
        pdf.pages[0].obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(
            [inset, inset, media[2] - inset, media[3] - inset],
        )
        pdf.save(source)

    base_settings = {
        "imposerMode": "guillotine",
        "isDieCutMode": False,
        "sheetWidth": 330.0,
        "sheetHeight": 480.0,
        "layoutType": "repeat",
        "gridStrategy": "optimal_auto",
        "targetQuantity": 0,
        "targetQuantitiesByPage": {},
        "gapX": 2.0,
        "gapY": 2.0,
        "marginTop": 8.0,
        "marginBottom": 8.0,
        "marginLeft": 8.0,
        "marginRight": 8.0,
        "gripperMargin": 0.0,
        "markType": "none",
        "pontType": "none",
        "splitGap": 6.0,
    }

    for bleed_mm, expected_capacity in ((2.0, 16), (3.0, 17)):
        output = tmp_path / f"sr-bleed-{int(bleed_mm)}.pdf"
        nup_engine.run_nup_engine(
            source,
            str(output),
            {**base_settings, "bleed": bleed_mm},
            job_id=f"sr-bleed-{int(bleed_mm)}",
        )
        assert _do_count(output) == expected_capacity


def test_user_unit_output_uses_physical_size_once(tmp_path):
    """PAGEBOX (audit 2026-08-04 §W1.PB3): không xếp chồng `/UserUnit=2`."""
    settings = {
        "imposerMode": "guillotine",
        "isDieCutMode": False,
        "sheetWidth": 141.2,
        "sheetHeight": 70.6,
        "bleed": 0.0,
        "gapX": 0.0,
        "gapY": 0.0,
        "marginTop": 0.0,
        "marginBottom": 0.0,
        "marginLeft": 0.0,
        "marginRight": 0.0,
        "gripperMargin": 0.0,
        "markType": "none",
        "pontType": "none",
        "gridStrategy": "simple_auto",
        "layoutType": "repeat",
        "targetQuantity": 0,
        "targetQuantitiesByPage": {},
    }
    counts = []
    for user_unit in (2.0, 1.0):
        source = _make_user_unit_pdf(
            tmp_path / f"unit-{user_unit}.pdf",
            user_unit,
        )
        if user_unit == 1.0:
            with pikepdf.Pdf.open(source, allow_overwriting_input=True) as pdf:
                page = pdf.pages[0].obj
                page[pikepdf.Name("/MediaBox")] = pikepdf.Array([0, 0, 200, 100])
                page[pikepdf.Name("/CropBox")] = pikepdf.Array([0, 0, 200, 100])
                page[pikepdf.Name("/Contents")].write(
                    b"0 0 0 rg 0 0 200 100 re f\n",
                )
                pdf.save(source)
        output = tmp_path / f"out-unit-{user_unit}.pdf"
        nup_engine.run_nup_engine(
            source,
            str(output),
            settings,
            job_id=f"unit-{user_unit}",
        )
        counts.append(_do_count(output))

    assert counts == [4, 4]


@pytest.mark.parametrize("layout_type", ["sequential", "repeat"])
def test_export_uses_logical_cropbox_and_border_does_not_change_layout(
    tmp_path,
    layout_type,
):
    source = _make_cropbox_pdf(
        tmp_path / f"logical-{layout_type}.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )
    counts = []
    darkest_pixels = []
    for enabled in (False, True):
        output = tmp_path / f"out-{layout_type}-{int(enabled)}.pdf"
        nup_engine.run_nup_engine(
            source,
            str(output),
            {
                "isDieCutMode": False,
                "sheetWidth": 320.0,
                "sheetHeight": 450.0,
                "layoutType": layout_type,
                "gridStrategy": "optimal_auto",
                "targetQuantity": 1,
                "targetQuantitiesByPage": {"0": 1},
                "gapX": 0.0,
                "gapY": 0.0,
                "markType": "none",
                "pontType": "none",
                "bleed": 0.0,
                "cutBorderEnabled": enabled,
                "cutBorderPosition": "trim",
                "cutBorderColor": "#000000",
                "cutBorderThickness": 0.3,
            },
            job_id=f"logical-{layout_type}-{int(enabled)}",
        )
        counts.append(_do_count(output))
        darkest_pixels.append(_minimum_rendered_gray(output))

    assert counts[0] == counts[1]
    assert counts[0] >= 1
    assert all(value < 64 for value in darkest_pixels), (
        "Artwork trong CropBox phải thật sự hiện trên tờ, không chỉ có toán tử Do."
    )

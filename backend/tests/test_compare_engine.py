"""Regression tests cho lõi so sánh PDF (ImageComparator) — subsystem 'compare'.

Trước đây KHÔNG có test tự động (audit #S1). Phủ:
  - Ảnh giống hệt → ~100% tương đồng, 0 vùng khác.
  - Ảnh khác → tương đồng < 100, có ít nhất 1 vùng khác.
  - Imposition mode (tờ N-up lớn hơn template >1.5x) được nhận diện + đếm thực thể.
  - PDFProcessor.render_page ra ảnh hợp lệ.
"""
import io

import numpy as np
import pytest

from app.core.image_comparator import ImageComparator


def _canvas_with_bar():
    img = np.full((300, 400, 3), 255, np.uint8)
    img[50:100, 50:200] = (0, 0, 0)  # thanh đen cố định
    return img


def test_identical_images_full_similarity():
    cmp = ImageComparator()
    a = _canvas_with_bar()
    res = cmp.compare(a, a.copy(), tolerance="NORMAL")
    assert res.similarity_score == pytest.approx(100.0, abs=0.5)
    assert res.diff_count == 0


def test_different_images_detected():
    cmp = ImageComparator()
    a = _canvas_with_bar()
    b = a.copy()
    b[150:200, 250:350] = (0, 0, 0)  # thêm 1 ô đen mới
    res = cmp.compare(a, b, tolerance="NORMAL")
    assert res.similarity_score < 100.0
    assert res.diff_count >= 1
    assert len(res.diff_regions) >= 1


def test_imposition_mode_detected_for_large_sheet():
    cmp = ImageComparator()
    templ = _canvas_with_bar()           # 300x400
    sheet = np.full((600, 800, 3), 255, np.uint8)  # 2x2 lớn hơn >1.5x
    for (yy, xx) in [(0, 0), (0, 400), (300, 0), (300, 400)]:
        sheet[yy:yy + 300, xx:xx + 400] = templ
    res = cmp.compare(templ, sheet, tolerance="NORMAL")
    assert res.is_imposition_mode is True
    # Tìm thấy ít nhất các bản lặp (đếm có thể nhỉnh hơn do template ít chi tiết).
    assert res.total_instances >= 4


def test_tolerance_levels_do_not_crash():
    cmp = ImageComparator()
    a = _canvas_with_bar()
    b = a.copy()
    b[120:140, 120:140] = (128, 128, 128)
    for tol in ("STRICT", "NORMAL", "LOOSE"):
        res = cmp.compare(a, b, tolerance=tol)
        assert 0.0 <= res.similarity_score <= 100.0


def test_pdfprocessor_render_page_produces_image():
    from app.core.pdf_processor import PDFProcessor
    from app.workers import pdf_wrapper as pdf_lib

    d = pdf_lib.open()
    pg = d.new_page(width=200, height=300)
    sh = pg.new_shape(); sh.draw_rect(pdf_lib.Rect(20, 20, 180, 280)); sh.finish(color=(0, 0, 0)); sh.commit()
    buf = io.BytesIO(); d.save(buf); d.close()
    import tempfile, os
    fd, sp = tempfile.mkstemp(suffix=".pdf"); os.close(fd)
    open(sp, 'wb').write(buf.getvalue())
    try:
        proc = PDFProcessor()
        with proc.open_document(sp, dpi=72) as doc:
            assert doc.page_count == 1
            img = doc.render_page(0)
            assert img is not None and img.size > 0
            assert img.shape[2] in (3, 4)  # RGB/RGBA
    finally:
        os.remove(sp)


# ── Audit so-sánh: các fix bổ sung ──

def test_taller_page_not_imposition_area_gate():
    """#3: trang chỉ CAO hơn (cùng diện tích xấp xỉ, ratio < 1.8) → KHÔNG vào
    imposition mà so 1:1 (pad). Trước đây ratio 1 chiều 1.7 > 1.5 → nhầm imposition."""
    cmp = ImageComparator()
    a = np.full((1000, 800, 3), 255, np.uint8)
    a[100:200, 100:300] = 0
    b = np.full((1700, 800, 3), 255, np.uint8)  # cao hơn 1.7× (area 1.7 < 1.8)
    b[100:200, 100:300] = 0                       # cùng nội dung ở phần trên
    res = cmp.compare(a, b, tolerance="NORMAL")
    assert res.is_imposition_mode is False


def test_two_up_sheet_still_imposition_after_area_gate():
    """Tờ N-up thật (≥ ~2× diện tích) vẫn phải nhận diện imposition."""
    cmp = ImageComparator()
    templ = _canvas_with_bar()                       # 300×400 (area 120k)
    sheet = np.full((600, 800, 3), 255, np.uint8)    # 4× diện tích
    for yy in (0, 300):
        for xx in (0, 400):
            sheet[yy:yy + 300, xx:xx + 400] = templ
    res = cmp.compare(templ, sheet, tolerance="NORMAL")
    assert res.is_imposition_mode is True


def test_tiny_change_keeps_high_ssim_but_flags_region():
    """#1 (precondition): sửa đổi NHỎ trên trang lớn vẫn cho SSIM toàn cục ~cao,
    NHƯNG diff_count ≥ 1. Logic status ở comparison_engine vì vậy KHÔNG được đánh
    PASS chỉ dựa SSIM (diff_count>0 ⇒ tối thiểu 'warning')."""
    cmp = ImageComparator()
    a = np.full((1500, 1500, 3), 255, np.uint8)
    b = a.copy()
    b[10:45, 10:160] = 0  # vùng nhỏ ~ 0.2% diện tích
    res = cmp.compare(a, b, tolerance="NORMAL")
    assert res.diff_count >= 1
    assert res.similarity_score >= 99.0  # SSIM toàn cục vẫn rất cao


def test_micro_glyph_change_not_filtered_as_noise():
    """Audit false-identical: đổi 1 chữ ~6pt trên trang đầy nội dung phải được
    bắt (micro-diff rescue), không PASS 0 region vì min_contour_area."""
    from PIL import Image, ImageDraw, ImageFont

    def _page(ch: str, size_pt: int = 6, dpi: int = 150):
        w, h = int(595 * dpi / 72), int(842 * dpi / 72)
        img = Image.new("RGB", (w, h), "white")
        d = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("arial.ttf", max(1, int(size_pt * dpi / 72)))
        except Exception:
            font = ImageFont.load_default()
        for i in range(40):
            d.text(
                (40, 40 + i * 18),
                "Content line number %02d static text block" % i,
                fill="black",
                font=font,
            )
        d.text((40, 40 + 40 * 18), f"ID: 1234{ch}", fill="black", font=font)
        return np.array(img)

    cmp = ImageComparator()
    a = _page("0")
    b = _page("1")
    res = cmp.compare(a, b, tolerance="NORMAL", config={"dpi": 150})
    assert res.diff_count >= 1, "6pt one-char change must not be filtered to 0 regions"
    # Identical pages still clean
    res_same = cmp.compare(a, a.copy(), tolerance="NORMAL", config={"dpi": 150})
    assert res_same.diff_count == 0


def test_real_label_goc_vs_binh_detects_diff():
    """Regression file thật: test/goc.pdf vs test/binh.pdf — trước đây PASS giả
    (contour 18–65 < min_area 50–200). Phải diff_count ≥ 1 ở 150 và 300 DPI."""
    from pathlib import Path
    import pypdfium2 as pdfium

    root = Path(__file__).resolve().parents[2]  # repo root pdfcompare/
    goc = root / "test" / "goc.pdf"
    binh = root / "test" / "binh.pdf"
    if not goc.is_file() or not binh.is_file():
        pytest.skip("test/goc.pdf or test/binh.pdf missing")

    def _render(path, dpi):
        pdf = pdfium.PdfDocument(str(path))
        bmp = pdf[0].render(scale=dpi / 72.0, rev_byteorder=True)
        arr = np.array(bmp.to_pil().convert("RGB"))
        pdf.close()
        return arr

    cmp = ImageComparator()
    for dpi in (150, 300):
        a, b = _render(goc, dpi), _render(binh, dpi)
        res = cmp.compare(a, b, tolerance="NORMAL", config={"dpi": dpi})
        assert res.diff_count >= 1, f"goc vs binh must flag diff @ {dpi} DPI (got 0)"


def test_padding_no_false_diff_on_size_mismatch():
    """#2: 2 ảnh khác kích thước nhưng cùng nội dung góc trên-trái → PAD (không
    resize-ép) nên KHÔNG sinh khác biệt giả toàn trang."""
    cmp = ImageComparator()
    a = _canvas_with_bar()                            # 300×400
    b = np.full((400, 400, 3), 255, np.uint8)         # cao hơn 100px, area 1.33× < 1.8
    b[50:100, 50:200] = (0, 0, 0)                     # cùng thanh đen, cùng vị trí
    res = cmp.compare(a, b, tolerance="NORMAL")
    assert res.is_imposition_mode is False
    assert res.similarity_score >= 99.0               # pad trắng khớp nhau → không diff giả


# ── So khi THAY ĐỔI KÍCH THƯỚC (audit so-sánh: A4↔A5, scale) ──
import cv2  # noqa: E402


def test_scaled_same_aspect_no_false_diff():
    """Case A: cùng thiết kế, cùng tỉ lệ khung, khác cỡ (chênh < 1.8×) → co giãn đều
    rồi so 1:1, KHÔNG báo khác biệt giả, KHÔNG vào chế độ bình bài."""
    cmp = ImageComparator()
    a = np.full((300, 400, 3), 255, np.uint8)
    a[60:120, 60:240] = 0
    b = cv2.resize(a, (320, 240), interpolation=cv2.INTER_AREA)  # thu nhỏ 0.8 (area 1.56×)
    res = cmp.compare(a, b, tolerance="NORMAL")
    assert res.is_imposition_mode is False
    assert res.similarity_score >= 90.0


def test_scaled_same_aspect_detects_real_change():
    """Case A vẫn BẮT được thay đổi thật khi đã đổi cỡ."""
    cmp = ImageComparator()
    a = np.full((300, 400, 3), 255, np.uint8)
    a[60:120, 60:240] = 0
    b = cv2.resize(a, (320, 240), interpolation=cv2.INTER_AREA)
    b[150:185, 180:280] = 0  # thêm ô CHỈ có ở B
    res = cmp.compare(a, b, tolerance="NORMAL")
    assert res.is_imposition_mode is False
    assert res.diff_count >= 1


def test_scaled_single_copy_via_multiscale_imposition():
    """Case B (đa tỉ lệ): 1 thiết kế bị PHÓNG TO (chênh ≥1.8×, cùng tỉ lệ khung) →
    dò mẫu đa tỉ lệ tìm thấy đúng 1 bản (không còn báo 'không tìm thấy')."""
    cmp = ImageComparator()
    templ = np.full((150, 200, 3), 255, np.uint8)
    templ[30:60, 40:160] = 0
    big = cv2.resize(templ, (300, 225), interpolation=cv2.INTER_AREA)  # phóng to 1.5× (area 2.25×)
    res = cmp.compare(templ, big, tolerance="NORMAL")
    assert res.is_imposition_mode is True
    assert res.total_instances >= 1
    # Tìm thấy bản → KHÔNG phải thông báo "không tìm thấy bản thiết kế"
    descs = " ".join(r.description for r in res.diff_regions)
    assert "Không tìm thấy" not in descs


# ── Phase 1–2: tolerance matrix, STRICT align, imposition instance pixel ──


def test_tolerance_matrix_catches_solid_black_patch():
    """STRICT/NORMAL/LOOSE × 150/300: ô đen rõ phải luôn bị bắt; identical = 0."""
    cmp = ImageComparator()
    for dpi in (150, 300):
        a = np.full((400, 400, 3), 255, np.uint8)
        b = a.copy()
        b[100:140, 100:160] = 0
        for tol in ("STRICT", "NORMAL", "LOOSE"):
            res = cmp.compare(a, b, tolerance=tol, config={"dpi": dpi})
            assert res.diff_count >= 1, f"tol={tol} dpi={dpi} must detect solid patch"
            same = cmp.compare(a, a.copy(), tolerance=tol, config={"dpi": dpi})
            assert same.diff_count == 0, f"identical must be clean tol={tol} dpi={dpi}"


def test_strict_detects_intentional_few_pixel_shift():
    """STRICT không registration → dịch nội dung 3px phải báo khác (trim/crop)."""
    cmp = ImageComparator()
    a = np.full((200, 200, 3), 255, np.uint8)
    a[40:80, 40:120] = 0
    b = np.full((200, 200, 3), 255, np.uint8)
    b[40:80, 43:123] = 0  # dịch +3px X
    res_s = cmp.compare(a, b, tolerance="STRICT", config={"dpi": 150})
    assert res_s.diff_count >= 1, "STRICT must flag intentional 3px shift"
    # NORMAL may align away small shift — either OK or still flag; just no crash
    res_n = cmp.compare(a, b, tolerance="NORMAL", config={"dpi": 150})
    assert res_n.similarity_score >= 0.0


def test_goc_binh_all_tolerances_and_dpi():
    """File thật nhãn: mọi tolerance × DPI chính phải ≥1 vùng (pixel-first)."""
    from pathlib import Path
    import pypdfium2 as pdfium

    root = Path(__file__).resolve().parents[2]
    goc, binh = root / "test" / "goc.pdf", root / "test" / "binh.pdf"
    if not goc.is_file() or not binh.is_file():
        pytest.skip("test fixtures missing")

    def _render(path, dpi):
        pdf = pdfium.PdfDocument(str(path))
        arr = np.array(pdf[0].render(scale=dpi / 72.0, rev_byteorder=True).to_pil().convert("RGB"))
        pdf.close()
        return arr

    cmp = ImageComparator()
    for dpi in (150, 300):
        a, b = _render(goc, dpi), _render(binh, dpi)
        for tol in ("STRICT", "NORMAL", "LOOSE"):
            res = cmp.compare(a, b, tolerance=tol, config={"dpi": dpi})
            assert res.diff_count >= 1, f"goc/binh miss tol={tol} dpi={dpi}"


def test_imposition_flags_changed_instance():
    """N-up: 4 bản match; 1 bản sửa nhỏ (vẫn matchTemplate) → failed_instances ≥ 1."""
    cmp = ImageComparator()
    templ = np.full((100, 120, 3), 255, np.uint8)
    templ[10:90, 10:110] = 230
    templ[20:50, 20:100] = 40
    templ[55:75, 30:90] = 0
    templ[80:90, 15:105] = 80

    sheet = np.full((220, 260, 3), 255, np.uint8)
    positions = [(5, 5), (5, 130), (110, 5), (110, 130)]
    for yy, xx in positions:
        sheet[yy:yy + 100, xx:xx + 120] = templ
    # Sửa nhỏ trên bản #4 — đủ để pixel bắt, không phá match ≥0.82
    sheet[110 + 60:110 + 72, 130 + 50:130 + 70] = 255

    res = cmp.compare(templ, sheet, tolerance="NORMAL", config={"dpi": 150})
    assert res.is_imposition_mode is True
    assert res.total_instances >= 4
    assert res.failed_instances >= 1
    assert res.diff_count >= 1


def test_imposition_tiled_preview_detection_matches_full_frame_verdict():
    """Bình bài tile chỉ đọc ROI nhưng giữ instance/statistics/vùng lỗi."""
    cmp = ImageComparator()
    templ = np.full((100, 120, 3), 255, np.uint8)
    templ[10:90, 10:110] = 230
    templ[20:50, 20:100] = 40
    templ[55:75, 30:90] = 0
    sheet = np.full((220, 260, 3), 255, np.uint8)
    positions = [(5, 5), (5, 130), (110, 5), (110, 130)]
    for yy, xx in positions:
        sheet[yy:yy + 100, xx:xx + 120] = templ
    sheet[110 + 60:110 + 72, 130 + 50:130 + 70] = 255

    full = cmp.compare(templ, sheet, tolerance="NORMAL", config={"dpi": 150})

    def read_sheet(x, y, width, height):
        return sheet[y:y + height, x:x + width].copy()

    tiled = cmp.compare_imposition_tiled(
        templ,
        read_sheet,
        sheet.shape[1],
        sheet.shape[0],
        preview_template=templ,
        preview_imposed=sheet,
        tolerance="NORMAL",
        config={"dpi": 150},
    )

    assert tiled.is_imposition_mode is True
    assert tiled.total_instances == full.total_instances
    assert tiled.failed_instances == full.failed_instances
    assert tiled.match_scale == full.match_scale
    assert tiled.diff_count == full.diff_count
    assert [
        (r.x, r.y, r.width, r.height, r.description)
        for r in tiled.diff_regions
    ] == [
        (r.x, r.y, r.width, r.height, r.description)
        for r in full.diff_regions
    ]


def test_imposition_tiled_artifact_keeps_tracking_boxes(tmp_path, monkeypatch):
    """PNG stripe của bình bài giữ khung xanh/đỏ như overlay full-frame."""
    import cv2
    from app.config import settings
    from app.core.highlight_renderer import HighlightRenderer

    cmp = ImageComparator()
    templ = np.full((100, 120, 3), 255, np.uint8)
    templ[10:90, 10:110] = 230
    templ[20:50, 20:100] = 40
    sheet = np.full((220, 260, 3), 255, np.uint8)
    for yy, xx in [(5, 5), (5, 130), (110, 5), (110, 130)]:
        sheet[yy:yy + 100, xx:xx + 120] = templ
    sheet[170:182, 180:200] = 255
    full = cmp.compare(templ, sheet, tolerance="NORMAL", config={"dpi": 150})

    tiled = cmp.compare_imposition_tiled(
        templ,
        lambda x, y, width, height: sheet[y:y + height, x:x + width].copy(),
        sheet.shape[1],
        sheet.shape[0],
        preview_template=templ,
        preview_imposed=sheet,
        tolerance="NORMAL",
        config={"dpi": 150},
    )
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    HighlightRenderer().save_tiled_highlight_image(
        lambda x, y, width, height: sheet[y:y + height, x:x + width].copy(),
        tiled.diff_regions,
        sheet.shape[1],
        sheet.shape[0],
        "imposition-artifact",
        1,
        stripe_height=31,
        tracking_boxes=tiled._imposition_tracking_boxes,
        imposition_mode=True,
    )
    artifact = cv2.imread(
        str(tmp_path / "imposition-artifact" / "page_1_diff.png"),
        cv2.IMREAD_COLOR,
    )
    assert np.array_equal(artifact, cv2.cvtColor(full.highlighted_image, cv2.COLOR_RGB2BGR))



def test_identical_fast_path_skips_ssim_and_artifacts(monkeypatch):
    """Byte-identical pages skip SSIM, highlight, and GIF generation."""
    import app.core.image_comparator as comparator_module

    def _unexpected_ssim(*_args, **_kwargs):
        raise AssertionError("identical fast path must not call SSIM")

    monkeypatch.setattr(comparator_module, "ssim", _unexpected_ssim)
    image = _canvas_with_bar()
    result = ImageComparator().compare(
        image, image.copy(), tolerance="NORMAL", config={"dpi": 300}
    )

    assert result.similarity_score == 100.0
    assert result.diff_count == 0
    assert result.diff_mask.shape == image.shape[:2]
    assert result.highlighted_image is None
    assert result.gif_image is None


def test_ssim_uses_bounded_preview_but_pixel_diff_keeps_full_resolution(monkeypatch):
    """SSIM is preview-only while the verdict mask stays full resolution."""
    import app.core.image_comparator as comparator_module

    real_ssim = comparator_module.ssim
    seen_shapes = []

    def _capture_ssim(a, b, **kwargs):
        seen_shapes.append((a.shape, b.shape, kwargs))
        return real_ssim(a, b, **kwargs)

    monkeypatch.setattr(comparator_module, "ssim", _capture_ssim)
    a = np.full((1200, 1800, 3), 255, np.uint8)
    b = a.copy()
    b[500:560, 800:920] = 0

    result = ImageComparator().compare(
        a,
        b,
        tolerance="NORMAL",
        config={"dpi": 300, "ssim_max_side": 512},
    )

    assert seen_shapes
    assert max(seen_shapes[0][0]) <= 512
    assert seen_shapes[0][2].get("full") is False
    assert result.diff_mask.shape == a.shape[:2]
    assert result.diff_count >= 1


def test_spotlight_frames_are_bounded_before_full_frame_copies():
    """GIF preview frames are downscaled before they are duplicated."""
    from app.core.image_comparator import DiffRegion

    cmp = ImageComparator()
    image = np.full((1800, 2400, 3), 255, np.uint8)
    off, on = cmp._create_spotlight_frames(
        image,
        [DiffRegion(x=1000, y=700, width=200, height=120, severity="high")],
    )

    assert off.shape == on.shape
    assert max(off.shape[:2]) <= 1200

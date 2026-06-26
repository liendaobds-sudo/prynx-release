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

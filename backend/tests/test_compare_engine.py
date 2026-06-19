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

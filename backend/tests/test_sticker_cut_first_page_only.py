import io
import time
import pikepdf
import pytest
from app.workers.sticker_engine import StickerEngine


def _make_sample_multipage_pdf(num_pages: int = 5) -> bytes:
    """Tạo một file PDF mẫu num_pages trang, mỗi trang có một hình tròn đỏ ở giữa."""
    doc = pikepdf.Pdf.new()
    pw, ph = 200.0, 200.0
    for i in range(num_pages):
        page = doc.add_blank_page(page_size=(pw, ph))
        # Vẽ một hình tròn đỏ đường kính 100pt ở giữa trang
        # re: x y w h, or c: beziers
        content = (
            f"q\n"
            f"1 0 0 rg\n"  # red fill
            f"50 50 100 100 re\n"  # square box
            f"f\n"
            f"Q\n"
        ).encode("ascii")
        page.contents_add(pikepdf.Stream(doc, content))
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def _has_cutcontour(page: pikepdf.Page) -> bool:
    """Kiểm tra trang có khai báo hoặc chứa Separation CutContour hay không."""
    res = page.get("/Resources")
    if not res:
        return False
    cs = res.get("/ColorSpace")
    if not cs:
        return False
    if "/CutContour" in cs:
        return True
    for key, val in cs.items():
        if isinstance(val, pikepdf.Array) and len(val) > 1 and str(val[1]) == "/CutContour":
            return True
    return False


def test_cut_first_page_only_no_bleed(tmp_path):
    """Khi cut_first_page_only=True và bleed_mm=0:
    - Trang 1 có CutContour
    - Các trang 2..N bỏ qua tính toán, không có CutContour, copy nguyên bản
    - all_pages_meta đánh dấu cut_first_page_skipped
    - Tốc độ hoàn thành cực nhanh
    """
    in_pdf = tmp_path / "multi_input.pdf"
    out_pdf = tmp_path / "multi_output.pdf"
    in_pdf.write_bytes(_make_sample_multipage_pdf(num_pages=5))

    engine = StickerEngine(dpi=150)
    t0 = time.perf_counter()
    success, meta = engine.process_pdf(
        input_path=str(in_pdf),
        output_path=str(out_pdf),
        cut_mode="original",
        offset_mm=1.0,
        corner_style="preserve",
        bleed_mm=0.0,
        draw_cut_contour=True,
        cut_first_page_only=True,
    )
    elapsed = time.perf_counter() - t0

    assert success is True
    assert out_pdf.exists()

    with pikepdf.open(str(out_pdf)) as doc:
        assert len(doc.pages) == 5
        # Trang 1 PHẢI có CutContour
        assert _has_cutcontour(doc.pages[0]) is True
        # Các trang 2..5 KHÔNG ĐƯỢC CÓ CutContour
        for p_idx in range(1, 5):
            assert _has_cutcontour(doc.pages[p_idx]) is False, f"Trang {p_idx + 1} không được có CutContour"

    # Kiểm tra metadata
    pages_meta = meta.get("pages", [])
    assert len(pages_meta) == 5
    # Trang 1 được xử lý bình thường
    assert pages_meta[0].get("cut_first_page_skipped") is not True
    # Các trang 2..5 được đánh dấu skipped
    for p_idx in range(1, 5):
        assert pages_meta[p_idx].get("cut_first_page_skipped") is True
        assert pages_meta[p_idx].get("page") == p_idx + 1


def test_cut_first_page_only_with_bleed(tmp_path):
    """Khi cut_first_page_only=True và bleed_mm=2.0:
    - Trang 1 có CutContour và có bù xén
    - Các trang 2..N có bù xén nhưng KHÔNG CÓ CutContour
    - Bước fit Bézier được bỏ qua trên trang 2..N
    """
    in_pdf = tmp_path / "multi_bleed_input.pdf"
    out_pdf = tmp_path / "multi_bleed_output.pdf"
    in_pdf.write_bytes(_make_sample_multipage_pdf(num_pages=3))

    engine = StickerEngine(dpi=150)
    success, meta = engine.process_pdf(
        input_path=str(in_pdf),
        output_path=str(out_pdf),
        cut_mode="original",
        offset_mm=1.0,
        corner_style="round",
        bleed_mm=2.0,
        draw_cut_contour=True,
        cut_first_page_only=True,
    )

    assert success is True
    assert out_pdf.exists()

    with pikepdf.open(str(out_pdf)) as doc:
        assert len(doc.pages) == 3
        # Trang 1 có CutContour
        assert _has_cutcontour(doc.pages[0]) is True
        # Trang 2, 3 KHÔNG có CutContour
        assert _has_cutcontour(doc.pages[1]) is False
        assert _has_cutcontour(doc.pages[2]) is False

        # Các trang 2, 3 đều có khổ mở rộng do có bù xén
        # Khổ ban đầu 200x200 pt, có bù xén thì kích thước page box sẽ nở ra
        assert float(doc.pages[1].mediabox[2]) - float(doc.pages[1].mediabox[0]) >= 200.0


def test_cut_first_page_only_false_has_cutline_on_all_pages(tmp_path):
    """Khi cut_first_page_only=False (mặc định):
    - Mọi trang đều có CutContour
    """
    in_pdf = tmp_path / "all_pages_input.pdf"
    out_pdf = tmp_path / "all_pages_output.pdf"
    in_pdf.write_bytes(_make_sample_multipage_pdf(num_pages=3))

    engine = StickerEngine(dpi=150)
    success, meta = engine.process_pdf(
        input_path=str(in_pdf),
        output_path=str(out_pdf),
        cut_mode="original",
        offset_mm=1.0,
        corner_style="preserve",
        bleed_mm=0.0,
        draw_cut_contour=True,
        cut_first_page_only=False,
    )

    assert success is True
    with pikepdf.open(str(out_pdf)) as doc:
        assert len(doc.pages) == 3
        for p_idx in range(3):
            assert _has_cutcontour(doc.pages[p_idx]) is True, f"Trang {p_idx + 1} phải có CutContour khi cut_first_page_only=False"

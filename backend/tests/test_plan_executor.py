"""Test cho PlanExecutor — sink render booklet ở backend (đường /imposition/execute-plan-json).

Trước đây KHÔNG có test cho lớp này (audit #B1). Các test:
  - Đếm trang output đúng số mặt có nội dung.
  - Bỏ qua trang trắng/padding (source_page < 0).
  - Vị trí + HƯỚNG đặt trang đúng (xác minh bằng RASTER, không bằng công thức) —
    quy ước y là bottom-up (rawY của TS serializer) ↔ pike_y = sheet_h - y - dest_h.
  - Marks giữ màu CMYK (toán tử `K`), KHÔNG quy đổi RGB (audit #B2).
"""
import asyncio
import io
import os

import pytest

from app.workers import pdf_wrapper as pdf_lib
from app.core.plan_executor import PlanExecutor
from app.core.imposition_page_box import effective_imposition_box


def _make_source(tmp_path, specs):
    """specs: list of ('tophalf'|'smalltl'|'plain') → 1 trang 100x100pt mỗi spec."""
    doc = pdf_lib.open()
    for kind in specs:
        pg = doc.new_page(width=100, height=100)
        sh = pg.new_shape()
        if kind == 'tophalf':
            sh.draw_rect(pdf_lib.Rect(0, 0, 100, 50))  # nửa trên (top-down draw)
        elif kind == 'smalltl':
            sh.draw_rect(pdf_lib.Rect(0, 0, 30, 30))
        else:
            sh.draw_rect(pdf_lib.Rect(10, 10, 90, 90))
        sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
        sh.commit()
    p = str(tmp_path / "src.pdf")
    buf = io.BytesIO(); doc.save(buf); doc.close()
    open(p, 'wb').write(buf.getvalue())
    return p


def _plan(src, out_dir, sheets):
    return {
        "version": "1.0", "source_pdf_path": src, "output_dir": out_dir,
        "global": {}, "sheets": sheets,
    }


def _run(plan, src):
    return asyncio.run(PlanExecutor.execute(plan, src))


def test_renders_one_page_per_nonempty_side(tmp_path):
    src = _make_source(tmp_path, ['plain', 'plain'])
    out_dir = str(tmp_path / "out")
    plan = _plan(src, out_dir, [{
        "sheet_index": 0, "width_pt": 200, "height_pt": 200,
        "front": {"placements": [{"source_page": 0, "x_pt": 10, "y_pt": 10, "scale": 1.0}], "marks": []},
        "back": {"placements": [{"source_page": 1, "x_pt": 10, "y_pt": 10, "scale": 1.0}], "marks": []},
    }])
    out = _run(plan, src)
    doc = pdf_lib.open(out)
    assert doc.page_count == 2  # front + back
    doc.close()


def test_skips_blank_padding_pages(tmp_path):
    src = _make_source(tmp_path, ['plain'])
    out_dir = str(tmp_path / "out")
    # front có 1 placement hợp lệ + 1 trang trắng (source_page=-1) → chỉ vẽ 1, không crash.
    plan = _plan(src, out_dir, [{
        "sheet_index": 0, "width_pt": 200, "height_pt": 200,
        "front": {"placements": [
            {"source_page": 0, "x_pt": 10, "y_pt": 10, "scale": 1.0},
            {"source_page": -1, "x_pt": 110, "y_pt": 10, "scale": 1.0},
        ], "marks": []},
    }])
    out = _run(plan, src)
    doc = pdf_lib.open(out)
    assert doc.page_count == 1
    doc.close()


def test_appends_separated_cover_pages_at_original_size(tmp_path):
    src = _make_source(tmp_path, ['plain', 'plain', 'plain'])
    out_dir = str(tmp_path / 'out')
    plan = _plan(src, out_dir, [{
        'sheet_index': 0, 'width_pt': 200, 'height_pt': 200,
        'front': {'placements': [{'source_page': 1, 'x_pt': 10, 'y_pt': 10, 'scale': 1.0}], 'marks': []},
    }])
    plan['append_source_pages'] = [
        {'source_page': 0, 'rotation_deg': 0},
        {'source_page': 2, 'rotation_deg': 0},
    ]
    out = _run(plan, src)
    doc = pdf_lib.open(out)
    assert doc.page_count == 3
    assert round(doc[1].rect.width) == 100
    assert round(doc[1].rect.height) == 100
    assert round(doc[2].rect.width) == 100
    assert round(doc[2].rect.height) == 100
    doc.close()


def test_large_cropbox_difference_is_the_logical_booklet_page(tmp_path):
    import pikepdf
    pdfium = pytest.importorskip('pypdfium2')

    # MediaBox contains two logical 100x100 pages. CropBox selects the right one.
    # This mirrors exports where alternating booklet pages occupy left/right halves
    # of one large design canvas.
    doc = pdf_lib.open()
    pg = doc.new_page(width=200, height=100)
    sh = pg.new_shape()
    sh.draw_rect(pdf_lib.Rect(100, 0, 200, 100))
    sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
    sh.commit()
    pg._page.CropBox = pikepdf.Array([100, 0, 200, 100])
    src = str(tmp_path / 'split_canvas.pdf')
    buf = io.BytesIO(); doc.save(buf); doc.close()
    open(src, 'wb').write(buf.getvalue())

    check = pdf_lib.open(src)
    box = effective_imposition_box(check[0])
    assert round(box.width) == 100
    assert round(box.height) == 100
    check.close()

    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0, 'width_pt': 100, 'height_pt': 100,
        'front': {'placements': [{
            'source_page': 0, 'x_pt': 0, 'y_pt': 0, 'scale': 1.0,
            'rotation_deg': 0, 'native_angle': 0,
            'clip': {'x_pt': 0, 'y_pt': 0, 'w_pt': 100, 'h_pt': 100},
        }], 'marks': []},
    }])
    out = _run(plan, src)
    rendered = pdfium.PdfDocument(out)[0].render(scale=2.0).to_pil().convert('L')
    dark_fraction = sum(rendered.histogram()[:80]) / (rendered.width * rendered.height)
    assert dark_fraction > 0.80


def test_page_position_and_orientation_no_yflip(tmp_path):
    """Đặt trang nửa-trên-đen lên ĐỈNH tờ (y bottom-up) → raster phải thấy đen ở TRÊN."""
    pdfium = pytest.importorskip("pypdfium2")
    src = _make_source(tmp_path, ['tophalf'])
    out_dir = str(tmp_path / "out")
    # sheet 200; dest 100x100; đặt page top == sheet top ⇒ y bottom-up = 200-100 = 100.
    plan = _plan(src, out_dir, [{
        "sheet_index": 0, "width_pt": 200, "height_pt": 200,
        "front": {"placements": [{"source_page": 0, "x_pt": 50, "y_pt": 100, "scale": 1.0}], "marks": []},
    }])
    out = _run(plan, src)

    doc = pdfium.PdfDocument(out)
    pil = doc[0].render(scale=3.0).to_pil().convert('L')
    W, H = pil.size
    px = pil.load()

    def frac(x0, y0, x1, y1):
        tot = dk = 0
        for y in range(max(0, y0), min(H, y1)):
            for x in range(max(0, x0), min(W, x1)):
                tot += 1
                if px[x, y] < 100:
                    dk += 1
        return dk / max(1, tot)

    s = 3.0
    # Ô đặt tại x50..150, top-down y 0..100.
    top_q = frac(int(50*s), int(0*s), int(150*s), int(25*s))
    bot_q = frac(int(50*s), int(50*s), int(150*s), int(75*s))
    below = frac(int(50*s), int(100*s), int(150*s), int(200*s))
    doc.close()

    assert top_q > 0.8, f"nửa trên ô phải đen (source top-half), được {top_q}"
    assert bot_q < 0.2, f"nửa dưới ô phải trắng, được {bot_q}"
    assert below < 0.1, f"nửa dưới tờ phải trống (trang chỉ ở nửa trên), được {below}"


def test_marks_preserved_as_cmyk_not_rgb(tmp_path):
    """Marks màu CMYK [0,0,0,1] phải xuất bằng toán tử `K` (không quy đổi RGB `RG`)."""
    import pikepdf
    src = _make_source(tmp_path, ['plain'])
    out_dir = str(tmp_path / "out")
    plan = _plan(src, out_dir, [{
        "sheet_index": 0, "width_pt": 200, "height_pt": 200,
        "front": {"placements": [{"source_page": 0, "x_pt": 10, "y_pt": 10, "scale": 1.0}],
                  "marks": [{"type": "trim_line", "x1": 5, "y1": 5, "x2": 5, "y2": 15,
                             "color": [0, 0, 0, 1], "thickness_pt": 0.25}]},
    }])
    out = _run(plan, src)
    pdf = pikepdf.open(out)
    page0 = pdf.pages[0]
    streams = b""
    contents = page0.get("/Contents")
    if isinstance(contents, pikepdf.Array):
        for s in contents:
            streams += s.read_bytes()
    else:
        streams = contents.read_bytes()
    pdf.close()
    text = streams.decode('latin-1', errors='replace')
    # Phải có set màu CMYK stroke ('K') với giá trị 0 0 0 1 (định dạng float của finish()).
    assert "0.0 0.0 0.0 1.0 K" in text, f"marks phải dùng CMYK K-only, không phải RGB. Got: {text!r}"
    # Không được quy đổi sang RGB stroke ('RG') cho mark đen.
    assert "0.0 0.0 0.0 RG" not in text


def test_uses_mediabox_not_trimbox_for_parity(tmp_path):
    """Audit 🔴 parity: /pdf-meta báo kích thước theo MediaBox nên PlanExecutor PHẢI vẽ
    trang theo MediaBox, không phải TrimBox. File in sẵn (TrimBox < MediaBox) nếu vẽ theo
    TrimBox sẽ ra trang nhỏ hơn kế hoạch → lệch gáy/dấu xén. Xác minh bằng RASTER."""
    import pikepdf
    pdfium = pytest.importorskip("pypdfium2")

    # Trang MediaBox 120x120, nội dung đen phủ kín, TrimBox thu vào 100x100 (bleed 10pt).
    doc = pdf_lib.open()
    pg = doc.new_page(width=120, height=120)
    sh = pg.new_shape()
    sh.draw_rect(pdf_lib.Rect(0, 0, 120, 120))
    sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
    sh.commit()
    buf = io.BytesIO(); doc.save(buf); doc.close()

    src = str(tmp_path / "src_trim.pdf")
    with pikepdf.open(io.BytesIO(buf.getvalue())) as p:
        p.pages[0].TrimBox = [10, 10, 110, 110]
        p.save(src)

    out_dir = str(tmp_path / "out")
    plan = _plan(src, out_dir, [{
        "sheet_index": 0, "width_pt": 200, "height_pt": 200,
        "front": {"placements": [{"source_page": 0, "x_pt": 0, "y_pt": 80, "scale": 1.0}], "marks": []},
    }])
    out = _run(plan, src)

    d = pdfium.PdfDocument(out)
    pil = d[0].render(scale=2.0).to_pil().convert('L')
    W, H = pil.size
    px = pil.load()
    minx = W; miny = H; maxx = 0; maxy = 0; found = False
    for y in range(H):
        for x in range(W):
            if px[x, y] < 100:
                found = True
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
    d.close()

    assert found, "phải có vùng đen"
    s = 2.0
    w_pt = (maxx - minx) / s
    h_pt = (maxy - miny) / s
    # MediaBox-draw ⇒ ~120; TrimBox-draw (lỗi cũ) ⇒ ~100. Cho dung sai raster ±3pt.
    assert abs(w_pt - 120) < 3, f"phải vẽ theo MediaBox (w~120), được {w_pt:.1f}"
    assert abs(h_pt - 120) < 3, f"phải vẽ theo MediaBox (h~120), được {h_pt:.1f}"

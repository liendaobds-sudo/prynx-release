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
from app.core.plan_executor import PlanExecutionError, PlanExecutor
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


def _make_user_unit_source(tmp_path, *, rotate=0, user_unit=2.0):
    """Tạo trang có bốn mốc góc để bắt lỗi phóng/cắt lặp `/UserUnit`."""
    import pikepdf

    src = str(tmp_path / f'user-unit-{user_unit}-r{rotate}.pdf')
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 50))
    page.obj[pikepdf.Name('/UserUnit')] = user_unit
    if rotate:
        page.obj[pikepdf.Name('/Rotate')] = rotate
    page.obj[pikepdf.Name('/Contents')] = pdf.make_stream(
        b'0 g '
        b'2 2 10 10 re f 88 2 10 10 re f '
        b'2 38 10 10 re f 88 38 10 10 re f\n'
    )
    pdf.save(src)
    pdf.close()
    return src


def _dark_fraction_by_quadrant(path, content_rect):
    """Đo artifact raster; mỗi góc nguồn phải còn hiện trong một phần tư đích."""
    pdfium = pytest.importorskip('pypdfium2')

    doc = pdfium.PdfDocument(path)
    image = doc[0].render(scale=2.0).to_pil().convert('L')
    doc.close()
    x0, y0, x1, y1 = (int(round(value * 2.0)) for value in content_rect)
    mid_x = (x0 + x1) // 2
    mid_y = (y0 + y1) // 2
    pixels = image.load()

    def dark_fraction(bounds):
        left, top, right, bottom = bounds
        dark = sum(
            pixels[x, y] < 80
            for y in range(top, bottom)
            for x in range(left, right)
        )
        return dark / max(1, (right - left) * (bottom - top))

    return [
        dark_fraction(bounds)
        for bounds in (
            (x0, y0, mid_x, mid_y),
            (mid_x, y0, x1, mid_y),
            (x0, mid_y, mid_x, y1),
            (mid_x, mid_y, x1, y1),
        )
    ]


def _capture_show_pdf_page_rotations(monkeypatch):
    """Ghi đúng góc đến sink; bổ sung cho artifact bốn góc vốn đối xứng."""
    captured = []
    original = pdf_lib.Page.show_pdf_page

    def recording_show_pdf_page(self, *args, **kwargs):
        rotate = kwargs.get("rotate", args[3] if len(args) > 3 else 0)
        captured.append(int(rotate) % 360)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(pdf_lib.Page, "show_pdf_page", recording_show_pdf_page)
    return captured


@pytest.mark.parametrize('rotate', [0, 90, 180, 270])
def test_user_unit_is_applied_once_for_booklet_placements(tmp_path, rotate):
    """PAGEBOX (audit 2026-08-04 §W1.PB3): không phóng/cắt lặp UserUnit."""
    src = _make_user_unit_source(tmp_path, rotate=rotate)
    content_w, content_h = ((100, 200) if rotate in (90, 270) else (200, 100))
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': content_w + 20,
        'height_pt': content_h + 20,
        'front': {'placements': [{
            'source_page': 0,
            'x_pt': 10,
            'y_pt': 10,
            'scale': 1.0,
            'rotation_deg': 0,
            'native_angle': rotate,
        }], 'marks': []},
    }])

    output = _run(plan, src)
    fractions = _dark_fraction_by_quadrant(
        output,
        (10, 10, 10 + content_w, 10 + content_h),
    )
    assert min(fractions) > 0.02, fractions


@pytest.mark.parametrize('rotate', [90, 180, 270])
def test_native_rotation_is_applied_once_for_booklet_placements(tmp_path, rotate):
    """Matrix của Form đã có /Rotate; sink không được xoay nội dung lần hai."""
    src = _make_user_unit_source(tmp_path, rotate=rotate, user_unit=1.0)
    content_w, content_h = ((50, 100) if rotate in (90, 270) else (100, 50))
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': content_w + 20,
        'height_pt': content_h + 20,
        'front': {'placements': [{
            'source_page': 0,
            'x_pt': 10,
            'y_pt': 10,
            'scale': 1.0,
            'rotation_deg': 0,
            'native_angle': rotate,
        }], 'marks': []},
    }])

    output = _run(plan, src)
    fractions = _dark_fraction_by_quadrant(
        output,
        (10, 10, 10 + content_w, 10 + content_h),
    )
    assert min(fractions) > 0.02, fractions


def test_user_rotation_survives_page_space_canonicalization(tmp_path):
    """Góc người dùng phải còn nguyên sau khi bỏ phần /Rotate đã bake."""
    src = _make_user_unit_source(tmp_path, rotate=90, user_unit=2.0)
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': 220,
        'height_pt': 120,
        'front': {'placements': [{
            'source_page': 0,
            'x_pt': 10,
            'y_pt': 10,
            'scale': 1.0,
            'rotation_deg': 0,
            # /Rotate gốc 90° + góc người dùng 90°.
            'native_angle': 180,
        }], 'marks': []},
    }])

    output = _run(plan, src)
    fractions = _dark_fraction_by_quadrant(output, (10, 10, 210, 110))
    assert min(fractions) > 0.02, fractions


@pytest.mark.parametrize('native_rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('user_rotation', [0, 90, 180, 270])
def test_user_rotation_reaches_booklet_sink_exactly_once(
    tmp_path,
    monkeypatch,
    native_rotation,
    user_rotation,
):
    """Góc sink phải đúng hướng, không chỉ giữ được nội dung đối xứng bốn góc."""
    captured = _capture_show_pdf_page_rotations(monkeypatch)
    src = _make_user_unit_source(tmp_path, rotate=native_rotation, user_unit=2.0)
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': 240,
        'height_pt': 240,
        'front': {'placements': [{
            'source_page': 0,
            'x_pt': 10,
            'y_pt': 10,
            'scale': 1.0,
            'rotation_deg': 0,
            'native_angle': native_rotation + user_rotation,
        }], 'marks': []},
    }])

    _run(plan, src)

    assert captured == [user_rotation]


def test_user_unit_is_applied_once_through_phase2(tmp_path):
    """Step & Repeat hai pha phải dùng cùng trang nguồn đã chuẩn hóa."""
    src = _make_user_unit_source(tmp_path, user_unit=2.0)
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': 220,
        'height_pt': 120,
        'front': {'placements': [{
            'source_page': 0,
            'x_pt': 10,
            'y_pt': 10,
            'scale': 1.0,
            'rotation_deg': 0,
            'native_angle': 0,
        }], 'marks': []},
    }])
    plan['phase2'] = {
        'mode': 'step_repeat',
        'spread_w_pt': 220,
        'spread_h_pt': 120,
        'plates': [{
            'width_pt': 220,
            'height_pt': 120,
            'placements': [{
                'spread_index': 0,
                'x_pt': 0,
                'y_pt': 0,
                'rotation_deg': 0,
            }],
            'marks': [],
        }],
    }

    output = _run(plan, src)
    fractions = _dark_fraction_by_quadrant(output, (10, 10, 210, 110))
    assert min(fractions) > 0.02, fractions


def test_user_rotation_reaches_phase2_source_sink_exactly_once(tmp_path, monkeypatch):
    captured = _capture_show_pdf_page_rotations(monkeypatch)
    src = _make_user_unit_source(tmp_path, rotate=90, user_unit=2.0)
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': 220,
        'height_pt': 120,
        'front': {'placements': [{
            'source_page': 0,
            'x_pt': 10,
            'y_pt': 10,
            'scale': 1.0,
            'rotation_deg': 0,
            'native_angle': 360,  # /Rotate gốc 90° + góc người dùng 270°.
        }], 'marks': []},
    }])
    plan['phase2'] = {
        'mode': 'step_repeat',
        'spread_w_pt': 220,
        'spread_h_pt': 120,
        'plates': [{
            'width_pt': 220,
            'height_pt': 120,
            'placements': [{
                'spread_index': 0, 'x_pt': 0, 'y_pt': 0, 'rotation_deg': 0,
            }],
            'marks': [],
        }],
    }

    _run(plan, src)

    assert captured == [270, 0]


@pytest.mark.parametrize('rotate', [0, 90])
def test_user_unit_is_applied_once_for_detached_pages(tmp_path, rotate):
    """Trang bìa tách riêng cũng phải giữ đủ bốn góc và đúng khổ vật lý."""
    src = _make_user_unit_source(tmp_path, rotate=rotate)
    expected_w, expected_h = ((100, 200) if rotate == 90 else (200, 100))
    plan = _plan(src, str(tmp_path / 'out'), [])
    plan['append_source_pages'] = [{'source_page': 0, 'rotation_deg': 0}]

    output = _run(plan, src)
    doc = pdf_lib.open(output)
    assert (doc[0].rect.width, doc[0].rect.height) == pytest.approx(
        (expected_w, expected_h),
    )
    doc.close()
    fractions = _dark_fraction_by_quadrant(output, (0, 0, expected_w, expected_h))
    assert min(fractions) > 0.02, fractions


def test_user_rotation_reaches_detached_page_sink_exactly_once(tmp_path, monkeypatch):
    captured = _capture_show_pdf_page_rotations(monkeypatch)
    src = _make_user_unit_source(tmp_path, rotate=90, user_unit=2.0)
    plan = _plan(src, str(tmp_path / 'out'), [])
    plan['append_source_pages'] = [{'source_page': 0, 'rotation_deg': 270}]

    _run(plan, src)

    assert captured == [270]


def test_invalid_source_rotation_fails_closed(tmp_path):
    """Không được ép `/Rotate=45` thành 0 ở validator rồi thành 270 ở canonicalizer."""
    src = _make_user_unit_source(tmp_path, rotate=45, user_unit=2.0)
    plan = _plan(src, str(tmp_path / 'out'), [])
    plan['append_source_pages'] = [{'source_page': 0, 'rotation_deg': 0}]

    with pytest.raises(PlanExecutionError, match=r"Trang 1 có /Rotate không hợp lệ: 45"):
        PlanExecutor._execute_sync(plan, src)


def test_page_space_canonicalization_failure_stops_wrong_output(tmp_path, monkeypatch):
    """Không được âm thầm dùng file thô khi chốt chuẩn hóa UserUnit thất bại."""
    from app.workers import nup_engine

    src = _make_user_unit_source(tmp_path, user_unit=2.0)
    monkeypatch.setattr(
        nup_engine,
        '_canonicalize_page_space',
        lambda source_path, job_id=None: (source_path, False),
    )
    plan = _plan(src, str(tmp_path / 'out'), [])
    plan['append_source_pages'] = [{'source_page': 0, 'rotation_deg': 0}]

    with pytest.raises(PlanExecutionError, match='dừng để tránh xuất sai kích thước'):
        PlanExecutor._execute_sync(plan, src)


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


def test_stamps_multiline_book_report_on_every_output_side(tmp_path):
    from pypdf import PdfReader

    src = _make_source(tmp_path, ['plain', 'plain'])
    plan = _plan(src, str(tmp_path / 'out'), [{
        'sheet_index': 0,
        'width_pt': 500,
        'height_pt': 300,
        'front': {'placements': [{'source_page': 0, 'x_pt': 20, 'y_pt': 20, 'scale': 1.0}], 'marks': []},
        'back': {'placements': [{'source_page': 1, 'x_pt': 20, 'y_pt': 20, 'scale': 1.0}], 'marks': []},
    }])
    plan['book_report'] = {
        'enabled': True,
        'text': 'DH-001 - TAP CHI THANG 7 - 96 TRANG\nRUOT FORT 80 GSM - BIA C300 GSM',
        'position': 'top',
        'offset_x_mm': 5,
        'offset_y_mm': 5,
        'font_size': 8,
        'centered': True,
    }
    plan['append_source_pages'] = [{'source_page': 0, 'rotation_deg': 0}]

    out = _run(plan, src)
    reader = PdfReader(out)

    assert len(reader.pages) == 3
    for page in reader.pages[:2]:
        text = page.extract_text() or ''
        assert 'DH-001' in text
        assert 'FORT 80 GSM' in text
    detached_cover_text = reader.pages[2].extract_text() or ''
    assert 'DH-001' not in detached_cover_text

"""Kiểm chứng RENDER THẬT: tem tròn xếp lồng không còn đè artwork lên tem bên cạnh.

Dựng 1 trang nguồn phủ KÍN mực (worst case: artwork tràn hết MediaBox, vượt xa
đường bế tròn), đặt 2 tem so le sao cho BBOX chồng nhau, rồi soi pixel tại điểm
nằm trong bbox tem A nhưng thuộc phần tem B → phải TRẮNG.
"""

import math
import os
import tempfile

import pikepdf
import pytest

from app.workers import pdf_wrapper as pdf_lib
from app.workers.nup_artwork import place_one_artwork
from app.workers.pdf_types import Point, Rect

R = 40.0          # bán kính tem tròn (pt)
GAP = 6.0         # khoảng cách 2 khuôn (pt)
BLEED = 8.0       # bleed cài đặt (pt) — lớn hơn nửa gap để test kẹp
SHEET = 400.0
MARGIN = 4.0      # artwork tràn ra ngoài đường bế trên trang nguồn (pt)


@pytest.fixture()
def workdir():
    with tempfile.TemporaryDirectory() as d:
        yield d


def _circle_items(cx, cy, r, segments=72):
    items = []
    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        items.append((
            'l',
            Point(cx + r * math.cos(a0), cy + r * math.sin(a0)),
            Point(cx + r * math.cos(a1), cy + r * math.sin(a1)),
        ))
    return items


def _make_full_ink_page(path, size):
    """Trang nguồn: đổ đen TOÀN BỘ MediaBox (mô phỏng artwork + slug tràn lề)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(size, size))
    page.contents_add(pikepdf.Stream(
        pdf, f"q 0 0 0 rg 0 0 {size} {size} re f Q".encode("ascii")
    ))
    pdf.save(path)
    pdf.close()


def _placement(abs_x, abs_y, w, h):
    return {
        'cluster_idx': 0,
        'cell': {'x': abs_x, 'y': abs_y, 'width': w, 'height': h,
                 'isRotated': False, 'isRotated180': False, 'blockId': 0},
        'src_page_idx': 0,
        'abs_x': abs_x,
        'abs_y': abs_y,
        'width': w,
        'height': h,
        'original_cell_y': abs_y,
    }


def _impose(workdir, *, shape_clip):
    """Đặt 2 tem tròn so le lên 1 tờ. Trả (đường dẫn output, toạ độ 2 ô)."""
    src_path = os.path.join(workdir, "src.pdf")
    # Trang nguồn LỚN hơn đường bế → có artwork thật nằm ngoài khuôn để clip xử lý.
    _make_full_ink_page(src_path, 2 * R + 2 * MARGIN)

    die_rect = Rect(MARGIN, MARGIN, MARGIN + 2 * R, MARGIN + 2 * R)
    items = _circle_items(MARGIN + R, MARGIN + R, R)

    step = 2 * R + GAP
    dy = math.sqrt(step ** 2 - (step / 2) ** 2)   # xếp so le kiểu hex
    cells = [(60.0, 60.0), (60.0 + step / 2.0, 60.0 + dy)]

    src_doc = pdf_lib.open(src_path)
    out_doc = pdf_lib.open()
    out_page = out_doc.new_page(width=SHEET, height=SHEET)

    placements = [_placement(x, y, 2 * R, 2 * R) for x, y in cells]
    block_bbox = {}
    for p in placements:
        k = (0, 0)
        x0, y0 = p['abs_x'], p['original_cell_y']
        x1, y1 = x0 + p['width'], y0 + p['height']
        if k not in block_bbox:
            block_bbox[k] = [x0, y0, x1, y1]
        else:
            bb = block_bbox[k]
            bb[0] = min(bb[0], x0); bb[1] = min(bb[1], y0)
            bb[2] = max(bb[2], x1); bb[3] = max(bb[3], y1)

    clip_off = min(GAP / 2.0, BLEED)
    for p in placements:
        place_one_artwork(
            out_page, src_doc, p,
            bleed_pt=BLEED, is_die_cut=True, cut_type='default',
            separate_cut_page=False, local_stripped_pages=set(),
            job_id="t", diecut_geom_cache={}, die_items_cache={},
            max_geom_cache=8, block_bbox=block_bbox,
            clip_off_x=clip_off, clip_off_y=clip_off,
            find_largest_die_path=lambda _p: {
                'items': items, 'rect': die_rect,
                'color': (0, 0, 0), 'width': 0.5, 'spot_name': None,
            },
            shape_clip=shape_clip,
        )

    out_path = os.path.join(workdir, f"out_{int(shape_clip)}.pdf")
    out_doc.save(out_path)
    out_doc.close()
    src_doc.close()
    return out_path, cells


def _raw(path, idx=0):
    data = b""
    with pikepdf.Pdf.open(path) as pdf:
        contents = pdf.pages[idx].obj.get("/Contents")
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        for s in streams:
            data += s.read_bytes()
    return data.decode("latin-1")


def _render_gray(path, scale=3.0):
    import numpy as np
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    try:
        bitmap = doc[0].render(scale=scale)
        arr = np.asarray(bitmap.to_pil().convert("L"))
    finally:
        doc.close()
    return arr, scale


def _probe(arr, scale, x, y):
    """Giá trị xám tại điểm (x, y) toạ độ trang TOP-DOWN."""
    return int(arr[int(y * scale), int(x * scale)])


def test_clip_theo_hinh_duoc_ghi_vao_content_stream(workdir):
    """Có clip theo hình → stream dùng path `m/l/h W n` thay vì chỉ `re W n`."""
    out_shape, _ = _impose(workdir, shape_clip=True)
    out_rect, _ = _impose(workdir, shape_clip=False)

    raw_shape = _raw(out_shape)
    raw_rect = _raw(out_rect)

    assert "W n" in raw_rect and " m\n" not in raw_rect
    assert " m\n" in raw_shape and " l\n" in raw_shape


def test_tem_tron_xep_lech_khong_de_artwork_len_tem_ben_canh(workdir):
    """Góc bbox tem A (vùng phế của xếp lồng) phải SẠCH — trước đây bị mực đè."""
    out_shape, cells = _impose(workdir, shape_clip=True)
    out_rect, _ = _impose(workdir, shape_clip=False)

    (ax, ay), (bx, by) = cells
    ca = (ax + R, ay + R)
    cb = (bx + R, by + R)

    # Góc dưới-phải bbox tem A, lùi 2pt: nằm trong ô A nhưng cách CẢ HAI khuôn
    # xa hơn nửa gap → là vùng phế, không tem nào được phép có mực ở đây.
    probe = (ax + 2 * R - 2.0, ay + 2.0)
    limit = R + GAP / 2.0
    assert math.hypot(probe[0] - ca[0], probe[1] - ca[1]) > limit
    assert math.hypot(probe[0] - cb[0], probe[1] - cb[1]) > limit

    arr_shape, s1 = _render_gray(out_shape)
    arr_rect, s2 = _render_gray(out_rect)

    assert _probe(arr_rect, s2, *probe) < 128, (
        "tiền đề: clip bbox cũ PHẢI để mực tràn vào vùng này (đây là lỗi gốc)"
    )
    assert _probe(arr_shape, s1, *probe) > 240, (
        "clip theo hình vẫn để artwork đè sang tem bên cạnh"
    )


def test_tam_tem_van_du_muc_sau_khi_clip(workdir):
    """Không được cắt lẹm vào tem: tâm và sát trong đường bế phải còn mực."""
    out_shape, cells = _impose(workdir, shape_clip=True)
    arr, s = _render_gray(out_shape)

    for cx, cy in [(x + R, y + R) for x, y in cells]:
        assert _probe(arr, s, cx, cy) < 128, "tâm tem bị mất mực"
        # Sát trong biên khuôn (còn 1pt) → vẫn phải có mực.
        assert _probe(arr, s, cx + R - 1.5, cy) < 128, "biên tem bị cắt lẹm"


def test_bleed_theo_hinh_duoc_giu_den_nua_gap(workdir):
    """Bleed vẫn còn: ngay ngoài đường bế (trong nửa gap) phải có mực."""
    out_shape, cells = _impose(workdir, shape_clip=True)
    arr, s = _render_gray(out_shape)

    cx, cy = cells[0][0] + R, cells[0][1] + R
    # 1pt ngoài khuôn, còn trong nửa gap (GAP/2 = 3pt) → thuộc vùng bleed hợp lệ.
    assert _probe(arr, s, cx - R - 1.0, cy) < 128, "mất bleed sát ngoài đường bế"

"""RESIZE (audit 2026-08-06 §G.1): trang /Rotate≠0 không được mất nội dung khi co giãn.

Bug gốc: resize_pages đọc MediaBox CHƯA hoán chiều theo /Rotate và tạo Form
XObject có /BBox theo khổ chưa xoay + /Matrix lật → nội dung vượt BBox bị clip.
Đo thực tế trên trang A4 /Rotate=90 có 4 dấu góc: chỉ còn 2/4 dấu.

Test dựng trang có 4 ô đỏ ở 4 góc, resize về khổ vuông rồi render đếm cụm đỏ.
Kỳ vọng: đủ 4 dấu ở mọi góc xoay 0/90/180/270, và khổ ra đúng khổ đích.
"""
import os

import pikepdf
import pytest

from app.workers.pdf_tools_engine import resize_pages

MM_TO_PTS = 2.83465
MARK = 40.0  # pt — cạnh ô dấu góc
A4_W, A4_H = 595.0, 842.0


def _make_marked_page(path: str, rotate: int) -> None:
    """Trang A4 với 4 ô đỏ ở 4 góc, đặt /Rotate theo tham số."""
    doc = pikepdf.Pdf.new()
    page = doc.add_blank_page(page_size=(A4_W, A4_H))
    boxes = [
        (0.0, 0.0),
        (A4_W - MARK, 0.0),
        (0.0, A4_H - MARK),
        (A4_W - MARK, A4_H - MARK),
    ]
    ops = ["q 1 0 0 rg"]
    for x, y in boxes:
        ops.append(f"{x:.2f} {y:.2f} {MARK:.2f} {MARK:.2f} re f")
    ops.append("Q")
    page.contents_add(pikepdf.Stream(doc, " ".join(ops).encode("ascii")))
    if rotate:
        page.obj[pikepdf.Name("/Rotate")] = rotate
    doc.save(path)
    doc.close()


def _count_red_clusters(pdf_path: str, scale: float = 2.0) -> int:
    """Render trang 1 rồi đếm số cụm pixel đỏ liên thông (4-neighbour)."""
    pypdfium2 = pytest.importorskip("pypdfium2")
    doc = pypdfium2.PdfDocument(pdf_path)
    try:
        bitmap = doc[0].render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
    finally:
        doc.close()

    width, height = image.size
    pixels = image.load()

    def is_red(px):
        r, g, b = px
        return r > 150 and g < 100 and b < 100

    seen = set()
    clusters = 0
    for y in range(height):
        for x in range(width):
            if (x, y) in seen or not is_red(pixels[x, y]):
                continue
            clusters += 1
            stack = [(x, y)]
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen:
                        if is_red(pixels[nx, ny]):
                            seen.add((nx, ny))
                            stack.append((nx, ny))
    return clusters


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_resize_giu_du_4_dau_goc_khi_trang_xoay(tmp_path, rotate):
    src = str(tmp_path / f"src_{rotate}.pdf")
    out = str(tmp_path / f"out_{rotate}.pdf")
    _make_marked_page(src, rotate)

    resize_pages(src, out, 100.0, 100.0, scale_mode="fit", apply_to="all")

    assert os.path.exists(out)
    assert _count_red_clusters(out) == 4, f"/Rotate={rotate} bị clip mất dấu góc"


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_resize_ra_dung_kho_dich_khi_trang_xoay(tmp_path, rotate):
    src = str(tmp_path / f"src_{rotate}.pdf")
    out = str(tmp_path / f"out_{rotate}.pdf")
    _make_marked_page(src, rotate)

    resize_pages(src, out, 100.0, 100.0, scale_mode="fit", apply_to="all")

    with pikepdf.Pdf.open(out) as doc:
        page = doc.pages[0]
        mb = page.mediabox
        assert float(mb[2] - mb[0]) == pytest.approx(100.0 * MM_TO_PTS, abs=0.1)
        assert float(mb[3] - mb[1]) == pytest.approx(100.0 * MM_TO_PTS, abs=0.1)
        # Sau bake, trang đích không được mang /Rotate thừa.
        assert int(page.obj.get("/Rotate", 0) or 0) % 360 == 0


def test_resize_ty_le_fit_tinh_theo_kho_da_xoay(tmp_path):
    """Trang A4 dọc /Rotate=90 = khổ ngang 842×595 → fit vào 200×100mm phải
    lấp đầy chiều rộng (tỉ lệ tính trên khổ ĐÃ xoay, không phải MediaBox thô)."""
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _make_marked_page(src, 90)

    resize_pages(src, out, 200.0, 100.0, scale_mode="fit", apply_to="all")

    assert _count_red_clusters(out) == 4

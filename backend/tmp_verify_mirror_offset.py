"""Script kiểm chứng TẠM — đo lệch toạ độ khi bình file mirror-bleed.

Chạy: venv\\Scripts\\python.exe tmp_verify_mirror_offset.py
Xoá sau khi audit xong.
"""
import os
import re
import tempfile

import pikepdf

from app.core.page_boxes import PageBoxesEngine
from app.workers.pdf_ops import Rect, show_pdf_page

TRIM_W, TRIM_H = 200.0, 100.0
BLEED_MM = 3.0
PT = 2.834645669


def make_src(path):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(TRIM_W, TRIM_H))
    page = pdf.pages[0]
    # Ô vuông đánh dấu góc dưới-trái của vùng thành phẩm.
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"1 0 0 RG 2 w 0 0 m 20 0 l 0 20 l h S\n"
    )
    pdf.save(path)
    pdf.close()


def main():
    tmp = tempfile.mkdtemp(prefix="px_mirror_")
    src = os.path.join(tmp, "src.pdf")
    make_src(src)

    eng = PageBoxesEngine()
    out = eng.add_mirror_bleed(src, BLEED_MM, None)
    print("== Page box sau mirror-bleed ==")
    with pikepdf.Pdf.open(out) as pdf:
        pg = pdf.pages[0]
        for key in ("/MediaBox", "/CropBox", "/BleedBox", "/TrimBox", "/ArtBox"):
            print(f"  {key:10s} {[float(v) for v in pg.obj[key]]}" if key in pg.obj else f"  {key:10s} (không có)")
        mb = [float(v) for v in pg.obj["/MediaBox"]]

    b = BLEED_MM * PT
    print(f"\n  bleed = {b:.4f}pt; gốc MediaBox = ({mb[0]:.4f}, {mb[1]:.4f})")

    # Đặt trang mirror vào một tờ, tại ô có gốc (100, 100), đúng khổ file nguồn.
    src_w = mb[2] - mb[0]
    src_h = mb[3] - mb[1]
    with pikepdf.Pdf.open(out) as src_pdf:
        dest = pikepdf.Pdf.new()
        dest.add_blank_page(page_size=(600, 400))
        dest_page = dest.pages[0]
        cell = Rect(100.0, 100.0, 100.0 + src_w, 100.0 + src_h)
        show_pdf_page(dest, dest_page, cell, src_pdf, 0)
        _c = dest_page.obj["/Contents"]
        if isinstance(_c, pikepdf.Array):
            raw = b"\n".join(bytes(s.read_bytes()) for s in _c).decode("latin-1")
        else:
            raw = bytes(_c.read_bytes()).decode("latin-1")

    m = re.findall(r"([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm", raw)
    print("\n== Ma trận cm sinh ra khi đặt tem ==")
    for mm in m:
        print("  ", " ".join(mm), "cm")

    if not m:
        print("  !! không tìm thấy cm")
        return

    a, bb, c, d, e, f = (float(v) for v in m[-1])
    dest_h = 400.0
    # Nội dung nguồn trải từ mb[0]..mb[2]. Muốn góc dưới-trái vùng bleed nằm đúng
    # tại cell.x0 thì phép biến đổi phải đưa x=mb[0] về cell.x0:
    #   e_dung = cell.x0 - mb[0]*a
    e_dung = 100.0 - mb[0] * a
    # Trục y của PDF trong show_pdf_page dùng hệ top-down: y_dest = dest_h - rect.y1
    f_dung = (dest_h - cell.y1) - mb[1] * d
    print("\n== Đối chiếu ==")
    print(f"  e  thực tế = {e:.4f} | đúng phải = {e_dung:.4f} | lệch = {e - e_dung:+.4f} pt")
    print(f"  f  thực tế = {f:.4f} | đúng phải = {f_dung:.4f} | lệch = {f - f_dung:+.4f} pt")
    print(f"  scale = {a:.6f} x {d:.6f}")
    print(f"\n  => lệch mỗi trục {abs(e - e_dung) / PT:.3f} mm (bleed = {BLEED_MM} mm)")


if __name__ == "__main__":
    main()

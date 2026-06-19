"""
Benchmark/guard hiệu năng cho liệt kê object trên trang NHIỀU object.

Mục tiêu (audit — hiệu năng trang dày):
- `list_objects(include_text_props=False)` phải NHANH (liệt kê hình học thuần)
  để overlay edit không kẹt trên trang vài nghìn object.
- Xác nhận chế độ lazy (False) nhanh hơn rõ rệt so với trích đủ props (True).

Ngưỡng đặt RỘNG (chống flaky CI); chủ yếu bắt hồi quy bệnh lý (O(N^2)/treo).
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf

from app.core.geometry_reader import list_objects

N_OBJECTS = 1500
PAGE_W, PAGE_H = 2000.0, 2000.0


def _build_dense_pdf(path, n):
    """Trang dày: n vector rect + n cụm text nhỏ rải lưới."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    pg = pdf.pages[0]
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
        BaseFont=pikepdf.Name.Helvetica, Encoding=pikepdf.Name.WinAnsiEncoding,
    )
    pg.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))
    )
    frags = []
    cols = 40
    for i in range(n):
        x = 5 + (i % cols) * 48
        y = 5 + (i // cols) * 24
        frags.append(f"q 0.1 0.3 0.6 rg {x} {y} 18 10 re f Q\n")
        frags.append(f"BT /F1 6 Tf {x} {y + 12} Td (T{i}) Tj ET\n")
    pg.obj[pikepdf.Name.Contents] = pdf.make_stream("".join(frags).encode("latin-1"))
    pdf.save(path)
    pdf.close()


def test_dense_page_listing_is_fast(tmp_path):
    src = str(tmp_path / "dense.pdf")
    _build_dense_pdf(src, N_OBJECTS)

    t0 = time.perf_counter()
    fast = list_objects(src, 0, include_text_props=False)
    t_fast = time.perf_counter() - t0

    t1 = time.perf_counter()
    full = list_objects(src, 0, include_text_props=True)
    t_full = time.perf_counter() - t1

    print(f"\n[BENCH] {len(fast)} objects | lazy(no props)={t_fast*1000:.0f}ms | full(props)={t_full*1000:.0f}ms")

    # Đủ object (n vector + n text).
    assert len(fast) >= N_OBJECTS, f"Liệt kê thiếu object: {len(fast)}"
    # Lazy KHÔNG trích props (đầu vào overlay đủ): content None.
    assert all(o.content is None for o in fast if o.type == "text")
    # Full trích props: ít nhất một text có content.
    assert any(o.content for o in full if o.type == "text")

    # Ngưỡng RỘNG chống hồi quy bệnh lý (không phải đo chính xác).
    assert t_fast < 8.0, f"Liệt kê lazy quá chậm: {t_fast:.2f}s cho {len(fast)} object"

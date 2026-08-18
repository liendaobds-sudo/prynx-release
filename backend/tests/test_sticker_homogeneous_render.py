"""End-to-end RENDER test (Task 7.2 / §6.2 audit) — chế độ ĐỒNG NHẤT chạy THẬT.

Khác các test khác (dừng ở precalc bằng StopEngine, hoặc so dữ liệu trung gian),
test này CHẠY TRỌN `run_nup_engine` → PDF thật → RASTER hoá → đo ARTIFACT:
  (1) Nhánh đồng nhất THỰC SỰ kích hoạt trên PDF có khuôn magenta (master) +
      trang nội dung lệch vị trí (build_homogeneous_layout được gọi).
  (2) Output render KHÔNG trắng/không sập; nội dung được đặt (registration thật
      qua show_pdf_page clip+keep_proportion).
  (3) Registration CĂN TÂM: nội dung lệch trên trang gốc → trên output nằm trong
      ô khuôn (không bị đẩy ra mép theo độ lệch gốc).

Chạy: backend/venv/Scripts/python.exe -m pytest tests/test_sticker_homogeneous_render.py
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pytest.importorskip("pikepdf")
pytest.importorskip("pypdfium2")
import numpy as np

from app.workers import pdf_wrapper as pdf_lib
from app.workers import nup_engine
from app.workers import sticker_homogeneous as sh


def _make_homogeneous_pdf(path: str) -> None:
    """Trang 0 = khuôn magenta (die) 80x80; trang 1..3 = ô đen 40x40 LỆCH vị trí."""
    doc = pdf_lib.open()
    # Master: đường bế magenta CMYK (0,1,0,0) — die_colors mặc định của DetectionConfig.
    m = doc.new_page(width=100.0, height=100.0)
    s = m.new_shape()
    s.draw_rect(pdf_lib.Rect(10.0, 10.0, 90.0, 90.0))
    s.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)  # stroke magenta = khuôn
    s.commit()
    # Nội dung: ô đen 40x40, mỗi trang lệch một kiểu (mô phỏng tem lệch trên trang).
    for off in (5.0, 25.0, 45.0):
        c = doc.new_page(width=100.0, height=100.0)
        sc = c.new_shape()
        sc.draw_rect(pdf_lib.Rect(off, off, off + 40.0, off + 40.0))
        sc.finish(color=(0.0, 0.0, 0.0, 1.0), fill=(0.0, 0.0, 0.0, 1.0))
        sc.commit()
    doc.save(path)
    doc.close()


def _raster(path: str, page_idx: int = 0, dpi: int = 72):
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(path)
    try:
        page = pdf[page_idx]
        bmp = page.render(scale=dpi / 72.0, rotation=0)
        arr = np.array(bmp.to_pil().convert('RGB'))
    finally:
        pdf.close()
    return arr


def test_homogeneous_end_to_end_real_render(tmp_path, monkeypatch):
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _make_homogeneous_pdf(src)

    # Spy: build_homogeneous_layout (wrap gốc) để xác nhận nhánh đồng nhất kích hoạt.
    spy = {"build": 0}
    _orig = sh.build_homogeneous_layout

    def _spy_build(*a, **k):
        spy["build"] += 1
        return _orig(*a, **k)

    monkeypatch.setattr(nup_engine.__dict__.get("sticker_homogeneous", sh) if hasattr(nup_engine, "sticker_homogeneous") else sh,
                        "build_homogeneous_layout", _spy_build, raising=False)
    monkeypatch.setattr(sh, "build_homogeneous_layout", _spy_build)

    settings = {
        "isDieCutMode": True,
        "sheetWidth": 200, "sheetHeight": 200,
        "targetQuantity": 0, "targetQuantitiesByPage": {},
        "detectedShapesByPage": {"0": "RECTANGLE"},
        "gridStrategy": "optimal_auto", "groupingStrategy": "maximize_area",
        "pontType": "none", "bleed": 0,
    }
    nup_engine.run_nup_engine(src, out, settings, job_id="t-e2e")

    # (1) Nhánh đồng nhất đã kích hoạt trên PDF khuôn magenta thật.
    assert spy["build"] == 1, "build_homogeneous_layout phải được gọi (detection khuôn magenta)"

    # (2) Output tồn tại + render được + có NỘI DUNG ĐEN (content), không sập.
    # LƯU Ý: sheetWidth/Height là MM (×2.83465) → tờ 200mm ≈ 567pt, KHÔNG phải 200pt.
    assert os.path.exists(out)
    arr = _raster(out, 0, dpi=72)
    R = arr[:, :, 0].astype(int); G = arr[:, :, 1].astype(int); Bc = arr[:, :, 2].astype(int)
    black_mask = (R < 100) & (G < 100) & (Bc < 100)   # chỉ nội dung đen (loại magenta khuôn)
    black = int(black_mask.sum())
    H, W = black_mask.shape
    assert black > 0, "sheet 0 phải có nội dung ĐEN được render (registration thật)"

    # (3) Auto-fill chia khối 4 mẫu (master + 3 nội dung đen) trên đủ 49 ô.
    # Khoảng 3/4 ô là nội dung đen và mỗi nội dung được clip + co ĐẦY ô khuôn 80pt,
    # nên tỉ lệ mực đen đo được xấp xỉ 0.70. Dải dưới bắt ô bị DROP/trắng; dải trên
    # vẫn bắt registration hỏng kéo nội dung phủ kín toàn trang.
    frac = black / float(H * W)
    assert 0.45 <= frac <= 0.90, (
        f"tỉ lệ mực đen={frac:.3f} (đo) bất thường — quá thấp=ô bị bỏ/trắng, "
        f"quá cao=registration hỏng (kéo full trang)")

    # (3b) bbox đen trải ~3 ô theo phương dàn (nesting so le/hàng), không co cụm 1 điểm.
    ys, xs = np.where(black_mask)
    span_x = (xs.max() - xs.min()) / float(W)
    span_y = (ys.max() - ys.min()) / float(H)
    assert max(span_x, span_y) >= 0.25, (
        f"nội dung co cụm bất thường (span_x={span_x:.2f}, span_y={span_y:.2f}) "
        f"— các ô auto-fill phải trải theo phương dàn")


def test_homogeneous_nup_preserves_output_intent_for_sampled_bleed(tmp_path):
    """Bình tem phải giữ profile CMYK để artwork và bleed ICC không lệch màu.

    Bù xén lấy mẫu được lưu ICCBased sRGB, trong khi artwork gốc có thể là
    DeviceCMYK dựa vào OutputIntent của tài liệu. Nếu chunk bình tạo PDF trắng
    mà bỏ catalog OutputIntent, hai lớp sẽ bị diễn giải bằng hai profile khác
    sau khi bình dù file bù xén riêng lẻ vẫn đúng màu.
    """
    import pikepdf

    src = str(tmp_path / "source-with-output-intent.pdf")
    out = str(tmp_path / "imposed-with-output-intent.pdf")
    _make_homogeneous_pdf(src)
    profile_bytes = b"PrynX CMYK profile regression sentinel"
    with pikepdf.Pdf.open(src, allow_overwriting_input=True) as source:
        profile = source.make_stream(profile_bytes)
        profile[pikepdf.Name("/N")] = 4
        intent = source.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OutputIntent"),
            "/S": pikepdf.Name("/GTS_PDFX"),
            "/OutputConditionIdentifier": "PrynX-CMYK-Test",
            "/DestOutputProfile": profile,
        }))
        source.Root[pikepdf.Name("/OutputIntents")] = pikepdf.Array([intent])
        source.save(src)

    nup_engine.run_nup_engine(src, out, {
        "isDieCutMode": True,
        "sheetWidth": 200,
        "sheetHeight": 200,
        "targetQuantity": 0,
        "targetQuantitiesByPage": {},
        "detectedShapesByPage": {"0": "RECTANGLE"},
        "gridStrategy": "optimal_auto",
        "groupingStrategy": "maximize_area",
        "pontType": "none",
        "bleed": 0,
    }, job_id="t-output-intent")

    with pikepdf.Pdf.open(out) as imposed:
        intents = imposed.Root.get("/OutputIntents")
        assert intents and len(intents) == 1
        assert str(intents[0].get("/OutputConditionIdentifier")) == "PrynX-CMYK-Test"
        assert intents[0].get("/DestOutputProfile").read_bytes() == profile_bytes


def _page_count(path: str) -> int:
    import pikepdf
    with pikepdf.Pdf.open(path) as pdf:
        return len(pdf.pages)


def test_homogeneous_separate_cut_single_page_at_end(tmp_path):
    """homogeneous + separate_cut_page → CHỈ 1 trang khuôn duy nhất ở CUỐI file.

    Trước đây mỗi tờ sinh 1 trang khuôn (xen kẽ artwork1,cut1,artwork2,cut2…) →
    tổng = 2×N. Nay chỉ 1 trang khuôn ở cuối → tổng = N+1. Trang cuối là khuôn
    (có nét bế magenta, KHÔNG có nội dung đen); các trang trước là artwork (có đen).
    """
    src = str(tmp_path / "src.pdf")
    _make_homogeneous_pdf(src)

    base_settings = {
        "isDieCutMode": True,
        "sheetWidth": 200, "sheetHeight": 200,
        "targetQuantity": 0, "targetQuantitiesByPage": {},
        "detectedShapesByPage": {"0": "RECTANGLE"},
        "gridStrategy": "optimal_auto", "groupingStrategy": "maximize_area",
        "pontType": "none", "bleed": 0,
    }

    # (A) KHÔNG tách khuôn → N trang artwork (khuôn vẽ ngay trên trang in).
    out_no = str(tmp_path / "out_nocut.pdf")
    nup_engine.run_nup_engine(src, out_no, {**base_settings, "separateCutPage": False}, job_id="t-nocut")
    n_artwork = _page_count(out_no)
    assert n_artwork >= 1

    # (B) CÓ tách khuôn → đúng N+1 trang (KHÔNG phải 2N).
    out_cut = str(tmp_path / "out_cut.pdf")
    nup_engine.run_nup_engine(src, out_cut, {**base_settings, "separateCutPage": True}, job_id="t-cut")
    n_with_cut = _page_count(out_cut)
    assert n_with_cut == n_artwork + 1, (
        f"homogeneous+tách khuôn phải = {n_artwork}+1 trang (1 khuôn duy nhất), "
        f"nhận {n_with_cut} (2×N = mỗi tờ 1 khuôn = bug cũ)")

    # (C) TRANG CUỐI = khuôn: có nét bế (mực bất kỳ, không trắng), KHÔNG có nội dung đen.
    # dpi cao hơn để nét bế mảnh (1pt) không bị khử răng cưa mất hẳn. Kiểm "có mực"
    # (non-white) thay vì màu cụ thể: màu bế có thể là magenta gốc HOẶC đỏ fallback
    # (màu vô hình → engine đổi sang đỏ CMYK để nhìn thấy) — cả hai đều là nét bế hợp lệ.
    last = _raster(out_cut, n_with_cut - 1, dpi=200)
    R = last[:, :, 0].astype(int); G = last[:, :, 1].astype(int); Bc = last[:, :, 2].astype(int)
    black_last = int(((R < 100) & (G < 100) & (Bc < 100)).sum())
    ink_last = int(((R < 230) | (G < 230) | (Bc < 230)).sum())  # bất kỳ pixel không trắng
    assert black_last == 0, "trang khuôn cuối KHÔNG được chứa nội dung đen (chỉ nét bế)"
    assert ink_last > 0, "trang khuôn cuối phải có nét bế (mực) được vẽ"

    # (D) TRANG ĐẦU = artwork: có nội dung đen.
    first = _raster(out_cut, 0, dpi=72)
    R0 = first[:, :, 0].astype(int); G0 = first[:, :, 1].astype(int); B0 = first[:, :, 2].astype(int)
    black_first = int(((R0 < 100) & (G0 < 100) & (B0 < 100)).sum())
    assert black_first > 0, "trang đầu phải là artwork (có nội dung đen)"


def test_single_mold_repeat_has_one_cut_page_only_at_end(tmp_path):
    """Bình trang chung một khuôn: [trang in...] + đúng một trang khuôn cuối."""
    src = str(tmp_path / "repeat-src.pdf")
    _make_homogeneous_pdf(src)

    base_settings = {
        "isDieCutMode": True,
        "layoutType": "repeat",
        "sheetWidth": 200,
        "sheetHeight": 200,
        "targetQuantity": 8,
        "targetQuantitiesByPage": {"0": 8, "1": 8, "2": 8, "3": 8},
        "exportUniqueSheets": True,
        "detectedShapesByPage": {"0": "RECTANGLE"},
        "gridStrategy": "optimal_auto",
        "groupingStrategy": "none",
        "pontType": "none",
        "bleed": 0,
    }

    out_no_cut = str(tmp_path / "repeat-no-cut.pdf")
    nup_engine.run_nup_engine(
        src,
        out_no_cut,
        {**base_settings, "separateCutPage": False},
        job_id="t-repeat-no-cut",
    )
    artwork_pages = _page_count(out_no_cut)
    assert artwork_pages == 4

    out_cut = str(tmp_path / "repeat-one-final-cut.pdf")
    nup_engine.run_nup_engine(
        src,
        out_cut,
        {**base_settings, "separateCutPage": True},
        job_id="t-repeat-one-final-cut",
    )
    page_count = _page_count(out_cut)
    assert page_count == artwork_pages + 1, (
        "single-mold repeat phải có N trang in + đúng 1 trang khuôn; "
        f"nhận {page_count} trang cho {artwork_pages} trang in"
    )

    # Trang in cuối vẫn là artwork, chứng minh khuôn không còn xen kẽ.
    last_art = _raster(out_cut, artwork_pages - 1, dpi=72)
    black_art = int((
        (last_art[:, :, 0] < 100)
        & (last_art[:, :, 1] < 100)
        & (last_art[:, :, 2] < 100)
    ).sum())
    assert black_art > 0

    # Chỉ trang cuối cùng là khuôn: có mực nét bế, không có artwork đen.
    cut = _raster(out_cut, page_count - 1, dpi=200)
    red = cut[:, :, 0].astype(int)
    green = cut[:, :, 1].astype(int)
    blue = cut[:, :, 2].astype(int)
    black_cut = int(((red < 100) & (green < 100) & (blue < 100)).sum())
    ink_cut = int(((red < 230) | (green < 230) | (blue < 230)).sum())
    assert black_cut == 0
    assert ink_cut > 0

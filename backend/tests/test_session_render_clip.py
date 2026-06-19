"""
Unit tests cho `render_clip` (Task 3.2 — spec `pdf-edit-session`).

Kiểm phần LOGIC của Incremental_Render trong `app/core/edit_session.py`:
- Tính Clip_Region (gộp CŨ+MỚI cho move/add, None cho delete) + lề + kẹp Page_Box.
- Quy đổi Clip_Region tuyệt đối → gốc Page_Box-relative (trừ [bx0, by0]) — gồm
  trường hợp CropBox lệch gốc (chống regression tọa độ — Yêu cầu 4.1, 4.2).
- `render_clip` trả `(preview data-URI, clipRect, full)`; delete → full-page;
  move/add → clip có giới hạn.

KHÔNG dùng mock: dựng PDF thật trong RAM, render thật bằng PDFium (read-only).
Lưu ý: tương đương pixel clip ↔ full (Property 6) thuộc integration test 3.2/3.3.

_Requirements: 3.2, 3.3, 3.5, 3.6, 4.1, 4.2_
"""
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf

from app.core import edit_session
from app.core.edit_session import (
    EditSession,
    _compute_clip_region,
    _read_page_box,
    _union_bbox,
    render_clip,
)
from app.schemas.edit import EditOp, MoveDelta as Delta
from app.schemas.edit import ResizeScale, TextPayload


# ── Helpers dựng PDF / phiên giả lập ─────────────────────────────────────────
def _build_pdf_bytes(page_w=400.0, page_h=300.0, cropbox=None) -> bytes:
    """Dựng PDF 1 trang, 1 vector rect; tùy chọn CropBox lệch gốc."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(page_w, page_h))
    page = pdf.pages[0]
    stream = (
        b"q\n0.1 0.2 0.6 rg\n100 80 60 40 re\nf\nQ\n"
    )
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(stream)
    if cropbox is not None:
        page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array([float(v) for v in cropbox])
    from io import BytesIO
    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


def _make_session(pdf_bytes: bytes) -> EditSession:
    """Tạo EditSession TRỰC TIẾP (không qua open_session/DB) cho test render."""
    from io import BytesIO
    pdf = pikepdf.Pdf.open(BytesIO(pdf_bytes))
    return EditSession(
        session_id="test-sid",
        source_fid="fid-test",
        source_path="<memory>",
        pdf=pdf,
        baseline_bytes=pdf_bytes,
        lock=threading.Lock(),
        live_bytes=pdf_bytes,
    )


# ═══════════════════════════════════════════════════════════════════════════
#  _union_bbox
# ═══════════════════════════════════════════════════════════════════════════
def test_union_bbox_empty_returns_none():
    assert _union_bbox([]) is None
    assert _union_bbox([[], None]) is None


def test_union_bbox_combines_extents():
    u = _union_bbox([[10, 10, 20, 20], [15, 5, 30, 18]])
    assert u == [10, 5, 30, 20]


# ═══════════════════════════════════════════════════════════════════════════
#  _compute_clip_region
# ═══════════════════════════════════════════════════════════════════════════
PAGE_BOX = [0.0, 0.0, 400.0, 300.0]


def test_clip_region_delete_is_none():
    """Delete → vùng không xác định giới hạn → None (render toàn trang)."""
    op = EditOp(kind="delete", page=0, targetIds=["a"])
    region = _compute_clip_region(op, {"bboxes": [], "oldBboxes": [[10, 10, 50, 50]]},
                                  PAGE_BOX, clip_pad=8.0)
    assert region is None


def test_clip_region_move_unions_old_and_new_with_pad():
    """Move gộp CŨ + MỚI + lề; kết quả bao cả hai vùng."""
    op = EditOp(kind="move", page=0, targetIds=["a"], delta=Delta(dx=30, dy=0))
    region = _compute_clip_region(
        op,
        {"bboxes": [[130, 80, 190, 120]], "oldBboxes": [[100, 80, 160, 120]]},
        PAGE_BOX, clip_pad=8.0,
    )
    # union = [100,80,190,120]; +pad 8 mỗi cạnh = [92,72,198,128]
    assert region == [92.0, 72.0, 198.0, 128.0]


def test_clip_region_add_uses_new_only():
    """Add chỉ có vùng MỚI (oldBboxes rỗng)."""
    op = EditOp(kind="add", page=0, targetIds=[],
                text=TextPayload(content="hi", bbox=[200, 100, 260, 140]))
    region = _compute_clip_region(
        op, {"bboxes": [[200, 100, 260, 140]], "oldBboxes": []},
        PAGE_BOX, clip_pad=10.0,
    )
    assert region == [190.0, 90.0, 270.0, 150.0]


def test_clip_region_clamped_to_page_box():
    """Lề vượt ra ngoài Page_Box bị kẹp lại trong khung trang."""
    op = EditOp(kind="move", page=0, targetIds=["a"], delta=Delta(dx=0, dy=0))
    region = _compute_clip_region(
        op, {"bboxes": [[0, 0, 20, 20]], "oldBboxes": [[0, 0, 20, 20]]},
        PAGE_BOX, clip_pad=8.0,
    )
    # [-8,-8,28,28] kẹp về [0,0,28,28]
    assert region == [0.0, 0.0, 28.0, 28.0]


def test_clip_region_none_page_box_returns_none():
    op = EditOp(kind="move", page=0, targetIds=["a"], delta=Delta(dx=0, dy=0))
    assert _compute_clip_region(op, {"bboxes": [[1, 1, 2, 2]], "oldBboxes": []},
                                None, clip_pad=8.0) is None


def test_clip_region_no_bbox_returns_none():
    """Không có bbox hợp lệ → vùng không xác định → None."""
    op = EditOp(kind="resize", page=0, targetIds=["a"],
                scale=ResizeScale(sx=1.5, sy=1.5, anchor="sw"))
    assert _compute_clip_region(op, {"bboxes": [], "oldBboxes": []},
                                PAGE_BOX, clip_pad=8.0) is None


# ═══════════════════════════════════════════════════════════════════════════
#  _read_page_box (CropBox / MediaBox)
# ═══════════════════════════════════════════════════════════════════════════
def test_read_page_box_defaults_to_mediabox():
    from io import BytesIO
    pdf = pikepdf.Pdf.open(BytesIO(_build_pdf_bytes(400, 300)))
    try:
        box = _read_page_box(pdf, 0)
        assert box == [0.0, 0.0, 400.0, 300.0]
    finally:
        pdf.close()


def test_read_page_box_uses_cropbox_when_present():
    from io import BytesIO
    pdf = pikepdf.Pdf.open(BytesIO(_build_pdf_bytes(400, 300, cropbox=[50, 40, 350, 260])))
    try:
        box = _read_page_box(pdf, 0)
        assert box == [50.0, 40.0, 350.0, 260.0]
    finally:
        pdf.close()


# ═══════════════════════════════════════════════════════════════════════════
#  render_clip — end-to-end (render thật)
# ═══════════════════════════════════════════════════════════════════════════
def test_render_clip_delete_renders_full_page():
    """Delete → clipRect=None, full=True; preview là data-URI PNG."""
    session = _make_session(_build_pdf_bytes())
    try:
        op = EditOp(kind="delete", page=0, targetIds=["a"])
        preview, clip_rect, full = render_clip(
            session, op, {"bboxes": [], "oldBboxes": [[100, 80, 160, 120]]},
            scale=1.0, clip_pad=8.0,
        )
        assert clip_rect is None
        assert full is True
        assert preview.startswith("data:image/png;base64,")
    finally:
        session.pdf.close()


def test_render_clip_move_produces_bounded_clip():
    """Move → clipRect xác định (Page_Box-relative), full=False."""
    session = _make_session(_build_pdf_bytes(400, 300))
    try:
        op = EditOp(kind="move", page=0, targetIds=["a"], delta=Delta(dx=30, dy=0))
        preview, clip_rect, full = render_clip(
            session, op,
            {"bboxes": [[130, 80, 190, 120]], "oldBboxes": [[100, 80, 160, 120]]},
            scale=2.0, clip_pad=8.0,
        )
        assert full is False
        assert clip_rect == [92.0, 72.0, 198.0, 128.0]
        assert preview.startswith("data:image/png;base64,")
    finally:
        session.pdf.close()


def test_render_clip_cropbox_offset_subtracts_origin():
    """CropBox lệch gốc → clipRect quy về gốc Page_Box-relative (trừ [bx0,by0])."""
    pdf_bytes = _build_pdf_bytes(400, 300, cropbox=[50, 40, 350, 260])
    session = _make_session(pdf_bytes)
    try:
        op = EditOp(kind="move", page=0, targetIds=["a"], delta=Delta(dx=0, dy=0))
        # bbox tuyệt đối [100,80,160,120]; +pad8 = [92,72,168,128]; kẹp trong
        # cropbox [50,40,350,260] giữ nguyên; trừ gốc [50,40] → [42,32,118,88].
        preview, clip_rect, full = render_clip(
            session, op,
            {"bboxes": [[100, 80, 160, 120]], "oldBboxes": [[100, 80, 160, 120]]},
            scale=1.0, clip_pad=8.0,
        )
        assert full is False
        assert clip_rect == [42.0, 32.0, 118.0, 88.0]
        assert preview.startswith("data:image/png;base64,")
    finally:
        session.pdf.close()


def test_render_clip_reuses_live_bytes(monkeypatch):
    """render_clip TÁI DÙNG session.live_bytes (không save lại Live_Document)."""
    session = _make_session(_build_pdf_bytes())
    save_calls = {"n": 0}
    orig_save = session.pdf.save

    def _counting_save(*a, **k):
        save_calls["n"] += 1
        return orig_save(*a, **k)

    monkeypatch.setattr(session.pdf, "save", _counting_save)
    try:
        op = EditOp(kind="move", page=0, targetIds=["a"], delta=Delta(dx=10, dy=0))
        render_clip(session, op,
                    {"bboxes": [[110, 80, 170, 120]], "oldBboxes": [[100, 80, 160, 120]]},
                    scale=1.0)
        assert save_calls["n"] == 0, "render_clip không được save lại khi đã có live_bytes"
    finally:
        session.pdf.close()

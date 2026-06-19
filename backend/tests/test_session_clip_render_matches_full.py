"""
Integration test (Task 3.3 — spec `pdf-edit-session`).

**Property 6: Tương đương vùng clip ↔ toàn trang (Metamorphic).**
Với mọi Edit_Op tác động vùng giới hạn, Preview_Image của Clip_Region khớp về
HÌNH HỌC với cùng vùng đó cắt ra từ ảnh render TOÀN TRANG (cùng scale), tolerance
≤ 1.0 point mỗi cạnh (≈ `scale` pixel).

Khác với `test_session_render_clip.py` (unit test LOGIC tính Clip_Region):
file này kiểm tương đương PIXEL giữa ảnh clip do `render_clip` trả và vùng tương
ứng crop từ ảnh full — tức là render thật bằng PDFium (read-only) khớp nhau.

Phạm vi: kiểm bằng 1–3 ví dụ đại diện (KHÔNG PBT) — render đúng pixel của PDFium
thuộc nhóm hành vi thư viện ngoài (theo design "Testing Strategy").

Cách kiểm (metamorphic):
  open phiên → apply_op(move) → render_clip → (preview, clipRect)
  render TOÀN TRANG độc lập từ cùng `live_bytes` ở CÙNG scale
  crop ảnh full theo clipRect (cùng công thức `_render_clip_blocking`)
  so sánh ảnh clip ≡ ảnh crop (cùng kích thước, pixel khớp)

KHÔNG mock: dựng PDF thật trong RAM, tạo EditSession trực tiếp (như
`test_session_render_clip.py`) để tránh DB; đăng ký phiên vào store để `apply_op`
chạy được.

_Requirements: 3.5, 4.3 (Property 6)_
"""
import base64
import os
import sys
import threading
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from PIL import Image, ImageChops

from app.core import edit_session, geometry_reader
from app.core.edit_session import EditSession, apply_op, render_clip
from app.api.routes.edit import _render_clip_blocking
from app.schemas.edit import EditOp, MoveDelta


# ── Helpers dựng PDF / phiên ─────────────────────────────────────────────────
def _build_pdf_bytes(page_w=400.0, page_h=300.0, cropbox=None) -> bytes:
    """Dựng PDF 1 trang với 1 vector rect (đối tượng giới hạn vùng)."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(page_w, page_h))
    page = pdf.pages[0]
    # Một hình chữ nhật tô màu — đối tượng vùng giới hạn rõ ràng cho move.
    stream = b"q\n0.1 0.2 0.6 rg\n100 80 60 40 re\nf\nQ\n"
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(stream)
    if cropbox is not None:
        page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array([float(v) for v in cropbox])
    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


def _register_session(pdf_bytes: bytes) -> EditSession:
    """
    Tạo EditSession TRỰC TIẾP và ĐĂNG KÝ vào store (không qua DB) để `apply_op`
    — vốn yêu cầu phiên còn sống trong `SESSIONS` — chạy được.
    """
    pdf = pikepdf.Pdf.open(BytesIO(pdf_bytes))
    sid = "test-clip-" + os.urandom(4).hex()
    session = EditSession(
        session_id=sid,
        source_fid="fid-clip-test",
        source_path="<memory>",
        pdf=pdf,
        baseline_bytes=pdf_bytes,
        lock=threading.Lock(),
        live_bytes=pdf_bytes,
    )
    edit_session.SESSIONS[sid] = session
    edit_session.by_fid[session.source_fid] = sid
    return session


def _cleanup_session(session: EditSession) -> None:
    edit_session.SESSIONS.pop(session.session_id, None)
    if edit_session.by_fid.get(session.source_fid) == session.session_id:
        edit_session.by_fid.pop(session.source_fid, None)
    try:
        session.pdf.close()
    except Exception:
        pass


def _first_target_id(pdf_bytes: bytes, page: int = 0) -> str:
    """Lấy id object đầu tiên trên trang (đối tượng vector rect đã dựng)."""
    metas = geometry_reader.list_objects(pdf_bytes, page, include_text_props=False)
    assert metas, "PDF dựng phải có ít nhất 1 object để move."
    return metas[0].id


def _decode_data_uri_png(data_uri: str) -> Image.Image:
    """data:image/png;base64,... → PIL.Image (RGB)."""
    assert data_uri.startswith("data:image/png;base64,")
    b64 = data_uri.split("base64,", 1)[1]
    return Image.open(BytesIO(base64.b64decode(b64))).convert("RGB")


def _crop_full_like_clip(full_img: Image.Image, clip_rect, scale: float) -> Image.Image:
    """
    Crop ảnh TOÀN TRANG theo `clip_rect` (PDF point, gốc Page_Box-relative, gốc
    DƯỚI-TRÁI) — DÙNG CHÍNH công thức của `_render_clip_blocking` để so sánh tương
    đương hình học giữa vùng clip và vùng tương ứng của full.
    """
    full_w, full_h = full_img.size
    x0, y0, x1, y1 = clip_rect
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    left = int(round(x0 * scale))
    right = int(round(x1 * scale))
    top = int(round(full_h - y1 * scale))
    bottom = int(round(full_h - y0 * scale))
    left = max(0, min(left, full_w))
    right = max(0, min(right, full_w))
    top = max(0, min(top, full_h))
    bottom = max(0, min(bottom, full_h))
    return full_img.crop((left, top, right, bottom))


def _assert_images_match(clip_img: Image.Image, crop_img: Image.Image, scale: float):
    """
    Khẳng định ảnh clip ≡ vùng crop từ full: kích thước khớp trong tolerance
    ≤ 1.0pt (≈ `scale` px) và pixel khớp ở vùng chung.
    """
    tol_px = max(1, int(round(scale)))  # 1.0pt ≈ scale px
    cw, ch = clip_img.size
    fw, fh = crop_img.size
    assert abs(cw - fw) <= tol_px, f"Lệch bề rộng {abs(cw - fw)}px > {tol_px}px (≤1pt)"
    assert abs(ch - fh) <= tol_px, f"Lệch chiều cao {abs(ch - fh)}px > {tol_px}px (≤1pt)"

    # So pixel ở vùng kích thước chung (kẹp về min để loại lệch viền do rounding).
    common = (min(cw, fw), min(ch, fh))
    a = clip_img.crop((0, 0, *common))
    b = crop_img.crop((0, 0, *common))
    diff = ImageChops.difference(a, b)
    extrema = diff.getextrema()  # ((min,max) mỗi kênh RGB)
    max_channel_diff = max(hi for _lo, hi in extrema)
    assert max_channel_diff == 0, (
        f"Pixel vùng clip không khớp vùng tương ứng của full (max diff={max_channel_diff})."
    )


# ═══════════════════════════════════════════════════════════════════════════
#  Property 6 — ví dụ 1: move trên trang gốc chuẩn (CropBox = MediaBox)
# ═══════════════════════════════════════════════════════════════════════════
def test_clip_render_matches_full_move_standard_page():
    pdf_bytes = _build_pdf_bytes(400, 300)
    session = _register_session(pdf_bytes)
    scale = 2.0
    try:
        target = _first_target_id(pdf_bytes, 0)
        op = EditOp(kind="move", page=0, targetIds=[target], delta=MoveDelta(dx=40, dy=20))
        op_result = apply_op(session, op)

        preview, clip_rect, full = render_clip(session, op, op_result, scale=scale, clip_pad=8.0)
        assert full is False, "Move vùng giới hạn phải dùng Incremental_Render (không full)."
        assert clip_rect is not None

        clip_img = _decode_data_uri_png(preview)

        # Render TOÀN TRANG độc lập từ cùng bytes post-op, cùng scale.
        full_b64, _w, _h = _render_clip_blocking(session.live_bytes, 0, scale, None)
        full_img = Image.open(BytesIO(base64.b64decode(full_b64))).convert("RGB")

        crop_img = _crop_full_like_clip(full_img, clip_rect, scale)
        _assert_images_match(clip_img, crop_img, scale)
    finally:
        _cleanup_session(session)


# ═══════════════════════════════════════════════════════════════════════════
#  Property 6 — ví dụ 2: move trên trang có CropBox lệch gốc
# ═══════════════════════════════════════════════════════════════════════════
def test_clip_render_matches_full_move_cropbox_offset():
    pdf_bytes = _build_pdf_bytes(400, 300, cropbox=[50, 40, 350, 260])
    session = _register_session(pdf_bytes)
    scale = 2.0
    try:
        target = _first_target_id(pdf_bytes, 0)
        op = EditOp(kind="move", page=0, targetIds=[target], delta=MoveDelta(dx=20, dy=0))
        op_result = apply_op(session, op)

        preview, clip_rect, full = render_clip(session, op, op_result, scale=scale, clip_pad=8.0)
        assert full is False
        assert clip_rect is not None

        clip_img = _decode_data_uri_png(preview)

        full_b64, _w, _h = _render_clip_blocking(session.live_bytes, 0, scale, None)
        full_img = Image.open(BytesIO(base64.b64decode(full_b64))).convert("RGB")

        crop_img = _crop_full_like_clip(full_img, clip_rect, scale)
        _assert_images_match(clip_img, crop_img, scale)
    finally:
        _cleanup_session(session)


# ═══════════════════════════════════════════════════════════════════════════
#  Property 6 — ví dụ 3: scale khác (1.5) để chắc tương đương độc lập với scale
# ═══════════════════════════════════════════════════════════════════════════
def test_clip_render_matches_full_move_alt_scale():
    pdf_bytes = _build_pdf_bytes(400, 300)
    session = _register_session(pdf_bytes)
    scale = 1.5
    try:
        target = _first_target_id(pdf_bytes, 0)
        op = EditOp(kind="move", page=0, targetIds=[target], delta=MoveDelta(dx=-30, dy=25))
        op_result = apply_op(session, op)

        preview, clip_rect, full = render_clip(session, op, op_result, scale=scale, clip_pad=12.0)
        assert full is False
        assert clip_rect is not None

        clip_img = _decode_data_uri_png(preview)

        full_b64, _w, _h = _render_clip_blocking(session.live_bytes, 0, scale, None)
        full_img = Image.open(BytesIO(base64.b64decode(full_b64))).convert("RGB")

        crop_img = _crop_full_like_clip(full_img, clip_rect, scale)
        _assert_images_match(clip_img, crop_img, scale)
    finally:
        _cleanup_session(session)

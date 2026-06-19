"""
Integration test cho endpoint `POST /edit/preview-hide` — tính năng "Ẩn đối tượng"
(tắt mắt) ở chế độ Edit PDF.

Mục tiêu: kiểm chứng qua tầng API (FastAPI `TestClient`, DEV_MODE) rằng khi ẩn một
object, backend render HÌNH THẬT của trang ĐÃ LOẠI BỎ object đó (read-only, không
ghi file). So sánh:
  - Ảnh full-page (targetIds rỗng) vs ảnh sau khi ẩn 1 object → PHẢI KHÁC nhau
    (object biến mất khỏi ảnh).
  - targetIds chứa id không tồn tại → bỏ qua mềm, vẫn trả 200.

Chiến lược dữ liệu giống test_session_*: dựng PDF 2 ảnh bằng pikepdf, đăng ký
UploadedFile thật (SQLite dev), dọn sạch sau test.

_Validates: tính năng preview-hide (render read-only, không mutate)._
"""
import base64
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from fastapi.testclient import TestClient

from app.main import app
from app.database import Base, SessionLocal, engine
from app.models.job import UploadedFile

# ── Layout trang mẫu: 2 ảnh cách xa nhau ─────────────────────────────────────
PAGE_W = 400.0
PAGE_H = 400.0

IMG_A = (50.0, 60.0, 60.0, 40.0)   # x, y, w, h
IMG_B = (250.0, 280.0, 60.0, 40.0)


def _make_image_xobject(pdf: pikepdf.Pdf, rgb: tuple[int, int, int]) -> pikepdf.Object:
    data = bytes(list(rgb) * 4)
    stream = pikepdf.Stream(pdf, data)
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = 2
    stream[pikepdf.Name("/Height")] = 2
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceRGB")
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    return pdf.make_indirect(stream)


def _build_sample_pdf(path: str) -> None:
    """PDF 1 trang gồm 2 ảnh rời rạc (mỗi ảnh là 1 object xóa được riêng)."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    ax, ay, aw, ah = IMG_A
    bx, by, bw, bh = IMG_B
    content = (
        "q\n"
        f"{aw:.4f} 0 0 {ah:.4f} {ax:.4f} {ay:.4f} cm\n"
        "/ImgA Do\n"
        "Q\n"
        "q\n"
        f"{bw:.4f} 0 0 {bh:.4f} {bx:.4f} {by:.4f} cm\n"
        "/ImgB Do\n"
        "Q\n"
    ).encode("latin-1")

    resources = pikepdf.Dictionary()
    xobjects = pikepdf.Dictionary()
    xobjects[pikepdf.Name("/ImgA")] = _make_image_xobject(pdf, (200, 30, 30))
    xobjects[pikepdf.Name("/ImgB")] = _make_image_xobject(pdf, (30, 30, 200))
    resources[pikepdf.Name("/XObject")] = xobjects
    page.obj[pikepdf.Name("/Resources")] = resources
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()


# ── DB helpers (SQLite dev) ──────────────────────────────────────────────────
def _register_uploaded(path: str, original_name: str) -> str:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        row = UploadedFile(
            filename=os.path.basename(path),
            original_name=original_name,
            file_path=path,
            file_size=os.path.getsize(path),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id
    finally:
        db.close()


def _delete_uploaded(fid: str) -> None:
    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if row is not None:
            db.delete(row)
            db.commit()
    finally:
        db.close()


def _decode_data_uri(data_uri: str) -> bytes:
    assert data_uri.startswith("data:image/png;base64,"), data_uri[:40]
    b64 = data_uri.split("base64,", 1)[1]
    return base64.b64decode(b64)


def _object_ids(client, fid: str) -> list[str]:
    resp = client.get(f"/api/edit/objects/{fid}/0")
    assert resp.status_code == 200, resp.text
    objs = resp.json()["objects"]
    return [o["id"] for o in objs]


# ═══════════════════════════════════════════════════════════════════════════
#  Ẩn 1 object → ảnh KHÁC ảnh full (object đã bị loại khỏi hình render)
# ═══════════════════════════════════════════════════════════════════════════
def test_preview_hide_removes_object_from_render(tmp_path):
    src = os.path.join(str(tmp_path), "two_objects.pdf")
    _build_sample_pdf(src)
    source_before = open(src, "rb").read()

    fid = _register_uploaded(src, "TwoObjects.pdf")
    client = TestClient(app)
    try:
        ids = _object_ids(client, fid)
        assert len(ids) >= 2, f"Kỳ vọng >= 2 object, nhận: {ids}"
        target = ids[0]

        # ── (a) Ảnh full-page (targetIds rỗng) → render trang bình thường ────
        r_full = client.post(
            "/api/edit/preview-hide",
            json={"fid": fid, "page": 0, "targetIds": []},
        )
        assert r_full.status_code == 200, r_full.text
        full = r_full.json()
        assert full["success"] is True
        full_png = _decode_data_uri(full["image"])
        assert full["width"] > 0 and full["height"] > 0

        # ── (b) Ẩn 1 object → ảnh phải KHÁC ảnh full ─────────────────────────
        r_hide = client.post(
            "/api/edit/preview-hide",
            json={"fid": fid, "page": 0, "targetIds": [target]},
        )
        assert r_hide.status_code == 200, r_hide.text
        hide = r_hide.json()
        assert hide["success"] is True
        assert hide["page"] == 0
        hide_png = _decode_data_uri(hide["image"])

        # Cùng kích thước trang nhưng nội dung khác (object đã bị loại).
        assert hide["width"] == full["width"]
        assert hide["height"] == full["height"]
        assert hide_png != full_png, "Ảnh sau khi ẩn object không khác ảnh full!"

        # ── (c) id không tồn tại → bỏ qua mềm, vẫn 200 (giống full) ──────────
        r_bogus = client.post(
            "/api/edit/preview-hide",
            json={"fid": fid, "page": 0, "targetIds": ["khong-ton-tai-xyz"]},
        )
        assert r_bogus.status_code == 200, r_bogus.text
        bogus_png = _decode_data_uri(r_bogus.json()["image"])
        assert bogus_png == full_png, "Ẩn id không tồn tại phải cho ảnh = full."

        # ── KHÔNG ghi đè / mutate file gốc ───────────────────────────────────
        assert open(src, "rb").read() == source_before, "File gốc bị thay đổi!"
    finally:
        _delete_uploaded(fid)

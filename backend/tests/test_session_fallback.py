"""
Integration test FALLBACK Legacy_Commit_Flow qua tầng API (Task 7.2 — spec
`pdf-edit-session`).

Mục tiêu: kiểm chứng đường DỰ PHÒNG khi phiên trong bộ nhớ gặp sự cố:

  1. Thao tác trên một Session_Id KHÔNG tồn tại (đã đóng / hết hạn / chưa mở) →
     backend trả **HTTP 410 Gone** để frontend phát hiện và chuyển sang
     Legacy_Commit_Flow (Yêu cầu 9.5, 11.1).
  2. Cùng một Edit_Op `move` khi áp qua đường PHIÊN (open→op→commit) và qua đường
     LEGACY (`POST /edit/transform`) cho kết quả TƯƠNG ĐƯƠNG về hình học (image
     bbox dịch đúng (dx, dy)) trong tolerance ≤ 1.0pt (Yêu cầu 11.2). Như vậy
     fallback luôn dùng được và cho kết quả nhất quán.

ĐÂY KHÔNG PHẢI property-based test — chỉ ví dụ đại diện (move), theo lưu ý phạm vi
PBT trong design (endpoint/render là hành vi tiến trình ngoài → integration test).

DEV_MODE=true nên `require_license` cho qua mà không cần header (xem config).

_Validates: Requirements 9.5, 11.1, 11.2_
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.database import Base, SessionLocal, engine
from app.models.job import UploadedFile
from app.schemas.edit import bbox_within_tolerance, normalize_bbox
from app.core import geometry_reader

# ── Layout trang mẫu (đồng bộ với test_session_undo_redo_e2e) ────────────────
PAGE_W = 400.0
PAGE_H = 400.0
TOL = 1.0

IMG_X, IMG_Y, IMG_W, IMG_H = 50.0, 60.0, 60.0, 40.0
IMG_BBOX = [IMG_X, IMG_Y, IMG_X + IMG_W, IMG_Y + IMG_H]


def _make_image_xobject(pdf: pikepdf.Pdf) -> pikepdf.Object:
    data = bytes([200, 30, 30] * 4)
    stream = pikepdf.Stream(pdf, data)
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = 2
    stream[pikepdf.Name("/Height")] = 2
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceRGB")
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    return pdf.make_indirect(stream)


def _build_sample_pdf(path: str) -> None:
    """PDF 1 trang gồm 1 ảnh (mục tiêu move) + 1 vector CMYK (untouched)."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]
    content = (
        "q\n"
        f"{IMG_W:.4f} 0 0 {IMG_H:.4f} {IMG_X:.4f} {IMG_Y:.4f} cm\n"
        "/Img0 Do\n"
        "Q\n"
        "q\n"
        "0.1000 0.2000 0.3000 0.4000 k\n"
        "220.0000 60.0000 50.0000 30.0000 re\n"
        "f\n"
        "Q\n"
    ).encode("latin-1")
    resources = pikepdf.Dictionary()
    xobjects = pikepdf.Dictionary()
    xobjects[pikepdf.Name("/Img0")] = _make_image_xobject(pdf)
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


def _delete_uploaded(fid: str) -> str | None:
    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if row is None:
            return None
        path = row.file_path
        db.delete(row)
        db.commit()
        return path
    finally:
        db.close()


def _image_bbox_of_file(pdf_path: str) -> list[float]:
    images = [o for o in geometry_reader.list_objects(pdf_path, 0) if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh, nhận: {images}"
    return normalize_bbox(list(images[0].bbox))


def _image_id(client, fid: str) -> str:
    resp = client.get(f"/api/edit/objects/{fid}/0")
    assert resp.status_code == 200, resp.text
    images = [o for o in resp.json()["objects"] if o["type"] == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh, nhận: {resp.json()['objects']}"
    return images[0]["id"]


# ═══════════════════════════════════════════════════════════════════════════
#  (1) Session_Id không tồn tại → 410 Gone (Yêu cầu 9.5, 11.1)
# ═══════════════════════════════════════════════════════════════════════════
def test_session_op_on_missing_session_returns_410(tmp_path):
    """Op trên Session_Id bịa → 410 để FE fallback Legacy (Yêu cầu 9.5, 11.1)."""
    client = TestClient(app)
    resp = client.post(
        "/api/edit/session/op",
        json={
            "session_id": "khong-ton-tai-deadbeef",
            "op": {"page": 0, "kind": "move", "targetIds": ["image-1"],
                   "delta": {"dx": 10.0, "dy": 10.0}},
        },
    )
    assert resp.status_code == 410, resp.text


def test_session_undo_and_commit_on_missing_session_return_410(tmp_path):
    """Undo/commit trên Session_Id bịa cũng → 410 (nhất quán fallback)."""
    client = TestClient(app)
    ru = client.post(
        "/api/edit/session/undo",
        json={"session_id": "khong-ton-tai-deadbeef"},
    )
    assert ru.status_code == 410, ru.text

    rc = client.post(
        "/api/edit/session/commit",
        json={"session_id": "khong-ton-tai-deadbeef"},
    )
    assert rc.status_code == 410, rc.text


# ═══════════════════════════════════════════════════════════════════════════
#  (2) Phiên-gone → đường Legacy vẫn hoạt động và cho kết quả TƯƠNG ĐƯƠNG
#      với đường phiên cho cùng Edit_Op (Yêu cầu 11.1, 11.2)
# ═══════════════════════════════════════════════════════════════════════════
def test_legacy_transform_equivalent_to_session_commit(tmp_path):
    """
    Cùng op `move (dx, dy)` áp qua:
      A. Đường PHIÊN: open → op → commit → Working_File.
      B. Đường LEGACY: POST /edit/transform → Working_File.
    → bbox ảnh sau cùng KHỚP nhau trong tolerance ≤ 1.0pt (Yêu cầu 11.2);
      đồng thời cả hai đều = bbox gốc + (dx, dy).
    """
    dx, dy = 45.0, -30.0
    expected = normalize_bbox(
        [IMG_BBOX[0] + dx, IMG_BBOX[1] + dy, IMG_BBOX[2] + dx, IMG_BBOX[3] + dy]
    )

    client = TestClient(app)
    new_fids: list[str] = []
    working_paths: list[str] = []

    # ── A. Đường PHIÊN ───────────────────────────────────────────────────────
    src_a = os.path.join(str(tmp_path), "sample_session.pdf")
    _build_sample_pdf(src_a)
    fid_a = _register_uploaded(src_a, "DocA.pdf")
    sid = None
    session_bbox = None
    try:
        ro = client.post("/api/edit/session/open", json={"fid": fid_a})
        assert ro.status_code == 200, ro.text
        sid = ro.json()["session_id"]

        img_id = _image_id(client, fid_a)
        rop = client.post(
            "/api/edit/session/op",
            json={
                "session_id": sid,
                "op": {"page": 0, "kind": "move", "targetIds": [img_id],
                       "delta": {"dx": dx, "dy": dy}},
            },
        )
        assert rop.status_code == 200, rop.text

        rc = client.post("/api/edit/session/commit", json={"session_id": sid})
        assert rc.status_code == 200, rc.text
        bc = rc.json()
        new_fids.append(bc["output_fid"])
        working_paths.append(bc["output_path"])
        session_bbox = _image_bbox_of_file(bc["output_path"])
    finally:
        if sid is not None:
            client.delete(f"/api/edit/session/{sid}")

    assert bbox_within_tolerance(session_bbox, expected, TOL), (
        f"Đường phiên: bbox {session_bbox} != kỳ vọng {expected}"
    )

    # ── B. Đường LEGACY (/edit/transform) ─────────────────────────────────────
    src_b = os.path.join(str(tmp_path), "sample_legacy.pdf")
    _build_sample_pdf(src_b)
    fid_b = _register_uploaded(src_b, "DocB.pdf")
    try:
        # id ảnh trên trang gốc (không có phiên → list từ đĩa).
        rl_objs = client.get(f"/api/edit/objects/{fid_b}/0")
        assert rl_objs.status_code == 200, rl_objs.text
        legacy_img = [o for o in rl_objs.json()["objects"] if o["type"] == "image"]
        assert len(legacy_img) == 1
        legacy_id = legacy_img[0]["id"]

        rt = client.post(
            "/api/edit/transform",
            json={
                "fid": fid_b,
                "op": {"page": 0, "kind": "move", "targetIds": [legacy_id],
                       "delta": {"dx": dx, "dy": dy}},
            },
        )
        assert rt.status_code == 200, rt.text
        bt = rt.json()
        new_fids.append(bt["output_fid"])
        working_paths.append(bt["output_path"])
        legacy_bbox = _image_bbox_of_file(bt["output_path"])
    finally:
        pass

    assert bbox_within_tolerance(legacy_bbox, expected, TOL), (
        f"Đường legacy: bbox {legacy_bbox} != kỳ vọng {expected}"
    )

    # ── TƯƠNG ĐƯƠNG phiên ↔ legacy (Yêu cầu 11.2) ────────────────────────────
    assert bbox_within_tolerance(session_bbox, legacy_bbox, TOL), (
        f"Kết quả KHÔNG tương đương: phiên={session_bbox} vs legacy={legacy_bbox} "
        f"(tolerance ≤ {TOL}pt)"
    )

    # ── Dọn DB + Working_File ─────────────────────────────────────────────────
    for nf in new_fids:
        _delete_uploaded(nf)
    _delete_uploaded(fid_a)
    _delete_uploaded(fid_b)
    for p in working_paths:
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass

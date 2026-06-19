"""
Integration test END-TO-END qua tầng API `/edit/session/*` (Task 7.2 — spec
`pdf-edit-session`).

Mục tiêu: kiểm chứng vòng đời PHIÊN thật qua HTTP bằng FastAPI `TestClient`:

    open → op×N → undo → redo → commit → close

Khẳng định cốt lõi:
  - **Yêu cầu 7.1**: mỗi Edit_Op được ghi vào Op_Log của phiên (canUndo bật dần).
  - **Yêu cầu 7.2**: Undo khôi phục trạng thái ngay TRƯỚC Edit_Op gần nhất
    (image bbox lùi về sau op áp trước đó).
  - **Yêu cầu 7.3**: Redo áp lại đúng Edit_Op vừa bị hoàn tác.
  - **Yêu cầu 7.4**: Op_Log + cờ canUndo/canRedo nhất quán suốt chuỗi thao tác.
  - Commit ghi Working_File MỚI (KHÔNG đè file gốc) với bbox phản ánh đúng chuỗi
    op còn hiệu lực sau undo/redo.

ĐÂY KHÔNG PHẢI property-based test — chỉ 1 ví dụ đại diện (move ×2 → undo → redo
→ commit), theo lưu ý phạm vi PBT trong design (render PDFium + endpoint là hành
vi thư viện/tiến trình ngoài → integration test 1–3 ví dụ).

Chiến lược dữ liệu / DB:
  - Dựng PDF mẫu 1 trang có 1 ảnh (mục tiêu move) + 2 vector (CMYK/spot) bằng
    pikepdf, ghi ra `tmp_path`.
  - Đăng ký một bản ghi `UploadedFile` THẬT (SQLite dev) trỏ tới file đó → `fid`.
  - Dọn sạch bản ghi DB + Working_File commit sau test.
  - DEV_MODE=true nên `require_license` cho qua mà không cần header (xem config).

_Validates: Requirements 7.1, 7.2, 7.3, 7.4_
"""
import os
import sys
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.database import Base, SessionLocal, engine
from app.models.job import UploadedFile
from app.schemas.edit import bbox_within_tolerance, normalize_bbox
from app.core import geometry_reader

# ── Layout trang mẫu ─────────────────────────────────────────────────────────
PAGE_W = 400.0
PAGE_H = 400.0
TOL = 1.0  # tolerance ≤ 1.0pt mỗi cạnh

IMG_X, IMG_Y, IMG_W, IMG_H = 50.0, 60.0, 60.0, 40.0
IMG_BBOX = [IMG_X, IMG_Y, IMG_X + IMG_W, IMG_Y + IMG_H]  # [50, 60, 110, 100]

CMYK_X, CMYK_Y, CMYK_W, CMYK_H = 220.0, 60.0, 50.0, 30.0
SPOT_X, SPOT_Y, SPOT_W, SPOT_H = 220.0, 220.0, 50.0, 30.0


# ── Dựng PDF mẫu ─────────────────────────────────────────────────────────────
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
    """PDF 1 trang: 1 ảnh (mục tiêu) + 2 vector (CMYK + spot), bbox cách xa nhau."""
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
        f"{CMYK_X:.4f} {CMYK_Y:.4f} {CMYK_W:.4f} {CMYK_H:.4f} re\n"
        "f\n"
        "Q\n"
        "q\n"
        "/Sep0 cs\n"
        "0.5000 scn\n"
        f"{SPOT_X:.4f} {SPOT_Y:.4f} {SPOT_W:.4f} {SPOT_H:.4f} re\n"
        "f\n"
        "Q\n"
    ).encode("latin-1")

    resources = pikepdf.Dictionary()
    xobjects = pikepdf.Dictionary()
    xobjects[pikepdf.Name("/Img0")] = _make_image_xobject(pdf)
    resources[pikepdf.Name("/XObject")] = xobjects

    func = pdf.make_indirect(
        pikepdf.Dictionary(
            FunctionType=2,
            Domain=pikepdf.Array([0, 1]),
            C0=pikepdf.Array([0, 0, 0, 0]),
            C1=pikepdf.Array([0, 0, 0, 1]),
            N=1,
        )
    )
    sep = pikepdf.Array(
        [
            pikepdf.Name("/Separation"),
            pikepdf.Name("/SpotColor0"),
            pikepdf.Name("/DeviceCMYK"),
            func,
        ]
    )
    cs_dict = pikepdf.Dictionary()
    cs_dict[pikepdf.Name("/Sep0")] = pdf.make_indirect(sep)
    resources[pikepdf.Name("/ColorSpace")] = cs_dict

    page.obj[pikepdf.Name("/Resources")] = resources
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(content)

    pdf.save(path)
    pdf.close()


# ── DB helpers (SQLite dev) ──────────────────────────────────────────────────
def _register_uploaded(path: str, original_name: str) -> str:
    """Đăng ký một bản ghi UploadedFile THẬT trỏ tới `path`, trả `fid` mới."""
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
    """Xóa bản ghi UploadedFile theo `fid`; trả `file_path` (để dọn file) nếu có."""
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


# ── Helpers tra ảnh trên trang đã commit ─────────────────────────────────────
def _image_bbox_of_file(pdf_path: str) -> list[float]:
    images = [o for o in geometry_reader.list_objects(pdf_path, 0) if o.type == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh, nhận: {images}"
    return normalize_bbox(list(images[0].bbox))


def _client():
    return TestClient(app)


def _open_session(client, fid: str) -> str:
    resp = client.post("/api/edit/session/open", json={"fid": fid})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["page_count"] == 1
    assert isinstance(body["session_id"], str) and body["session_id"]
    return body["session_id"]


def _image_id(client, fid: str) -> str:
    """Lấy id của object ảnh DUY NHẤT trên trang 0 (qua /edit/objects)."""
    resp = client.get(f"/api/edit/objects/{fid}/0")
    assert resp.status_code == 200, resp.text
    images = [o for o in resp.json()["objects"] if o["type"] == "image"]
    assert len(images) == 1, f"Kỳ vọng đúng 1 ảnh, nhận: {resp.json()['objects']}"
    return images[0]["id"]


def _move_op(client, sid: str, fid: str, dx: float, dy: float) -> dict:
    """Áp 1 op move lên ảnh (re-resolve id trước mỗi op) và trả body response."""
    img_id = _image_id(client, fid)
    resp = client.post(
        "/api/edit/session/op",
        json={
            "session_id": sid,
            "op": {"page": 0, "kind": "move", "targetIds": [img_id],
                   "delta": {"dx": dx, "dy": dy}},
            "render_scale": 1.5,
            "clip_pad_pt": 8.0,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _assert_preview_ok(body: dict):
    assert body["success"] is True
    assert isinstance(body["preview"], str)
    assert body["preview"].startswith("data:image/png;base64,")
    # clipRect: None (toàn trang) hoặc [x0,y0,x1,y1].
    assert body["clipRect"] is None or len(body["clipRect"]) == 4


# ═══════════════════════════════════════════════════════════════════════════
#  E2E: open → move×2 → undo → redo → commit → close
# ═══════════════════════════════════════════════════════════════════════════
def test_session_open_op_undo_redo_commit_e2e(tmp_path):
    src = os.path.join(str(tmp_path), "sample.pdf")
    _build_sample_pdf(src)
    source_before = open(src, "rb").read()

    fid = _register_uploaded(src, "MyDoc.pdf")
    client = _client()
    sid = None
    new_fids: list[str] = []
    working_paths: list[str] = []

    dx1, dy1 = 45.0, -30.0
    dx2, dy2 = 20.0, 25.0

    try:
        # ── open ────────────────────────────────────────────────────────────
        sid = _open_session(client, fid)

        # ── op #1 (move) — Op_Log có 1, canUndo bật, canRedo tắt (Yêu cầu 7.1) ─
        b1 = _move_op(client, sid, fid, dx1, dy1)
        _assert_preview_ok(b1)
        assert b1["canUndo"] is True
        assert b1["canRedo"] is False
        assert b1["opResult"]["kind"] == "move"
        bbox_after_op1 = normalize_bbox(b1["opResult"]["bbox"])
        expected_op1 = normalize_bbox(
            [IMG_BBOX[0] + dx1, IMG_BBOX[1] + dy1, IMG_BBOX[2] + dx1, IMG_BBOX[3] + dy1]
        )
        assert bbox_within_tolerance(bbox_after_op1, expected_op1, TOL), (
            f"BBox sau op1 {bbox_after_op1} != kỳ vọng {expected_op1}"
        )

        # ── op #2 (move) — Op_Log có 2 ───────────────────────────────────────
        b2 = _move_op(client, sid, fid, dx2, dy2)
        _assert_preview_ok(b2)
        assert b2["canUndo"] is True
        assert b2["canRedo"] is False
        bbox_after_op2 = normalize_bbox(b2["opResult"]["bbox"])
        expected_op2 = normalize_bbox(
            [expected_op1[0] + dx2, expected_op1[1] + dy2,
             expected_op1[2] + dx2, expected_op1[3] + dy2]
        )
        assert bbox_within_tolerance(bbox_after_op2, expected_op2, TOL), (
            f"BBox sau op2 {bbox_after_op2} != kỳ vọng {expected_op2}"
        )

        # ── undo — lùi về trạng thái sau op1 (Yêu cầu 7.2) ───────────────────
        ru = client.post(
            "/api/edit/session/undo",
            json={"session_id": sid, "render_scale": 1.5, "clip_pad_pt": 8.0},
        )
        assert ru.status_code == 200, ru.text
        bu = ru.json()
        assert bu["success"] is True
        assert bu["canUndo"] is True   # còn op1 trong log
        assert bu["canRedo"] is True   # op2 chờ redo
        undo_bbox = bu["opResult"]["bbox"]
        assert bbox_within_tolerance(normalize_bbox(undo_bbox), expected_op1, TOL), (
            f"BBox sau undo {undo_bbox} != trạng thái sau op1 {expected_op1}"
        )

        # ── redo — áp lại op2 (Yêu cầu 7.3) ──────────────────────────────────
        rr = client.post(
            "/api/edit/session/redo",
            json={"session_id": sid, "render_scale": 1.5, "clip_pad_pt": 8.0},
        )
        assert rr.status_code == 200, rr.text
        br = rr.json()
        assert br["success"] is True
        assert br["canUndo"] is True
        assert br["canRedo"] is False  # đã redo hết
        redo_bbox = br["opResult"]["bbox"]
        assert bbox_within_tolerance(normalize_bbox(redo_bbox), expected_op2, TOL), (
            f"BBox sau redo {redo_bbox} != trạng thái sau op2 {expected_op2}"
        )

        # ── commit — Working_File MỚI, bbox = chuỗi op còn hiệu lực ───────────
        rc = client.post("/api/edit/session/commit", json={"session_id": sid})
        assert rc.status_code == 200, rc.text
        bc = rc.json()
        assert bc["success"] is True
        assert bc["output_fid"]
        assert bc["output_url"].startswith("/results/edit_output/")
        assert bc["output_filename"] in bc["output_url"]
        out_path = bc["output_path"]
        new_fids.append(bc["output_fid"])
        working_paths.append(out_path)

        assert os.path.isabs(out_path)
        assert os.path.exists(out_path)
        committed_bbox = _image_bbox_of_file(out_path)
        assert bbox_within_tolerance(committed_bbox, expected_op2, TOL), (
            f"BBox ảnh trong Working_File {committed_bbox} != kỳ vọng {expected_op2} "
            f"(chuỗi op sau undo/redo)"
        )

        # ── KHÔNG đè file gốc ────────────────────────────────────────────────
        assert open(src, "rb").read() == source_before, "File gốc bị thay đổi!"

    finally:
        # ── close session (giải phóng RAM) ──────────────────────────────────
        if sid is not None:
            client.delete(f"/api/edit/session/{sid}")
        # ── dọn DB + Working_File ────────────────────────────────────────────
        for nf in new_fids:
            _delete_uploaded(nf)
        _delete_uploaded(fid)
        for p in working_paths:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  Undo khi Op_Log RỖNG → no-op, giữ nguyên (Yêu cầu 7.4 phần nhất quán)
# ═══════════════════════════════════════════════════════════════════════════
def test_session_undo_empty_oplog_is_noop(tmp_path):
    src = os.path.join(str(tmp_path), "sample.pdf")
    _build_sample_pdf(src)
    fid = _register_uploaded(src, "MyDoc.pdf")
    client = _client()
    sid = None
    try:
        sid = _open_session(client, fid)
        ru = client.post(
            "/api/edit/session/undo",
            json={"session_id": sid, "render_scale": 1.5, "clip_pad_pt": 8.0},
        )
        assert ru.status_code == 200, ru.text
        bu = ru.json()
        # Không có gì để hoàn tác: canUndo/canRedo đều False, không có preview.
        assert bu["canUndo"] is False
        assert bu["canRedo"] is False
        assert bu["preview"] is None
    finally:
        if sid is not None:
            client.delete(f"/api/edit/session/{sid}")
        _delete_uploaded(fid)

"""
Unit tests cho store toàn cục + `open_session` (Task 1.2 — spec `pdf-edit-session`).

Kiểm phần LOGIC vòng đời MỞ phiên trong `app/core/edit_session.py`:
- Mở phiên trả về một Session_Id DUY NHẤT, nạp Live_Document từ file gốc, khởi
  tạo Op_Log / redo_stack RỖNG, `dirty=False` (Yêu cầu 1.1, 1.4).
- ≤1 phiên SỐNG mỗi `fid`: mở lại cùng `fid` → ĐÓNG phiên cũ trước, store chỉ còn
  một phiên cho fid đó (Yêu cầu 1.5).
- `fid` không tồn tại / file mất → raise lỗi không-tìm-thấy-file và KHÔNG tạo phiên
  (store không phình thêm) (Yêu cầu 1.3).

`open_session` phụ thuộc DB (bảng UploadedFile) qua `_resolve_source_path`. Để cô
lập DB (giống cách `test_session_commit.py` patch tầng đăng ký), ta monkeypatch
`_resolve_source_path` trỏ tới một file PDF THẬT dựng trong `tmp_path` — vẫn đọc
file thật + mở pikepdf thật, chỉ thay bước resolve fid→path qua DB.

Dọn `SESSIONS`/`by_fid` sau mỗi test để tránh rò trạng thái global giữa các test.

_Requirements: 1.1, 1.3, 1.5_
"""
import os
import sys
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
import pytest

from app.core import edit_session
from app.core.edit_session import open_session


# ── Helpers ──────────────────────────────────────────────────────────────────
def _build_pdf_bytes(page_w=400.0, page_h=300.0) -> bytes:
    """Dựng bytes một PDF tối thiểu hợp lệ (1 trang) để làm file gốc."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(page_w, page_h))
    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


def _write_source_pdf(tmp_path, name="source.pdf") -> str:
    """Ghi một file PDF thật vào tmp_path, trả đường dẫn tuyệt đối."""
    source_path = os.path.join(str(tmp_path), name)
    with open(source_path, "wb") as fh:
        fh.write(_build_pdf_bytes())
    return source_path


def _patch_resolve(monkeypatch, mapping: dict[str, str]):
    """
    Cô lập DB: thay `_resolve_source_path(fid)` bằng tra `mapping`. fid không có
    trong mapping → raise FileNotFoundError (mô phỏng UploadedFile không tồn tại).
    """
    def _fake_resolve(fid: str) -> str:
        path = mapping.get(fid)
        if path is None:
            raise FileNotFoundError(f"File ID '{fid}' không tìm thấy.")
        return path

    monkeypatch.setattr(edit_session, "_resolve_source_path", _fake_resolve)


@pytest.fixture(autouse=True)
def _clean_store():
    """Đảm bảo store sạch trước/sau mỗi test (chống rò trạng thái global)."""
    _drain_store()
    yield
    _drain_store()


def _drain_store():
    for sid in list(edit_session.SESSIONS.keys()):
        session = edit_session.SESSIONS.pop(sid, None)
        if session is not None:
            try:
                session.pdf.close()
            except Exception:
                pass
    edit_session.by_fid.clear()


# ═══════════════════════════════════════════════════════════════════════════
#  open_session — Session_Id duy nhất, op_log rỗng (Yêu cầu 1.1, 1.4)
# ═══════════════════════════════════════════════════════════════════════════
def test_open_session_returns_unique_id_and_empty_log(tmp_path, monkeypatch):
    """Mở phiên trả Session_Id, nạp Live_Document, Op_Log/redo rỗng, dirty=False."""
    src = _write_source_pdf(tmp_path)
    _patch_resolve(monkeypatch, {"fid-A": src})

    session = open_session("fid-A")

    assert session.session_id  # có Session_Id
    assert session.source_fid == "fid-A"
    assert session.source_path == src
    assert len(session.pdf.pages) == 1            # Live_Document đã nạp từ file gốc
    assert session.baseline_bytes  # giữ bytes gốc
    assert session.op_log == []                   # Op_Log rỗng (Yêu cầu 1.4)
    assert session.redo_stack == []               # con trỏ Undo/Redo rỗng
    assert session.dirty is False
    # Đăng ký đúng vào store.
    assert edit_session.SESSIONS[session.session_id] is session
    assert edit_session.by_fid["fid-A"] == session.session_id


def test_open_session_ids_are_unique_across_fids(tmp_path, monkeypatch):
    """Hai fid khác nhau → hai Session_Id KHÁC nhau, cùng tồn tại trong store."""
    src1 = _write_source_pdf(tmp_path, "a.pdf")
    src2 = _write_source_pdf(tmp_path, "b.pdf")
    _patch_resolve(monkeypatch, {"fid-1": src1, "fid-2": src2})

    s1 = open_session("fid-1")
    s2 = open_session("fid-2")

    assert s1.session_id != s2.session_id
    assert len(edit_session.SESSIONS) == 2
    assert edit_session.by_fid["fid-1"] == s1.session_id
    assert edit_session.by_fid["fid-2"] == s2.session_id


# ═══════════════════════════════════════════════════════════════════════════
#  open_session — ≤1 phiên/fid: mở lại cùng fid đóng phiên cũ (Yêu cầu 1.5)
# ═══════════════════════════════════════════════════════════════════════════
def test_open_session_same_fid_closes_previous_session(tmp_path, monkeypatch):
    """Mở lại cùng fid → đóng phiên cũ; store chỉ còn MỘT phiên sống cho fid đó."""
    src = _write_source_pdf(tmp_path)
    _patch_resolve(monkeypatch, {"fid-dup": src})

    first = open_session("fid-dup")
    first_id = first.session_id

    second = open_session("fid-dup")

    # Phiên mới khác phiên cũ.
    assert second.session_id != first_id
    # Phiên cũ đã bị gỡ khỏi store (≤1 phiên/fid — Yêu cầu 1.5).
    assert first_id not in edit_session.SESSIONS
    # by_fid trỏ phiên mới; chỉ còn đúng một phiên trong store cho fid này.
    assert edit_session.by_fid["fid-dup"] == second.session_id
    fid_sessions = [s for s in edit_session.SESSIONS.values() if s.source_fid == "fid-dup"]
    assert len(fid_sessions) == 1
    assert fid_sessions[0] is second


# ═══════════════════════════════════════════════════════════════════════════
#  open_session — fid không tồn tại → lỗi, KHÔNG tạo phiên (Yêu cầu 1.3)
# ═══════════════════════════════════════════════════════════════════════════
def test_open_session_unknown_fid_raises_and_creates_no_session(tmp_path, monkeypatch):
    """fid không có trong DB → FileNotFoundError, store không phình thêm phiên."""
    _patch_resolve(monkeypatch, {})  # không fid nào resolve được

    before = len(edit_session.SESSIONS)
    with pytest.raises(FileNotFoundError):
        open_session("fid-missing")

    assert len(edit_session.SESSIONS) == before  # KHÔNG tạo phiên
    assert "fid-missing" not in edit_session.by_fid


def test_open_session_missing_file_on_disk_raises(tmp_path, monkeypatch):
    """File gốc bị xóa khỏi đĩa (path không tồn tại) → FileNotFoundError, không tạo phiên."""
    ghost_path = os.path.join(str(tmp_path), "deleted.pdf")  # không ghi file → không tồn tại
    _patch_resolve(monkeypatch, {"fid-ghost": ghost_path})

    before = len(edit_session.SESSIONS)
    with pytest.raises(FileNotFoundError):
        open_session("fid-ghost")

    assert len(edit_session.SESSIONS) == before
    assert "fid-ghost" not in edit_session.by_fid

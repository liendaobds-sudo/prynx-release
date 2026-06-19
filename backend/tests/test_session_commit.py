"""
Unit tests cho `commit` (Task 5.1 — spec `pdf-edit-session`).

Kiểm phần LOGIC Defer_Commit trong `app/core/edit_session.py`:
- Commit ghi một Working_File MỚI ra đĩa (KHÔNG đè file gốc), trả thông tin y
  `EditResponse` (output_filename/output_url/output_path/output_fid).
- Thành công → `dirty=False`, cập nhật `last_commit_path` (Yêu cầu 5.2, 8.3).
- Commit lỗi → GIỮ NGUYÊN `pdf` trong RAM (vẫn dùng được), KHÔNG đụng
  `dirty`/`last_commit_path`, re-raise (Yêu cầu 5.5, 10.5).
- Session_Id không sống → `SessionNotFoundError` (Yêu cầu 2.4, 9.5).

KHÔNG phụ thuộc DB thật: cô lập tầng đăng ký UploadedFile (DB) bằng monkeypatch,
nhưng GHI FILE THẬT qua pikepdf để kiểm bất biến ghi-đĩa/không-đè-gốc là thật.

_Requirements: 5.2, 5.5, 6.2, 8.3, 10.5, 11.4_
"""
import os
import sys
import threading
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
import pytest

from app.core import edit_session
from app.core.edit_session import EditSession, SessionNotFoundError, commit


# ── Helpers ──────────────────────────────────────────────────────────────────
def _build_pdf_bytes(page_w=400.0, page_h=300.0) -> bytes:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(page_w, page_h))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"q\n0.1 0.2 0.6 rg\n100 80 60 40 re\nf\nQ\n"
    )
    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


def _make_session(tmp_path, sid="commit-sid", fid="fid-commit") -> EditSession:
    """Tạo EditSession + file gốc thật trên đĩa; đăng ký vào SESSIONS (sống)."""
    pdf_bytes = _build_pdf_bytes()
    source_path = os.path.join(str(tmp_path), "source.pdf")
    with open(source_path, "wb") as fh:
        fh.write(pdf_bytes)
    pdf = pikepdf.Pdf.open(BytesIO(pdf_bytes))
    session = EditSession(
        session_id=sid,
        source_fid=fid,
        source_path=source_path,
        pdf=pdf,
        baseline_bytes=pdf_bytes,
        lock=threading.Lock(),
        live_bytes=pdf_bytes,
        dirty=True,
    )
    edit_session.SESSIONS[sid] = session
    edit_session.by_fid[fid] = sid
    return session


def _patch_registration(monkeypatch, fid_out="fid-new-123"):
    """Cô lập tầng DB: _resolve_original_name + _register_working_file (Legacy)."""
    monkeypatch.setattr(edit_session, "_resolve_original_name", lambda fid: "MyDoc.pdf")
    import app.api.routes.edit as edit_route
    monkeypatch.setattr(edit_route, "_register_working_file", lambda path, name: fid_out)


def _cleanup_session(session: EditSession):
    edit_session.SESSIONS.pop(session.session_id, None)
    edit_session.by_fid.pop(session.source_fid, None)
    try:
        session.pdf.close()
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════
#  commit — thành công
# ═══════════════════════════════════════════════════════════════════════════
def test_commit_writes_new_working_file_and_updates_state(tmp_path, monkeypatch):
    """Commit ghi Working_File MỚI, trả output_*; dirty=False, last_commit_path set."""
    session = _make_session(tmp_path)
    _patch_registration(monkeypatch, fid_out="fid-new-123")
    written = []
    try:
        result = commit(session)

        # Trả dạng EditResponse (Yêu cầu 11.4).
        assert result["success"] is True
        assert result["output_fid"] == "fid-new-123"
        assert result["output_filename"].endswith(".pdf")
        assert result["output_url"].startswith("/results/edit_output/")
        assert result["output_filename"] in result["output_url"]

        # Working_File MỚI tồn tại thật trên đĩa và là PDF hợp lệ.
        out_path = result["output_path"]
        written.append(out_path)
        assert os.path.isabs(out_path)
        assert os.path.exists(out_path)
        with pikepdf.Pdf.open(out_path) as check:
            assert len(check.pages) == 1

        # KHÔNG đè file gốc.
        assert os.path.normcase(os.path.realpath(out_path)) != os.path.normcase(
            os.path.realpath(session.source_path)
        )
        assert os.path.exists(session.source_path)

        # Trạng thái phiên cập nhật (Yêu cầu 5.2, 8.3).
        assert session.dirty is False
        assert session.last_commit_path == out_path
    finally:
        _cleanup_session(session)
        for p in written:
            try:
                os.remove(p)
            except OSError:
                pass


def test_commit_does_not_overwrite_source_file(tmp_path, monkeypatch):
    """Bất biến: nội dung file gốc nguyên vẹn sau commit (Yêu cầu 6.2)."""
    session = _make_session(tmp_path)
    _patch_registration(monkeypatch)
    before = open(session.source_path, "rb").read()
    written = []
    try:
        result = commit(session)
        written.append(result["output_path"])
        after = open(session.source_path, "rb").read()
        assert before == after
    finally:
        _cleanup_session(session)
        for p in written:
            try:
                os.remove(p)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  commit — thất bại → giữ nguyên pdf, raise
# ═══════════════════════════════════════════════════════════════════════════
def test_commit_failure_keeps_pdf_and_raises(tmp_path, monkeypatch):
    """Save lỗi → GIỮ NGUYÊN pdf/dirty/last_commit_path, re-raise (Yêu cầu 5.5, 10.5)."""
    session = _make_session(tmp_path)
    _patch_registration(monkeypatch)

    def _boom(*a, **k):
        raise OSError("disk full (giả lập)")

    monkeypatch.setattr(edit_session.edit_io, "save_working_file", _boom)
    try:
        with pytest.raises(OSError):
            commit(session)

        # Trạng thái phiên KHÔNG đổi; Live_Document vẫn dùng được.
        assert session.dirty is True
        assert session.last_commit_path is None
        assert len(session.pdf.pages) == 1  # pdf còn sống
    finally:
        _cleanup_session(session)


def test_commit_session_gone_raises_not_found(tmp_path, monkeypatch):
    """Session_Id không còn trong store → SessionNotFoundError (Yêu cầu 2.4, 9.5)."""
    session = _make_session(tmp_path)
    _patch_registration(monkeypatch)
    # Gỡ khỏi store để mô phỏng phiên đã đóng/hết hạn.
    edit_session.SESSIONS.pop(session.session_id, None)
    try:
        with pytest.raises(SessionNotFoundError):
            commit(session)
    finally:
        edit_session.by_fid.pop(session.source_fid, None)
        try:
            session.pdf.close()
        except Exception:
            pass

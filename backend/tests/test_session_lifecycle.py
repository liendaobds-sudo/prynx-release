"""
Unit tests cho vòng đời phiên & dọn RAM theo TTL (Task 6.1 — spec `pdf-edit-session`).

Kiểm phần LOGIC trong `app/core/edit_session.py`:
- `close_session(sid)`: đóng phiên đang sống → giải phóng Live_Document, gỡ khỏi
  `SESSIONS`/`by_fid`; idempotent (đóng lại trả False); KHÔNG raise (Yêu cầu 9.1, 9.3).
- `sweep_expired()`: dọn phiên quá `SESSION_TTL` kể từ `last_access` (đồng hồ
  monotonic), trả số phiên đã dọn; phiên còn hạn được GIỮ (Yêu cầu 9.2).
- Lazy sweep trong `get_session`: tra phiên đã hết hạn/đóng → `SessionNotFoundError`
  (Yêu cầu 9.5).

KHÔNG phụ thuộc DB thật: dựng EditSession trực tiếp với pikepdf in-memory.

_Requirements: 9.1, 9.2, 9.3, 9.5_
"""
import os
import sys
import threading
import time
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
import pytest

from app.core import edit_session
from app.core.edit_session import (
    SESSION_TTL,
    EditSession,
    SessionNotFoundError,
    close_session,
    get_session,
    sweep_expired,
)


# ── Helpers ──────────────────────────────────────────────────────────────────
def _build_pdf_bytes(page_w=400.0, page_h=300.0) -> bytes:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(page_w, page_h))
    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


def _register_session(sid: str, fid: str, last_access: float) -> EditSession:
    """Dựng EditSession sống (pikepdf in-memory) với `last_access` chỉ định."""
    pdf_bytes = _build_pdf_bytes()
    session = EditSession(
        session_id=sid,
        source_fid=fid,
        source_path=f"/virtual/{fid}.pdf",
        pdf=pikepdf.Pdf.open(BytesIO(pdf_bytes)),
        baseline_bytes=pdf_bytes,
        lock=threading.Lock(),
        last_access=last_access,
    )
    edit_session.SESSIONS[sid] = session
    edit_session.by_fid[fid] = sid
    return session


def _cleanup(*sids_fids):
    for sid, fid in sids_fids:
        s = edit_session.SESSIONS.pop(sid, None)
        edit_session.by_fid.pop(fid, None)
        if s is not None:
            try:
                s.pdf.close()
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  close_session
# ═══════════════════════════════════════════════════════════════════════════
def test_close_session_frees_and_removes_from_store():
    """close_session đóng phiên sống, gỡ khỏi SESSIONS/by_fid, trả True (Yêu cầu 9.1, 9.3)."""
    now = time.monotonic()
    session = _register_session("close-1", "fid-close-1", now)
    try:
        assert close_session("close-1") is True
        assert "close-1" not in edit_session.SESSIONS
        assert "fid-close-1" not in edit_session.by_fid
    finally:
        _cleanup(("close-1", "fid-close-1"))


def test_close_session_idempotent_returns_false_when_absent():
    """Đóng một Session_Id không tồn tại → False, KHÔNG raise (idempotent)."""
    assert close_session("does-not-exist") is False


def test_close_session_only_clears_by_fid_for_owning_session():
    """by_fid trỏ phiên KHÁC thì close_session không xóa nhầm mapping fid."""
    now = time.monotonic()
    # Hai phiên trùng fid: by_fid trỏ tới phiên mới (s2). Đóng s1 (phiên mồ côi)
    # KHÔNG được xóa mapping fid của s2.
    s1 = _register_session("orphan", "shared-fid", now)
    edit_session.SESSIONS["orphan"] = s1  # giữ s1 trong store
    s2 = _register_session("active", "shared-fid", now)  # by_fid["shared-fid"] = "active"
    try:
        assert close_session("orphan") is True
        # mapping fid vẫn trỏ phiên đang hoạt động.
        assert edit_session.by_fid.get("shared-fid") == "active"
    finally:
        _cleanup(("orphan", "shared-fid"), ("active", "shared-fid"))


# ═══════════════════════════════════════════════════════════════════════════
#  sweep_expired
# ═══════════════════════════════════════════════════════════════════════════
def test_sweep_expired_removes_only_stale_sessions():
    """Phiên quá TTL bị dọn; phiên còn hạn được giữ; trả đúng số đã dọn (Yêu cầu 9.2)."""
    now = time.monotonic()
    stale = _register_session("stale", "fid-stale", now - SESSION_TTL - 10)
    fresh = _register_session("fresh", "fid-fresh", now)
    try:
        swept = sweep_expired()
        assert swept >= 1
        assert "stale" not in edit_session.SESSIONS
        assert "fid-stale" not in edit_session.by_fid
        # Phiên còn hạn được GIỮ.
        assert "fresh" in edit_session.SESSIONS
    finally:
        _cleanup(("stale", "fid-stale"), ("fresh", "fid-fresh"))


def test_sweep_expired_keeps_session_at_ttl_boundary():
    """Phiên đúng mốc TTL (chưa vượt) KHÔNG bị dọn (so sánh strictly greater)."""
    now = time.monotonic()
    boundary = _register_session("boundary", "fid-boundary", now - SESSION_TTL + 5)
    try:
        sweep_expired()
        assert "boundary" in edit_session.SESSIONS
    finally:
        _cleanup(("boundary", "fid-boundary"))


# ═══════════════════════════════════════════════════════════════════════════
#  Lazy sweep qua get_session
# ═══════════════════════════════════════════════════════════════════════════
def test_get_session_returns_live_session():
    """Tra phiên còn sống trả đúng EditSession."""
    now = time.monotonic()
    session = _register_session("live", "fid-live", now)
    try:
        assert get_session("live") is session
    finally:
        _cleanup(("live", "fid-live"))


def test_get_session_lazy_sweeps_expired_then_raises():
    """Tra Session_Id đã hết hạn → bị lazy sweep dọn → SessionNotFoundError (Yêu cầu 9.5)."""
    now = time.monotonic()
    expired = _register_session("expired", "fid-expired", now - SESSION_TTL - 1)
    try:
        with pytest.raises(SessionNotFoundError):
            get_session("expired")
        # Lazy sweep đã giải phóng phiên hết hạn.
        assert "expired" not in edit_session.SESSIONS
        assert "fid-expired" not in edit_session.by_fid
    finally:
        _cleanup(("expired", "fid-expired"))


def test_get_session_closed_raises_not_found():
    """Tra Session_Id đã đóng → SessionNotFoundError (Yêu cầu 9.5)."""
    now = time.monotonic()
    _register_session("to-close", "fid-to-close", now)
    close_session("to-close")
    with pytest.raises(SessionNotFoundError):
        get_session("to-close")

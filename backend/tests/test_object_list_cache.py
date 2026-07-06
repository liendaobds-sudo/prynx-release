"""
Unit tests cho cache TTL + LRU của `_object_list_cache` (audit RAM 2026-07-06, mục #5).

Kiểm LOGIC cache trong `app/api/routes/edit.py`:
- `_set_cached_objects` / `_get_cached_objects`: set→get trả payload; miss trả None.
- TTL: entry quá `OBJ_CACHE_TTL` bị coi như miss (pop khi truy cập).
- LRU cap: vượt `OBJ_CACHE_MAXSIZE` → bỏ entry CŨ NHẤT; `get` đánh dấu vừa dùng
  (move_to_end) nên entry được đọc gần đây sống sót.
- `_invalidate_object_cache`: xóa per-(fid,page) hoặc toàn bộ fid.

Cache là dict module-level → fixture clear trước/sau mỗi test để không rò trạng thái.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from app.api.routes import edit


@pytest.fixture(autouse=True)
def _clear_cache():
    with edit._OBJ_CACHE_LOCK:
        edit._object_list_cache.clear()
    yield
    with edit._OBJ_CACHE_LOCK:
        edit._object_list_cache.clear()


def _payload(n: int) -> dict:
    return {"objects": [{"id": f"o{n}"}], "pageBox": None}


# ── set/get cơ bản ────────────────────────────────────────────────────────────
def test_set_then_get_returns_payload():
    edit._set_cached_objects("fid-a", 0, _payload(1))
    assert edit._get_cached_objects("fid-a", 0) == _payload(1)


def test_get_missing_returns_none():
    assert edit._get_cached_objects("nope", 3) is None


# ── TTL ───────────────────────────────────────────────────────────────────────
def test_get_expired_entry_returns_none_and_evicts():
    """Entry quá TTL → get trả None và pop khỏi cache (rebuild lần sau)."""
    edit._set_cached_objects("fid-ttl", 0, _payload(1))
    # Giả lập entry cũ: viết lại timestamp lùi quá TTL.
    with edit._OBJ_CACHE_LOCK:
        _, payload = edit._object_list_cache[("fid-ttl", 0)]
        edit._object_list_cache[("fid-ttl", 0)] = (
            time.monotonic() - edit.OBJ_CACHE_TTL - 10.0,
            payload,
        )
    assert edit._get_cached_objects("fid-ttl", 0) is None
    with edit._OBJ_CACHE_LOCK:
        assert ("fid-ttl", 0) not in edit._object_list_cache


def test_get_fresh_entry_within_ttl_survives():
    edit._set_cached_objects("fid-fresh", 0, _payload(1))
    assert edit._get_cached_objects("fid-fresh", 0) == _payload(1)


# ── LRU cap ───────────────────────────────────────────────────────────────────
def test_set_beyond_maxsize_evicts_oldest(monkeypatch):
    monkeypatch.setattr(edit, "OBJ_CACHE_MAXSIZE", 3)
    for p in range(3):
        edit._set_cached_objects("f", p, _payload(p))
    # Thêm entry thứ 4 → bỏ entry cũ nhất (f,0).
    edit._set_cached_objects("f", 3, _payload(3))
    with edit._OBJ_CACHE_LOCK:
        assert len(edit._object_list_cache) == 3
    assert edit._get_cached_objects("f", 0) is None
    assert edit._get_cached_objects("f", 3) == _payload(3)


def test_get_marks_recently_used_and_survives_eviction(monkeypatch):
    """get() move_to_end → entry đọc gần đây KHÔNG bị coi là cũ nhất."""
    monkeypatch.setattr(edit, "OBJ_CACHE_MAXSIZE", 3)
    edit._set_cached_objects("f", 0, _payload(0))
    edit._set_cached_objects("f", 1, _payload(1))
    edit._set_cached_objects("f", 2, _payload(2))
    # Đọc (f,0) → chuyển thành mới nhất; (f,1) giờ là cũ nhất.
    assert edit._get_cached_objects("f", 0) == _payload(0)
    edit._set_cached_objects("f", 3, _payload(3))  # vượt cap → bỏ (f,1)
    assert edit._get_cached_objects("f", 1) is None
    assert edit._get_cached_objects("f", 0) == _payload(0)  # sống sót


# ── invalidate ────────────────────────────────────────────────────────────────
def test_invalidate_single_page():
    edit._set_cached_objects("fid-x", 0, _payload(0))
    edit._set_cached_objects("fid-x", 1, _payload(1))
    edit._invalidate_object_cache("fid-x", 0)
    assert edit._get_cached_objects("fid-x", 0) is None
    assert edit._get_cached_objects("fid-x", 1) == _payload(1)


def test_invalidate_whole_fid():
    edit._set_cached_objects("fid-y", 0, _payload(0))
    edit._set_cached_objects("fid-y", 1, _payload(1))
    edit._set_cached_objects("fid-z", 0, _payload(9))
    edit._invalidate_object_cache("fid-y")  # page=None → xóa mọi trang của fid-y
    assert edit._get_cached_objects("fid-y", 0) is None
    assert edit._get_cached_objects("fid-y", 1) is None
    assert edit._get_cached_objects("fid-z", 0) == _payload(9)  # fid khác còn nguyên

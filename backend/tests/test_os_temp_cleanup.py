"""
Unit tests cho dọn OS temp theo whitelist prefix (audit RAM 2026-07-06, mục #6).

Kiểm `_cleanup_os_temp_by_prefix` trong `app/core/cleanup.py`:
- CHỈ xóa file khớp một prefix trong `APP_TEMP_PREFIXES` (riêng của app).
- TUYỆT ĐỐI không đụng file prefix khác (tmp*, file tiến trình khác).
- CHỈ xóa file cũ hơn ngưỡng; file mới được GIỮ.
- KHÔNG đệ quy — file trong thư mục con của OS temp KHÔNG bị đụng.

Dùng tmp_path (thư mục tạm pytest) + monkeypatch tempfile.gettempdir → cô lập,
không đụng OS temp thật.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from app.core import cleanup


def _touch(path, age_seconds: float, size: int = 10):
    """Tạo file với nội dung + đặt mtime lùi `age_seconds` so với hiện tại."""
    path.write_bytes(b"x" * size)
    past = time.time() - age_seconds
    os.utime(path, (past, past))


@pytest.fixture
def fake_temp(tmp_path, monkeypatch):
    """Trỏ tempfile.gettempdir() vào thư mục tạm cô lập của test."""
    monkeypatch.setattr(cleanup.tempfile, "gettempdir", lambda: str(tmp_path))
    return tmp_path


# ── Xóa file app cũ ────────────────────────────────────────────────────────────
def test_deletes_old_app_prefixed_files(fake_temp):
    old = fake_temp / "vdp_prog_job123.txt"
    _touch(old, age_seconds=48 * 3600)  # 48h — quá ngưỡng 12h
    deleted, freed = cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600)
    assert deleted == 1
    assert freed == 10
    assert not old.exists()


def test_deletes_every_whitelisted_prefix(fake_temp):
    names = [
        "vdp_preview_a.pdf", "vdp_preview_tpl_b.pdf", "vdp_chunk_c.pdf",
        "vdp_canon_d.pdf", "vdp_prog_e.txt", "nup_prog_f.txt", "nup_state_g.txt",
    ]
    for n in names:
        _touch(fake_temp / n, age_seconds=48 * 3600)
    deleted, _ = cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600)
    assert deleted == len(names)


# ── GIỮ file mới ────────────────────────────────────────────────────────────────
def test_keeps_recent_app_files(fake_temp):
    recent = fake_temp / "vdp_chunk_fresh.pdf"
    _touch(recent, age_seconds=1 * 3600)  # 1h — chưa quá ngưỡng 12h
    deleted, _ = cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600)
    assert deleted == 0
    assert recent.exists()


# ── AN TOÀN: không đụng file tiến trình khác ────────────────────────────────────
def test_never_touches_non_app_files(fake_temp):
    """File prefix khác (tmp*, tên tùy ý) KHÔNG bao giờ bị xóa dù rất cũ."""
    others = ["tmpABCDEF.pdf", "some_other_app.log", "python_xyz.tmp", "important.dat"]
    for n in others:
        _touch(fake_temp / n, age_seconds=999 * 3600)  # cực cũ
    deleted, _ = cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600)
    assert deleted == 0
    for n in others:
        assert (fake_temp / n).exists()


def test_mixed_app_and_foreign_only_removes_app(fake_temp):
    _touch(fake_temp / "vdp_prog_old.txt", age_seconds=48 * 3600)
    _touch(fake_temp / "tmp_foreign.pdf", age_seconds=48 * 3600)
    deleted, _ = cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600)
    assert deleted == 1
    assert not (fake_temp / "vdp_prog_old.txt").exists()
    assert (fake_temp / "tmp_foreign.pdf").exists()


# ── AN TOÀN: không đệ quy ────────────────────────────────────────────────────────
def test_does_not_recurse_into_subdirs(fake_temp):
    """File app-prefix nằm trong thư mục con KHÔNG bị đụng (chỉ quét tầng gốc)."""
    subdir = fake_temp / "other_process_dir"
    subdir.mkdir()
    nested = subdir / "vdp_chunk_nested.pdf"
    _touch(nested, age_seconds=48 * 3600)
    deleted, _ = cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600)
    assert deleted == 0
    assert nested.exists()


def test_missing_temp_dir_returns_zero(monkeypatch, tmp_path):
    """gettempdir trỏ đường dẫn không tồn tại → trả (0,0), không raise."""
    monkeypatch.setattr(cleanup.tempfile, "gettempdir", lambda: str(tmp_path / "nope"))
    assert cleanup._cleanup_os_temp_by_prefix(time.time(), 12 * 3600) == (0, 0)

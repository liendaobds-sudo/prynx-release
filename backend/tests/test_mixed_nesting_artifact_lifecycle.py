"""Vòng đời file xuất: startup, sweep định kỳ, shutdown — phase P14b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §12.4, §16.3.

Bốn nhóm, khớp từng câu của gate P14b:

1. **Startup/periodic/shutdown được đăng ký RÕ** trong `main.py` — kiểm bằng cách đọc chính
   `main.py`, vì đây là thứ dễ bị bỏ quên nhất khi refactor lifespan.
2. **File đang stream được bảo vệ** khỏi sweeper.
3. **Restart / stale / pressure / cancel không để lại file rác.**
4. **Root không an toàn thì TẮT TÍNH NĂNG, không giết sidecar.** Đánh sập cả app vì một biến
   môi trường sai là phản ứng quá mức, và làm mọi tính năng khác chết oan.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from app.core.mixed_nesting_artifacts import (
    ARTIFACT_TTL_SECONDS,
    DATA_DIR_ENV,
    MixedNestingArtifactStore,
    reset_artifact_store,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MAIN_PY = _REPO_ROOT / "backend" / "app" / "main.py"


@pytest.fixture()
def store(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    instance = MixedNestingArtifactStore(root=tmp_path / "mn_data", ttl_seconds=300.0)
    instance.ensure_root()
    try:
        yield instance
    finally:
        instance.close()
        instance.purge_root()


def _publish(store: MixedNestingArtifactStore, artifact_id: str, owner: str = "owner-a") -> None:
    store.publish(
        artifact_id=artifact_id,
        owner=owner,
        job_id=f"job-{artifact_id}",
        source_revision="rev1",
        payload=b"%PDF-1.7\n" + b"x" * 512,
        sheet_count=1,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  1. Đăng ký trong lifespan
# ─────────────────────────────────────────────────────────────────────────────


def test_main_dang_ky_du_ba_moc_lifecycle():
    source = _MAIN_PY.read_text(encoding="utf-8")

    # Startup: dựng root + dọn file mồ côi của lần chạy trước.
    assert "ensure_root" in source
    assert "sweep_orphan_files" in source
    # Periodic: có task quét TTL.
    assert "_mixed_nesting_sweep_loop" in source
    assert "mixed_nesting_sweep_task" in source
    assert "sweep_now" in source
    # Shutdown: hủy task, chờ nó chết hẳn, đóng registry job, dọn nguồn, dọn artifact.
    assert "mn_sweep_task.cancel()" in source
    assert "asyncio.gather(mn_sweep_task, return_exceptions=True)" in source
    assert "mixed_nesting_jobs.close" in source
    assert "mixed_nesting_sources.clear" in source


def test_startup_khong_giet_sidecar_khi_root_khong_an_toan():
    """Root sai ⇒ chỉ tắt tính năng. Kiểm bằng cấu trúc: `ArtifactRootUnsafe` được bắt."""
    source = _MAIN_PY.read_text(encoding="utf-8")
    assert "except ArtifactRootUnsafe" in source
    assert "mixed_nesting_artifacts_ready" in source
    # Cờ phải được đặt False trước khi thử, để nhánh shutdown không dọn cái chưa dựng.
    assert "app.state.mixed_nesting_artifacts_ready = False" in source


def test_sweep_dinh_ky_khong_qua_day_hay_qua_thua():
    """TTL 2 giờ; chu kỳ quét 10 phút là mức đã cân nhắc, không phải số ngẫu nhiên."""
    source = _MAIN_PY.read_text(encoding="utf-8")
    assert "SWEEP_INTERVAL_SECONDS = 600" in source
    assert ARTIFACT_TTL_SECONDS == 2 * 60 * 60


def test_shutdown_dong_theo_dung_thu_tu():
    """Hủy sweeper TRƯỚC khi dọn artifact: ngược lại thì sweeper có thể chạy sau khi đã dọn."""
    source = _MAIN_PY.read_text(encoding="utf-8")
    cancel_at = source.index("mn_sweep_task.cancel()")
    close_at = source.index("_store().close")
    assert cancel_at < close_at, "phải hủy sweeper trước khi đóng store"


# ─────────────────────────────────────────────────────────────────────────────
#  2. File đang stream được bảo vệ
# ─────────────────────────────────────────────────────────────────────────────


def test_sweep_ttl_khong_xoa_file_dang_stream(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    # TTL ngắn nhưng KHÁC 0: với ttl=0 thì `get()` bên trong `open_for_read` đã tự quét sạch
    # trước khi stream kịp bắt đầu, nên test sẽ không kiểm được điều nó muốn kiểm.
    instance = MixedNestingArtifactStore(root=tmp_path / "mn_data", ttl_seconds=0.05)
    instance.ensure_root()
    try:
        _publish(instance, "s1")
        reader = instance.open_for_read("s1", "owner-a")
        first = next(reader)  # bắt đầu stream ⇒ readers = 1

        # Vượt TTL trong lúc vẫn đang tải. `time.monotonic` trên Windows nhảy ~15,6 ms nên
        # ngủ 0,12 s mới chắc chắn quá hạn.
        time.sleep(0.12)
        instance.sweep_now()
        assert (instance.root / "s1.pdf").is_file(), "sweeper xoá file đang tải"

        rest = b"".join(reader)  # đóng stream ⇒ readers = 0
        assert len(first) + len(rest) == 9 + 512

        # Sau khi đã đóng, lần quét tiếp mới được dọn.
        instance.sweep_now()
        assert instance.get("s1", "owner-a") is None
    finally:
        instance.close()
        instance.purge_root()


def test_quota_khong_xoa_file_dang_stream(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    # Payload là 521 byte/artifact. Trần 1100 để con thứ BA buộc phải dọn chỗ, không phải
    # con thứ tư — nếu trần rộng hơn tổng ba con thì `_make_room` không chạy và test mù.
    instance = MixedNestingArtifactStore(
        root=tmp_path / "mn_data", ttl_seconds=300.0, max_total_bytes=1100
    )
    instance.ensure_root()
    try:
        _publish(instance, "q1")
        reader = instance.open_for_read("q1", "owner-a")
        next(reader)

        _publish(instance, "q2")
        _publish(instance, "q3")
        # `q1` đang stream nên phải còn; `q2` là cái cũ nhất KHÔNG stream nên bị dọn.
        assert instance.get("q1", "owner-a") is not None
        assert instance.get("q2", "owner-a") is None
        b"".join(reader)
    finally:
        instance.close()
        instance.purge_root()


# ─────────────────────────────────────────────────────────────────────────────
#  3. Restart / stale / pressure / cancel không để rác
# ─────────────────────────────────────────────────────────────────────────────


def test_restart_don_file_mo_coi(store):
    """Sidecar restart: registry rỗng nhưng file cũ còn nằm trong root."""
    _publish(store, "r1")
    _publish(store, "r2")
    # Giả lập restart: registry mất, file còn.
    store._artifacts.clear()  # noqa: SLF001 - mô phỏng đúng trạng thái sau restart
    assert len(list(store.root.glob("*.pdf"))) == 2

    removed = store.sweep_orphan_files()
    assert removed == 2
    assert list(store.root.glob("*.pdf")) == []


def test_sweep_mo_coi_khong_cham_file_dang_ghi_nhan(store):
    _publish(store, "keep")
    (store.root / "rac.pdf").write_bytes(b"%PDF-1.7\nx")
    assert store.sweep_orphan_files() == 1
    assert (store.root / "keep.pdf").is_file()


def test_shutdown_don_sach_moi_artifact(store):
    _publish(store, "c1")
    _publish(store, "c2")
    store.close()
    assert list(store.root.glob("*.pdf")) == []
    # Idempotent: gọi lần hai vô hại.
    store.close()


def test_ghi_that_bai_khong_de_lai_partial(store, monkeypatch):
    import os

    real_replace = os.replace
    monkeypatch.setattr(os, "replace", lambda *_args: (_ for _ in ()).throw(OSError("gia lap")))
    with pytest.raises(OSError):
        _publish(store, "x1")
    monkeypatch.setattr(os, "replace", real_replace)
    assert list(store.root.iterdir()) == []


def test_ttl_dung_dong_ho_monotonic(store):
    """TTL không được dùng ``time.time``: đổi giờ hệ thống sẽ làm file biến mất hoặc sống mãi."""
    source = (
        _REPO_ROOT / "backend" / "app" / "core" / "mixed_nesting_artifacts.py"
    ).read_text(encoding="utf-8")
    assert "time.monotonic" in source
    # `created_at` được phép dùng time.time (để hiển thị), nhưng `updated_at` thì không.
    assert "updated_at: float = field(default_factory=time.monotonic)" in source


def test_doc_lai_gia_han_ttl(store):
    _publish(store, "t1")
    record = store.get("t1", "owner-a")
    assert record is not None
    truoc = record.updated_at
    # `time.monotonic` trên Windows lấy từ GetTickCount64, phân giải ~15,6 ms: ngủ 10 ms có
    # thể cho ra ĐÚNG cùng một giá trị.
    time.sleep(0.05)
    store.get("t1", "owner-a")
    assert store._artifacts["t1"].updated_at > truoc  # noqa: SLF001


# ─────────────────────────────────────────────────────────────────────────────
#  4. Singleton và cấu hình
# ─────────────────────────────────────────────────────────────────────────────


def test_singleton_dung_muon_va_reset_duoc(monkeypatch, tmp_path):
    """Lỗi cấu hình root không được làm sập lúc import module."""
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path / "mn_singleton"))
    reset_artifact_store()
    try:
        from app.core.mixed_nesting_artifacts import artifact_store

        first = artifact_store()
        assert artifact_store() is first, "phải là singleton"
        assert first.root == (tmp_path / "mn_singleton").resolve()
    finally:
        reset_artifact_store()


def test_env_var_duoc_ghi_vao_tai_lieu():
    """Quy ước dự án: biến env mới phải có trong ``docs/CAU_HINH_ENV.md`` cùng lô."""
    doc = (_REPO_ROOT / "docs" / "CAU_HINH_ENV.md").read_text(encoding="utf-8")
    for name in (
        DATA_DIR_ENV,
        "PRYNX_MIXED_NESTING_ENABLED",
        "PRYNX_MIXED_NEST_WORKERS",
        "PRYNX_MAX_MIXED_NESTING_QUEUE",
    ):
        assert name in doc, f"thiếu {name} trong docs/CAU_HINH_ENV.md"

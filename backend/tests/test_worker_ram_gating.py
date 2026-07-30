"""RAM-gating cho worker pool việc nặng — PERF (audit 2026-07-29 §C.3).

Bất biến rule #1 (AGENTS.md): máy yếu mới điều chỉnh, máy >=16 GB chạy hết công suất.
Test này chặn hồi quy theo CẢ HAI chiều — vừa không để máy yếu mở quá nhiều process,
vừa không để ai âm thầm hạ trần của máy mạnh.
"""

import pytest

from app.core import system_memory as sm


@pytest.fixture
def gia_lap_ram(monkeypatch):
    """Ép `read_memory_status_mb` trả (tổng, khả dụng) theo MiB."""

    def _set(total_mb, available_mb):
        monkeypatch.setattr(
            sm, "read_memory_status_mb", lambda: (total_mb, available_mb)
        )

    return _set


def _workers(**kwargs):
    kwargs.setdefault("kind", "test")
    kwargs.setdefault("per_worker_mb", 1024.0)
    kwargs.setdefault("cpu_count", 16)
    return sm.plan_worker_count(**kwargs)[0]


def test_may_manh_khong_bi_ha_tran(gia_lap_ram):
    """>=16 GB: giữ nguyên `cpu_count - 1`, kể cả khi RAM khả dụng đang thấp.

    Đây là chốt chống hồi quy máy mạnh: bản nháp đầu của §C.3 áp trần theo RAM khả dụng
    ở mọi tier, làm worker bình bản trên máy 32 GB tụt 15 → 8.
    """
    gia_lap_ram(32 * 1024.0, 14 * 1024.0)
    assert _workers() == 15

    gia_lap_ram(32 * 1024.0, 3 * 1024.0)  # máy mạnh nhưng đang bí RAM
    assert _workers() == 15

    gia_lap_ram(64 * 1024.0, 60 * 1024.0)
    assert _workers() == 15


def test_may_duoi_8gb_chi_mot_worker(gia_lap_ram):
    gia_lap_ram(6 * 1024.0, 2 * 1024.0)
    assert _workers() == 1


def test_may_duoi_16gb_toi_da_hai_worker(gia_lap_ram):
    gia_lap_ram(12 * 1024.0, 8 * 1024.0)
    assert _workers() == 2


def test_may_yeu_con_bi_ha_theo_ram_kha_dung(gia_lap_ram):
    """<16 GB và gần hết RAM → hạ tiếp xuống 1 (0.6 * 1024 / 1024 < 2)."""
    gia_lap_ram(12 * 1024.0, 1024.0)
    assert _workers() == 1


def test_khong_doc_duoc_ram_giu_hanh_vi_cu(gia_lap_ram):
    """Không đoán: mất thông tin RAM thì hành vi y như trước khi có hàm này."""
    gia_lap_ram(None, None)
    assert _workers() == 15


def test_hard_ceiling_va_env_override(gia_lap_ram, monkeypatch):
    gia_lap_ram(32 * 1024.0, 20 * 1024.0)
    assert _workers(hard_ceiling=8) == 8

    # env ép được CẢ chiều tăng — người vận hành biết máy mình.
    monkeypatch.setenv("PRYNX_TEST_WORKERS", "12")
    assert _workers(hard_ceiling=2, env_override="PRYNX_TEST_WORKERS") == 12

    monkeypatch.setenv("PRYNX_TEST_WORKERS", "rac")
    assert _workers(hard_ceiling=8, env_override="PRYNX_TEST_WORKERS") == 8


def test_luon_it_nhat_mot_worker(gia_lap_ram):
    gia_lap_ram(2 * 1024.0, 128.0)
    assert _workers(cpu_count=1) == 1

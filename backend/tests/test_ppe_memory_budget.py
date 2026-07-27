"""Gate phần cứng cho ngân sách RAM của PPE."""

from __future__ import annotations

import pytest

from app.config import settings
from app.core.print_engine import facade


@pytest.mark.parametrize(
    "total_gb,available_gb,expected",
    [
        (4, 3, 384),
        (12, 8, 1024),
        # Máy mạnh không còn trần 512 MiB: 24 GiB khả dụng × 75%.
        (32, 24, 18 * 1024),
    ],
)
def test_auto_memory_budget_follows_ram_tier(total_gb, available_gb, expected):
    assert facade._auto_memory_budget_mb(
        total_gb * 1024.0,
        available_gb * 1024.0,
    ) == expected


def test_high_ram_budget_has_no_artificial_ceiling():
    budget_32 = facade._auto_memory_budget_mb(32 * 1024.0, 24 * 1024.0)
    budget_128 = facade._auto_memory_budget_mb(128 * 1024.0, 100 * 1024.0)
    assert budget_32 > 512
    assert budget_128 > budget_32


def test_available_ram_pressure_can_reduce_high_tier_budget():
    assert facade._auto_memory_budget_mb(32 * 1024.0, 600.0) == 512


def test_unknown_hardware_uses_conservative_fallback():
    assert facade._auto_memory_budget_mb(None, None) == 512


def test_explicit_override_wins(monkeypatch):
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", 1536)
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (4 * 1024.0, 2 * 1024.0),
    )
    assert facade._memory_budget_mb() == 1536


def test_auto_policy_reads_system_memory(monkeypatch):
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", None)
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (32 * 1024.0, 20 * 1024.0),
    )
    monkeypatch.setattr("app.core.heavy_job_scheduler.max_active_heavy_jobs", lambda: 1)
    assert facade._memory_budget_mb() == 15 * 1024


def test_budget_is_divided_across_concurrent_heavy_jobs(monkeypatch):
    """PERF §A.5: trần là cho MỘT lần render, nên N việc song song phải chia nhau.

    Không chia thì hai job cùng cam kết 15 GiB trên máy còn 20 GiB trống — trần
    ngừng bảo vệ đúng lúc máy căng nhất.
    """
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", None)
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (32 * 1024.0, 20 * 1024.0),
    )
    monkeypatch.setattr("app.core.heavy_job_scheduler.max_active_heavy_jobs", lambda: 4)
    assert facade._memory_budget_mb() == 3840  # 20 GiB × 0,75 / 4


def test_slot_division_keeps_tier_floor():
    """Máy nhiều slot vẫn không bị hạ xuống dưới sàn của tier."""
    assert facade._auto_memory_budget_mb(32 * 1024.0, 20 * 1024.0, 64) == 512
    assert facade._auto_memory_budget_mb(4 * 1024.0, 3 * 1024.0, 8) == 256


def test_concurrency_of_one_matches_previous_policy():
    single = facade._auto_memory_budget_mb(32 * 1024.0, 20 * 1024.0, 1)
    assert single == 15 * 1024
    assert facade._auto_memory_budget_mb(12 * 1024.0, 8 * 1024.0, 1) == 1024


def test_non_positive_override_is_rejected(monkeypatch):
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", 0)
    with pytest.raises(ValueError, match="greater than zero"):
        facade._memory_budget_mb()

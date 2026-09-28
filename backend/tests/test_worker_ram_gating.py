"""RAM-gating cho worker pool việc nặng — PERF (audit 2026-07-29 §C.3).

Bất biến rule #1 (AGENTS.md): máy yếu mới điều chỉnh, máy >=16 GB chạy hết công suất.
Test này chặn hồi quy theo CẢ HAI chiều — vừa không để máy yếu mở quá nhiều process,
vừa không để ai âm thầm hạ trần của máy mạnh.
"""

import ctypes
import os
from types import SimpleNamespace

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


def test_working_set_budget_preserves_full_small_file_and_reacts_to_pressure(gia_lap_ram):
    gia_lap_ram(32 * 1024.0, 20 * 1024.0)
    budget = sm.process_pool_budget_mb()
    assert budget > 15 * sm.estimate_pdf_worker_mb(20 * 1024 * 1024)
    assert budget < 15 * sm.estimate_pdf_worker_mb(1400 * 1024 * 1024)
    gia_lap_ram(32 * 1024.0, 512.0)
    assert sm.process_pool_budget_mb() == 0.0
    gia_lap_ram(None, None)
    assert sm.process_pool_budget_mb() is None


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


@pytest.fixture
def gia_lap_ram_lap_dat(monkeypatch):
    """Giả lập API Windows, giữ helper ctypes và các nhánh planner thật."""
    monkeypatch.setattr(
        sm, "os", SimpleNamespace(name="nt", cpu_count=lambda: 16, environ=os.environ)
    )
    if not hasattr(ctypes, "windll"):
        monkeypatch.setattr(
            ctypes, "windll", SimpleNamespace(kernel32=SimpleNamespace()), raising=False
        )

    def _set(installed_mb, *, success=True, error=None):
        def read_installed(memory_kib):
            if error is not None:
                raise error
            assert isinstance(memory_kib._obj, ctypes.c_ulonglong)
            memory_kib._obj.value = int(installed_mb * 1024)
            return int(success)

        monkeypatch.setattr(
            ctypes.windll.kernel32,
            "GetPhysicallyInstalledSystemMemory",
            read_installed,
            raising=False,
        )
        return read_installed

    return _set


# PERF (audit 2026-09-28 §PERF28.03): RAM dành cho phần cứng không đổi hạng máy.
@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "available_mb", "expected"),
    [
        (8192, 7952, 5964, 2),
        (16384, 16144, 12000, 15),
        (16384, 14336, 12000, 15),
        (6144, 5904, 4000, 1),
        (12288, 12048, 8000, 2),
        (12288, 12048, 512, 1),
        (32768, 32528, 512, 15),
        (65536, 65296, 48000, 15),
    ],
)
def test_installed_ram_tier(
    gia_lap_ram, gia_lap_ram_lap_dat, installed_mb, usable_mb, available_mb, expected
):
    gia_lap_ram(usable_mb, available_mb)
    gia_lap_ram_lap_dat(installed_mb)

    assert _workers(per_worker_mb=256.0) == expected


def test_installed_api_kib_va_con_tro_64_bit(gia_lap_ram_lap_dat):
    api = gia_lap_ram_lap_dat(16384.5)

    assert sm.read_installed_memory_mb() == 16384.5
    assert api.argtypes == [ctypes.POINTER(ctypes.c_ulonglong)]
    assert api.restype is ctypes.c_int


@pytest.mark.parametrize(
    ("installed_mb", "success", "error"),
    [(16384, False, None), (0, True, None), (16384, True, OSError("SMBIOS lỗi"))],
)
def test_installed_api_loi_fallback_usable(
    gia_lap_ram, gia_lap_ram_lap_dat, installed_mb, success, error
):
    gia_lap_ram(16144, 12000)
    gia_lap_ram_lap_dat(installed_mb, success=success, error=error)

    assert sm.read_installed_memory_mb() is None
    assert _workers() == 2


def test_installed_nho_hon_usable_khong_duoc_tin(gia_lap_ram, gia_lap_ram_lap_dat):
    gia_lap_ram(12288, 8000)
    gia_lap_ram_lap_dat(4096)

    assert _workers() == 2


def test_installed_khong_windows_khong_doi_policy(gia_lap_ram, monkeypatch):
    monkeypatch.setattr(sm, "os", SimpleNamespace(name="posix"))
    gia_lap_ram(7952, 5964)

    assert sm.read_installed_memory_mb() is None
    assert _workers() == 1


@pytest.mark.parametrize("installed_mb", [6144, 16384])
@pytest.mark.parametrize("available_mb", [None, 512])
def test_usable_khong_doc_duoc_giu_policy_cu(
    gia_lap_ram, gia_lap_ram_lap_dat, installed_mb, available_mb
):
    gia_lap_ram(None, available_mb)
    gia_lap_ram_lap_dat(installed_mb)

    assert _workers() == 15


def test_installed_tier_khong_doi_ceiling_env_cpu(gia_lap_ram, gia_lap_ram_lap_dat, monkeypatch):
    gia_lap_ram(16144, 12000)
    gia_lap_ram_lap_dat(16384)

    assert _workers(cpu_count=1) == 1
    assert _workers(hard_ceiling=8) == 8
    monkeypatch.setenv("PRYNX_TEST_WORKERS", "12")
    assert _workers(hard_ceiling=2, env_override="PRYNX_TEST_WORKERS") == 12
    for raw in ("0", "-2", "rac"):
        monkeypatch.setenv("PRYNX_TEST_WORKERS", raw)
        assert _workers(hard_ceiling=8, env_override="PRYNX_TEST_WORKERS") == 8


def test_log_phan_biet_installed_usable_tier(gia_lap_ram, gia_lap_ram_lap_dat):
    gia_lap_ram(16144, 12000)
    gia_lap_ram_lap_dat(16384)

    workers, reason = sm.plan_worker_count(kind="test", per_worker_mb=256, cpu_count=16)

    assert workers == 15
    assert "ram_installed_mb=16384" in reason
    assert "ram_usable_mb=16144" in reason
    assert "ram_tier_mb=16384" in reason


@pytest.mark.parametrize("installed_mb", [0, 16384, 65536])
def test_bo_doc_usable_available_khong_bi_doi(gia_lap_ram_lap_dat, monkeypatch, installed_mb):
    gia_lap_ram_lap_dat(installed_mb)

    def read_status(pointer):
        pointer._obj.ullTotalPhys = 16144 * 1024 * 1024
        pointer._obj.ullAvailPhys = 512 * 1024 * 1024
        return 1

    monkeypatch.setattr(ctypes.windll.kernel32, "GlobalMemoryStatusEx", read_status, raising=False)

    assert sm.read_memory_status_mb() == (16144, 512)
    assert sm.process_pool_budget_mb() == pytest.approx(307.2)


@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "available_mb", "expected_budget", "expected_workers"),
    [(16384, 16144, 12000, 7200, 15), (16384, 16144, 512, 307.2, 1), (32768, 32528, 512, 0, 0)],
)
def test_installed_full_tier_van_admit_theo_ram_that(
    gia_lap_ram, gia_lap_ram_lap_dat, installed_mb, usable_mb, available_mb,
    expected_budget, expected_workers,
):
    from app.core import heavy_job_scheduler as sched

    gia_lap_ram(usable_mb, available_mb)
    gia_lap_ram_lap_dat(installed_mb)
    planned = _workers(per_worker_mb=256)
    assert planned == 15
    assert sm.process_pool_budget_mb() == pytest.approx(expected_budget)

    if expected_workers == 0:
        with pytest.raises(sched.HeavyJobMemoryUnavailable):
            with sched.process_pool_admission("test-installed-ram", planned, 256):
                pytest.fail("Không được chạy khi ngân sách RAM bằng 0.")
    else:
        with sched.process_pool_admission("test-installed-ram", planned, 256) as admitted:
            assert admitted == expected_workers
    assert "test-installed-ram" not in sched._RESERVED_MEMORY_MB_BY_KIND
    assert "test-installed-ram" not in sched._MEMORY_CAPACITY_MB_BY_KIND


def test_installed_full_tier_khong_bo_guard_file_qua_lon(gia_lap_ram, gia_lap_ram_lap_dat):
    from app.core import heavy_job_scheduler as sched

    gia_lap_ram(16144, 512)
    gia_lap_ram_lap_dat(16384)
    planned = _workers(per_worker_mb=1024)
    assert planned == 15

    with pytest.raises(sched.HeavyJobMemoryUnavailable):
        with sched.process_pool_admission("test-installed-ram", planned, 1024):
            pytest.fail("Không được chạy khi một worker vượt ngân sách RAM thật.")


@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "available_mb", "expected"),
    [(8192, 7952, 5964, 2), (16384, 16144, 12000, 15), (6144, 5904, 4000, 1)],
)
def test_vdp_nup_ke_thua_tier_lap_dat(
    gia_lap_ram, gia_lap_ram_lap_dat, monkeypatch, installed_mb, usable_mb, available_mb, expected
):
    from app.workers.nup_engine import _plan_nup_chunking
    from app.workers.vdp_engine import _plan_vdp_parallelism

    gia_lap_ram(usable_mb, available_mb)
    gia_lap_ram_lap_dat(installed_mb)
    monkeypatch.delenv("PRYNX_VDP_WORKERS", raising=False)
    monkeypatch.delenv("PRYNX_NUP_WORKERS", raising=False)

    workers, chunk_size, _ = _plan_vdp_parallelism(1500)
    assert workers == expected
    assert chunk_size == max(100, (1500 + expected - 1) // expected)
    assert _plan_vdp_parallelism(1)[:2] == (1, 100)
    assert _plan_vdp_parallelism(0)[:2] == (0, 100)

    nup_budget, _ = sm.plan_worker_count(
        kind="nup", per_worker_mb=1024, env_override="PRYNX_NUP_WORKERS"
    )
    assert nup_budget == expected
    assert _plan_nup_chunking(150, nup_budget)[1] == expected


@pytest.mark.parametrize(
    ("usable_mb", "installed_mb", "expected"),
    [(7952, 8192, 8192), (16144, 16384, 16384), (14336, 16384, 16384),
     (32528, 32768, 32768), (12288, None, 12288), (12288, 4096, 12288),
     (None, 16384, None), (0, 16384, 0)],
)
def test_memory_tier_resolver_thuan(usable_mb, installed_mb, expected):
    """PERF (audit 2026-09-28 §PERF28.03 B2): policy thuần không đọc RAM máy test."""
    assert sm.memory_tier_mb(usable_mb, installed_mb) == expected


@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "expected"),
    [(8192, 7952, 2), (16384, 16144, 3), (65536, 65296, 4),
     (6144, 5904, 1), (12288, 12048, 2), (32768, 32528, 3)],
)
def test_heavy_slots_theo_ram_lap_dat(
    gia_lap_ram, gia_lap_ram_lap_dat, monkeypatch, installed_mb, usable_mb, expected
):
    from app.core import heavy_job_scheduler as sched

    gia_lap_ram(usable_mb, usable_mb * 0.5)
    gia_lap_ram_lap_dat(installed_mb)
    monkeypatch.delenv("PRYNX_MAX_HEAVY_JOBS", raising=False)
    assert sched._default_heavy_slots()[0] == expected
    assert sm.read_memory_tier_mb(usable_mb) == installed_mb
    # Tier không được làm biến đổi telemetry mà admission đang đọc.
    assert sm.read_memory_status_mb() == (usable_mb, usable_mb * 0.5)
    monkeypatch.setenv("PRYNX_MAX_HEAVY_JOBS", "7")
    assert sched._default_heavy_slots()[0] == 7

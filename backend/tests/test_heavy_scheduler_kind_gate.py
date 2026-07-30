"""Trần theo loại việc của scheduler — PERF (audit 2026-07-29 §C.3b).

Bối cảnh: trần việc nặng toàn cục nay được nới theo RAM (1 / 2 / 3 / 4 slot). Nới đó CHỈ
an toàn vì có hai trần phụ:

- Nhóm "dùng hết máy" (`nup`, `vdp`, `compare`) — mỗi job đã tự mở tới `cpu-1` process nên
  chỉ được chạy MỘT job tại một thời điểm. Đây vừa là điều kiện để nới, vừa là sửa lỗi:
  trước đây trần toàn cục 2 cho phép 1 nup + 1 VDP song song = ~2×(cpu-1) process.
- `office` (COM/LibreOffice) — nhiều instance cùng lúc là nguồn treo đã có lịch sử, nên
  cách ly còn một suất bất kể máy mạnh cỡ nào.

Test này chặn hồi quy cả hai chiều: mất trần phụ, hoặc đảo thứ tự lấy khóa (sẽ deadlock).
"""

import threading
import time

import pytest

from app.core import heavy_job_scheduler as sched


def _chay_song_song(kind: str, so_thread: int, giu_giay: float = 0.15):
    """Chạy `so_thread` job cùng `kind`, trả về số job đồng thời CAO NHẤT quan sát được."""
    dang_chay = 0
    dinh = 0
    dem_lock = threading.Lock()
    loi: list[BaseException] = []

    def viec():
        nonlocal dang_chay, dinh
        try:
            with sched.heavy_job_slot(kind):
                with dem_lock:
                    dang_chay += 1
                    dinh = max(dinh, dang_chay)
                time.sleep(giu_giay)
                with dem_lock:
                    dang_chay -= 1
        except BaseException as exc:  # noqa: BLE001 - báo lại cho test
            loi.append(exc)

    threads = [threading.Thread(target=viec, daemon=True) for _ in range(so_thread)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert all(not t.is_alive() for t in threads), f"thread kind={kind} khong ket thuc — nghi deadlock"
    assert not loi, f"loi trong job: {loi!r}"
    return dinh


@pytest.mark.parametrize("kind", sorted(sched._WHOLE_MACHINE_KINDS))
def test_viec_dung_het_may_chi_mot_job_mot_luc(kind):
    assert _chay_song_song(kind, so_thread=4) == 1, (
        f"kind '{kind}' cho >1 job song song. Mỗi job loại này đã mở tới cpu-1 process; "
        f"hai job cùng lúc là oversubscribe cả CPU lẫn RAM."
    )


def test_office_duoc_cach_ly_mot_suat():
    assert _chay_song_song("office", so_thread=3) == 1, (
        "kind 'office' cho >1 job song song — nhiều instance COM/LibreOffice là nguồn treo."
    )


def test_viec_nhe_khong_bi_ep_ve_mot():
    """`pdf-tools` chỉ chịu trần toàn cục — trên máy có >=2 slot phải chạy song song được.

    Đây chính là phần "máy mạnh được nới": việc nhẹ không bị kẹp về 1 như nhóm dùng-hết-máy.
    """
    tran = sched.max_active_heavy_jobs()
    dinh = _chay_song_song("pdf-tools", so_thread=tran + 2)
    assert dinh == min(tran, tran + 2), f"đỉnh {dinh} khác trần toàn cục {tran}"
    if tran >= 2:
        assert dinh >= 2, "việc nhẹ bị kẹp về 1 dù trần toàn cục >= 2"


def test_khong_deadlock_khi_tron_loai_viec():
    """Trộn nup + office + pdf-tools: thứ tự lấy khóa phải nhất quán, không treo."""
    loi: list[BaseException] = []
    xong: list[str] = []
    xong_lock = threading.Lock()

    def viec(kind: str):
        try:
            with sched.heavy_job_slot(kind):
                time.sleep(0.05)
            with xong_lock:
                xong.append(kind)
        except BaseException as exc:  # noqa: BLE001
            loi.append(exc)

    kinds = ["nup", "office", "pdf-tools", "vdp", "compare", "booklet", "pdf-tools", "nup"]
    threads = [threading.Thread(target=viec, args=(k,), daemon=True) for k in kinds]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert all(not t.is_alive() for t in threads), "có thread treo — nghi deadlock giữa hai lớp khóa"
    assert not loi, f"loi: {loi!r}"
    assert len(xong) == len(kinds)


def test_nha_du_hai_lop_khoa_khi_co_ngoai_le():
    """Ngoại lệ trong job phải nhả CẢ trần phụ lẫn suất toàn cục."""
    with pytest.raises(RuntimeError):
        with sched.heavy_job_slot("nup"):
            raise RuntimeError("loi gia lap")

    # Nếu rò khóa thì lần lấy sau sẽ treo.
    assert sched._WHOLE_MACHINE_SLOTS.acquire(timeout=2), "trần phụ không được nhả"
    sched._WHOLE_MACHINE_SLOTS.release()
    assert sched._HEAVY_JOB_SLOTS.acquire(timeout=2), "suất toàn cục không được nhả"
    sched._HEAVY_JOB_SLOTS.release()


def test_tran_toan_cuc_gate_theo_ram(monkeypatch):
    """<8GB → 1; <16GB → 2; >=16GB → 3; >=64GB → 4. Env vẫn ghi đè được."""
    monkeypatch.delenv("PRYNX_MAX_HEAVY_JOBS", raising=False)
    for total_mb, mong_doi in ((6 * 1024.0, 1), (12 * 1024.0, 2), (32 * 1024.0, 3), (128 * 1024.0, 4)):
        monkeypatch.setattr(
            "app.core.system_memory.read_memory_status_mb", lambda t=total_mb: (t, t / 2)
        )
        assert sched._default_heavy_slots()[0] == mong_doi, f"RAM {total_mb} MiB"

    monkeypatch.setattr("app.core.system_memory.read_memory_status_mb", lambda: (None, None))
    assert sched._default_heavy_slots()[0] == 2, "không đọc được RAM phải giữ hành vi cũ (2)"

    monkeypatch.setenv("PRYNX_MAX_HEAVY_JOBS", "7")
    assert sched._default_heavy_slots()[0] == 7

"""Trần theo loại việc của scheduler — PERF (audit 2026-07-29 §C.3b).

Bối cảnh: trần việc nặng toàn cục nay được nới theo RAM (1 / 2 / 3 / 4 slot). Nới đó CHỈ
an toàn vì có hai trần phụ:

- Nhóm "dùng hết máy" (`nup`, `vdp`, `compare`, `mixed-nesting`) — mỗi job đã tự mở tới
  `cpu-1` process/thread nên chỉ được chạy MỘT job tại một thời điểm. Đây vừa là điều kiện
  để nới, vừa là sửa lỗi: trước đây trần toàn cục 2 cho phép 1 nup + 1 VDP song song =
  ~2×(cpu-1) process.
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


# ─────────────────────────────────────────────────────────────────────────────
#  Bình lồng ghép tự do — phase P6b (kế hoạch 2026-08-26 §14)
# ─────────────────────────────────────────────────────────────────────────────


def _chay_song_song_tron_loai(kinds: list[str], giu_giay: float = 0.15) -> int:
    """Chạy mỗi `kind` một job cùng lúc, trả đỉnh số job đồng thời QUAN SÁT ĐƯỢC.

    Khác `_chay_song_song`: helper kia chỉ chạy cùng một `kind` nên không phát hiện được
    trường hợp hai loại KHÁC nhau vẫn chạy song song vì mỗi loại có gate riêng.
    """
    dang_chay = 0
    dinh = 0
    dem_lock = threading.Lock()
    loi: list[BaseException] = []
    # Rào để mọi thread cùng vào tranh khóa, không nối tiếp vì thời điểm start lệch nhau.
    rao = threading.Barrier(len(kinds), timeout=20)

    def viec(kind: str):
        nonlocal dang_chay, dinh
        try:
            rao.wait()
            with sched.heavy_job_slot(kind):
                with dem_lock:
                    dang_chay += 1
                    dinh = max(dinh, dang_chay)
                time.sleep(giu_giay)
                with dem_lock:
                    dang_chay -= 1
        except BaseException as exc:  # noqa: BLE001
            loi.append(exc)

    threads = [threading.Thread(target=viec, args=(k,), daemon=True) for k in kinds]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert all(not t.is_alive() for t in threads), f"thread treo với {kinds} — nghi deadlock"
    assert not loi, f"loi trong job: {loi!r}"
    return dinh


def test_mixed_nesting_thuoc_nhom_dung_het_may():
    """Kind phải nằm trong `_WHOLE_MACHINE_KINDS` và dùng đúng semaphore của nhóm."""
    from app.core.mixed_nesting_service import MIXED_NESTING_KIND

    assert MIXED_NESTING_KIND == "mixed-nesting"
    assert MIXED_NESTING_KIND in sched._WHOLE_MACHINE_KINDS
    assert sched._kind_gate(MIXED_NESTING_KIND) is sched._WHOLE_MACHINE_SLOTS
    # Không được tự lập gate riêng: dùng chung suất với nup/vdp/compare mới là mục đích.
    assert sched._kind_gate(MIXED_NESTING_KIND) is not sched._SERIAL_SLOTS
    assert sched._kind_gate(MIXED_NESTING_KIND) is not sched._STICKER_SLOTS


@pytest.mark.parametrize("doi_thu", ["nup", "vdp", "compare"])
def test_mixed_nesting_khong_chay_song_song_voi_viec_dung_het_may(doi_thu):
    """Đây là lý do tồn tại của P6b: serialize với các job đang trải hết CPU."""
    dinh = _chay_song_song_tron_loai(["mixed-nesting", doi_thu])
    assert dinh == 1, (
        f"'mixed-nesting' chạy song song với '{doi_thu}'. Hai job cùng mở tới cpu-1 "
        f"worker là oversubscribe cả CPU lẫn RAM mà planner vừa cấp cho từng bên."
    )


def test_mixed_nesting_van_cho_viec_nhe_di_qua():
    """Serialize không có nghĩa là chặn việc nhẹ: `pdf-tools` vẫn phải đi được."""
    dinh = _chay_song_song_tron_loai(["mixed-nesting", "pdf-tools"])
    if sched.max_active_heavy_jobs() >= 2:
        assert dinh == 2, "việc nhẹ bị chặn oan bởi job lồng ghép"
    else:
        assert dinh == 1, "máy 1 slot thì nối tiếp là đúng"


def test_mixed_nesting_nha_du_hai_lop_khoa_khi_co_ngoai_le():
    """Ngoại lệ giữa job phải nhả CẢ trần nhóm lẫn suất toàn cục."""
    with pytest.raises(RuntimeError):
        with sched.heavy_job_slot("mixed-nesting"):
            raise RuntimeError("loi gia lap trong solver")

    assert sched._WHOLE_MACHINE_SLOTS.acquire(timeout=2), "trần nhóm không được nhả"
    sched._WHOLE_MACHINE_SLOTS.release()
    assert sched._HEAVY_JOB_SLOTS.acquire(timeout=2), "suất toàn cục không được nhả"
    sched._HEAVY_JOB_SLOTS.release()


def test_mixed_nesting_huy_khi_dang_cho_thi_nha_slot():
    """Hủy lúc còn xếp hàng: waiter rời hàng đợi và KHÔNG rò slot nào."""
    import asyncio

    async def scenario():
        giu = asyncio.Event()
        da_vao = asyncio.Event()

        async def job_dang_giu():
            async with sched.async_heavy_job_slot("mixed-nesting"):
                da_vao.set()
                await giu.wait()

        holder = asyncio.create_task(job_dang_giu())
        await asyncio.wait_for(da_vao.wait(), timeout=5)

        # Job thứ hai vào hàng đợi rồi bị hủy khi còn chờ.
        async def job_bi_huy():
            async with sched.async_heavy_job_slot("mixed-nesting", lambda: True):
                pytest.fail("job đã bị hủy không được vào chạy")

        with pytest.raises(sched.HeavyJobQueueCancelled):
            await asyncio.wait_for(job_bi_huy(), timeout=5)

        giu.set()
        await asyncio.wait_for(holder, timeout=5)

    asyncio.run(scenario())

    # Không rò: cả hai lớp khóa phải lấy lại được ngay.
    assert sched._WHOLE_MACHINE_SLOTS.acquire(timeout=2), "hủy làm rò trần nhóm"
    sched._WHOLE_MACHINE_SLOTS.release()
    assert sched._HEAVY_JOB_SLOTS.acquire(timeout=2), "hủy làm rò suất toàn cục"
    sched._HEAVY_JOB_SLOTS.release()

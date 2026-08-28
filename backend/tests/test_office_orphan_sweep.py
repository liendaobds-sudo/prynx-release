"""[PROC-LIFECYCLE FIX 2026-08-28 §UP.11] Quét tiến trình Office mồ côi lúc khởi động.

Bất biến quan trọng nhất: sweep KHÔNG được giết oan. PID trong file `*.owned-pids` có thể đã
được Windows cấp lại cho tiến trình khác, nên chỉ diệt khi image name thuộc whitelist Office.
"""
from __future__ import annotations

import os

import pytest

from app.core import office_job_runner


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Sweep chỉ áp dụng cho Windows")


def _viet_file_owned_pids(directory, pids: list[int]) -> str:
    path = os.path.join(str(directory), "ket_qua.pdf.deadbeef.owned-pids")
    with open(path, "w", encoding="ascii") as handle:
        handle.write("\n".join(str(pid) for pid in pids))
    return path


def test_diet_pid_thuoc_whitelist_office(tmp_path, monkeypatch):
    pid_path = _viet_file_owned_pids(tmp_path, [4321])
    monkeypatch.setattr(office_job_runner, "_image_name_of_pid", lambda pid: "winword.exe")
    da_diet: list[int] = []
    monkeypatch.setattr(office_job_runner, "_kill_pid_tree", da_diet.append)

    killed = office_job_runner.sweep_orphan_office_pids(str(tmp_path))

    assert killed == 1
    assert da_diet == [4321]
    # File dấu vết phải được dọn để lần khởi động sau không quét lại PID cũ.
    assert not os.path.exists(pid_path)


def test_khong_diet_khi_pid_da_bi_cap_lai_cho_tien_trinh_khac(tmp_path, monkeypatch):
    pid_path = _viet_file_owned_pids(tmp_path, [4321])
    # Ca thật đáng sợ: PID được cấp lại cho một tiến trình hoàn toàn khác.
    monkeypatch.setattr(office_job_runner, "_image_name_of_pid", lambda pid: "chrome.exe")
    da_diet: list[int] = []
    monkeypatch.setattr(office_job_runner, "_kill_pid_tree", da_diet.append)

    killed = office_job_runner.sweep_orphan_office_pids(str(tmp_path))

    assert killed == 0
    assert da_diet == []
    assert not os.path.exists(pid_path)


def test_bo_qua_pid_khong_con_ton_tai(tmp_path, monkeypatch):
    _viet_file_owned_pids(tmp_path, [4321])
    monkeypatch.setattr(office_job_runner, "_image_name_of_pid", lambda pid: None)
    da_diet: list[int] = []
    monkeypatch.setattr(office_job_runner, "_kill_pid_tree", da_diet.append)

    assert office_job_runner.sweep_orphan_office_pids(str(tmp_path)) == 0
    assert da_diet == []


def test_thu_muc_khong_ton_tai_hoac_khong_co_file_thi_khong_loi(tmp_path):
    assert office_job_runner.sweep_orphan_office_pids(str(tmp_path / "khong-co")) == 0
    assert office_job_runner.sweep_orphan_office_pids(str(tmp_path)) == 0
    assert office_job_runner.sweep_orphan_office_pids("") == 0


def test_doc_duoc_image_name_that_tu_tasklist():
    """Kiểm parser trên output tasklist THẬT, không mock — đây là chỗ dễ vỡ nếu đổi định dạng."""
    ten = office_job_runner._image_name_of_pid(os.getpid())

    assert ten is not None
    assert ten.endswith(".exe")


def test_pid_khong_ton_tai_tra_none():
    # PID chắc chắn không hợp lệ: tasklist in dòng INFO không có dấu ngoặc kép.
    assert office_job_runner._image_name_of_pid(0) is None
    assert office_job_runner._image_name_of_pid(-5) is None

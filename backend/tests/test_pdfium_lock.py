"""Kiểm chứng khóa PDFium — KIENTRUC (audit 2026-07-29 §C.1).

Khóa này là bất biến an toàn (PDFium không thread-safe, xem AGENTS.md rule #3), nên
phải có test chặn hồi quy: đổi `RLock` thành `Lock` sẽ deadlock ở test tái nhập, còn
bỏ khóa đi sẽ vỡ ở test loại trừ lẫn nhau.
"""

import threading
import time

from app.core import pdfium_lock
from app.core.pdfium_lock import PDFIUM_PY_LOCK, pdfium_guard


def test_rust_bridge_re_export_cung_mot_khoa():
    """`rust_bridge` phải re-export CHÍNH khóa đó, không tạo khóa thứ hai."""
    from app.core import rust_bridge

    assert rust_bridge.PDFIUM_PY_LOCK is PDFIUM_PY_LOCK
    assert rust_bridge.pdfium_guard is pdfium_guard


def test_tai_nhap_cung_thread_khong_deadlock():
    """Nested guard trong CÙNG thread phải đi qua (vd render_with_hidden_layers →
    render_page_image). Nếu ai đổi sang `threading.Lock` thì test này treo → fail."""
    done = []

    def nested():
        with pdfium_guard("ngoai"):
            with pdfium_guard("trong"):
                done.append(True)

    worker = threading.Thread(target=nested, daemon=True)
    worker.start()
    worker.join(timeout=5)

    assert not worker.is_alive(), "guard tái nhập bị deadlock — khóa phải là RLock"
    assert done == [True]


def test_loai_tru_lan_nhau_giua_hai_thread():
    """Hai thread không được ở trong vùng khóa cùng lúc."""
    trong_vung = 0
    dinh_dong_thoi = 0
    sentinel = threading.Lock()  # chỉ để bảo vệ hai biến đếm của test

    def cong_viec():
        nonlocal trong_vung, dinh_dong_thoi
        for _ in range(20):
            with pdfium_guard("test"):
                with sentinel:
                    trong_vung += 1
                    if trong_vung > 1:
                        dinh_dong_thoi += 1
                time.sleep(0.001)  # nới cửa sổ đua để test có ý nghĩa
                with sentinel:
                    trong_vung -= 1

    threads = [threading.Thread(target=cong_viec, daemon=True) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    assert all(not t.is_alive() for t in threads), "thread không kết thúc — nghi deadlock"
    assert dinh_dong_thoi == 0, "có 2 thread cùng vào vùng PDFium — khóa không có tác dụng"


def test_nha_khoa_khi_co_ngoai_le():
    """Ngoại lệ trong vùng khóa vẫn phải nhả khóa (không kẹt vĩnh viễn)."""
    try:
        with pdfium_guard("no"):
            raise RuntimeError("loi gia lap")
    except RuntimeError:
        pass

    assert PDFIUM_PY_LOCK.acquire(timeout=2), "khóa không được nhả sau ngoại lệ"
    PDFIUM_PY_LOCK.release()


def test_module_khoa_khong_keo_theo_extension_nang():
    """`pdfium_lock` phải nhẹ: không import `pdfcompare_native`/`pypdfium2` ở module
    level, để nơi nào chỉ cần khóa thì không phải nạp extension Rust."""
    import inspect

    src = inspect.getsource(pdfium_lock)
    code_lines = [
        line for line in src.splitlines()
        if line.startswith(("import ", "from ")) and "pdfium_lock" not in line
    ]
    joined = " ".join(code_lines)
    assert "pdfcompare_native" not in joined
    assert "pypdfium2" not in joined

"""Admission của job bù xén / tạo đường cắt — audit 2026-08-16 §BX.P03.

Bất biến cần bảo vệ: chỉ MỘT job tem chạy cùng lúc (engine tự trải worker theo RAM
nên hai job song song là nhân đôi ngân sách RAM), NHƯNG job tem đang xếp hàng KHÔNG
được chiếm suất heavy toàn cục. Chiếm suất khi chờ nghĩa là 3 job tem xếp hàng khoá
hết trần toàn cục và mọi endpoint pdf-tools khác (merge/split/resize/optimize/OCR)
phải chờ oan dù chỉ 1 job tem thật sự đang chạy.
"""

import asyncio
import os
import shutil
import threading

import pytest

from app.core import heavy_job_scheduler as sched


def _global_slots_in_use() -> int:
    """Số suất heavy toàn cục đang bị giữ (kể cả bởi job chỉ đang chờ)."""
    return sched.max_active_heavy_jobs() - sched._HEAVY_JOB_SLOTS._value


@pytest.fixture
def sticker_source(tmp_path):
    import pikepdf

    source = tmp_path / "admission.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 120))
    pdf.save(str(source))
    pdf.close()
    return source


def _run_concurrent_sticker_jobs(tmp_path, monkeypatch, source, job_count: int):
    """Chạy `job_count` request tem đồng thời; trả (số job chạy đồng thời tối đa,
    số suất heavy toàn cục bị giữ tối đa)."""
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine

    state_lock = threading.Lock()
    running = 0
    peak_running = 0
    peak_global_slots = 0
    release = threading.Event()

    class SlowEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **_kwargs):
            nonlocal running, peak_running, peak_global_slots
            with state_lock:
                running += 1
                peak_running = max(peak_running, running)
                peak_global_slots = max(peak_global_slots, _global_slots_in_use())
            try:
                # Giữ job lại tới khi mọi request đã vào hàng đợi, để phép đo nhìn
                # thấy đúng trạng thái "1 chạy, N-1 chờ".
                release.wait(timeout=5.0)
            finally:
                with state_lock:
                    running -= 1
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    class FakeRequest:
        async def form(self):
            return {"file_path": str(source), "bleed_mm": "1"}

    monkeypatch.setattr(sticker_engine, "StickerEngine", SlowEngine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)
    monkeypatch.setattr(
        pdf_tools, "restore_sticker_page_canvas", lambda *a, **k: None, raising=False
    )

    async def drive():
        tasks = [
            asyncio.create_task(
                pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
            )
            for _ in range(job_count)
        ]
        # Cho mọi task kịp qua tầng admission và vào hàng đợi.
        await asyncio.sleep(0.6)
        with state_lock:
            observed_global = peak_global_slots
        release.set()
        await asyncio.gather(*tasks)
        return observed_global

    observed_global = asyncio.run(drive())
    return peak_running, observed_global


def test_chi_mot_job_tem_chay_cung_luc(tmp_path, monkeypatch, sticker_source):
    """Trần 1 job tem là CỐ Ý: engine tự trải worker theo RAM (§C.3)."""
    peak_running, _ = _run_concurrent_sticker_jobs(
        tmp_path, monkeypatch, sticker_source, job_count=3
    )
    assert peak_running == 1, (
        f"Có {peak_running} job tem chạy đồng thời — ngân sách RAM của "
        "_auto_sticker_hw_profile bị nhân lên theo số job."
    )


def test_job_tem_dang_cho_khong_chiem_suat_heavy_toan_cuc(
    tmp_path, monkeypatch, sticker_source
):
    """§BX.P03: 3 job tem, 1 chạy → chỉ 1 suất heavy toàn cục bị giữ.

    Trước bản sửa: admission là `kind="pdf-tools"` (không có gate riêng) và trần 1 job
    tem là `threading.BoundedSemaphore` acquire BÊN TRONG threadpool, nên cả 3 job đều
    được nhận suất toàn cục rồi mới chặn nhau — giữ 3/3 suất trên máy 16–64GB.
    """
    _, peak_global_slots = _run_concurrent_sticker_jobs(
        tmp_path, monkeypatch, sticker_source, job_count=3
    )
    assert peak_global_slots == 1, (
        f"{peak_global_slots} suất heavy toàn cục bị giữ khi chỉ 1 job tem chạy. "
        "Job tem đang xếp hàng phải chờ ở tầng async TRƯỚC khi nhận suất toàn cục, "
        "nếu không mọi endpoint pdf-tools khác bị chặn oan."
    )


def _fake_chunk_pdf_bytes(page_size, pages: int) -> bytes:
    """PDF thật, đủ lớn để phép đo RAM nhìn thấy (ảnh nén kém trong stream)."""
    import io
    import os as _os

    import pikepdf

    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        page = pdf.add_blank_page(page_size=page_size)
        stream = pikepdf.Stream(pdf, _os.urandom(1_500_000))
        page.Contents = stream
    buffer = io.BytesIO()
    pdf.save(buffer)
    pdf.close()
    return buffer.getvalue()


def test_chunk_song_song_khong_giu_het_trong_ram_cha(tmp_path, monkeypatch):
    """§BX.P04: parent không được giữ đồng thời toàn bộ chunk bytes.

    Trước bản sửa, `_run_sticker_chunks` gom mọi `chunk_pdf_bytes` vào một list rồi mới
    merge, nên peak RAM của process cha ≈ tổng dung lượng output — đúng lúc worker vừa
    nhả RAM. Với `spill_dir`, mỗi chunk được ghi ra file tạm ngay khi nhận và bytes được
    nhả, nên peak chỉ còn cỡ MỘT chunk.
    """
    import tracemalloc

    from app.workers import sticker_engine as se

    chunk_count = 5
    chunk_bytes = _fake_chunk_pdf_bytes((200, 120), pages=2)
    chunk_mb = len(chunk_bytes) / (1024 * 1024)
    assert chunk_mb > 1.0, "Chunk giả phải đủ lớn để phép đo có nghĩa"

    def fake_chunk(args):
        # Mỗi lời gọi tạo một bản bytes MỚI (giống pickle từ worker về), nếu không
        # Python chia sẻ cùng object và phép đo mất ý nghĩa.
        return args["chunk_idx"], (bytes(chunk_bytes), [{"page": 1}], [], True)

    monkeypatch.setattr(se, "_process_sticker_chunk", fake_chunk)
    engine = se.StickerEngine(dpi=72)
    args_list = [{"chunk_idx": index} for index in range(chunk_count)]
    spill_dir = tmp_path / "chunks"
    spill_dir.mkdir()

    tracemalloc.start()
    try:
        results = engine._run_sticker_chunks(
            args_list, n_workers=1, use_pool=False, spill_dir=str(spill_dir)
        )
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    peak_mb = peak / (1024 * 1024)
    # Ngưỡng 2,5 chunk: rộng rãi cho bytes tạm của một chunk đang ghi, nhưng vẫn chặn
    # được hành vi gom cả 5 chunk (≈5 chunk trở lên).
    assert peak_mb < chunk_mb * 2.5, (
        f"Peak RAM {peak_mb:.1f} MB cho {chunk_count} chunk × {chunk_mb:.1f} MB — "
        "parent vẫn đang gom hết chunk trong bộ nhớ."
    )
    # Mỗi chunk phải nằm trên đĩa và merge vẫn đọc được.
    assert len(results) == chunk_count
    for _idx, (chunk_source, _metas, _no_dieline, _any_die) in results:
        assert isinstance(chunk_source, str), "spill_dir phải trả đường dẫn, không phải bytes"
        assert os.path.getsize(chunk_source) == len(chunk_bytes)


def test_chunk_khong_co_spill_dir_van_tra_bytes(tmp_path, monkeypatch):
    """Tương thích ngược: không truyền spill_dir thì giữ đúng hợp đồng bytes cũ."""
    from app.workers import sticker_engine as se

    monkeypatch.setattr(
        se,
        "_process_sticker_chunk",
        lambda args: (args["chunk_idx"], (b"%PDF-1.7\n", [], [], False)),
    )
    engine = se.StickerEngine(dpi=72)
    results = engine._run_sticker_chunks(
        [{"chunk_idx": 0}], n_workers=1, use_pool=False
    )
    assert results[0][1][0] == b"%PDF-1.7\n"

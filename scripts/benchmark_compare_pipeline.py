"""Benchmark PA-2 cho pipeline Compare: elapsed, trang đầu, peak RAM và parity.

Chạy từ thư mục gốc bằng Python của ``backend/venv``. Mỗi cấu hình worker chạy
trong process con sạch để peak working set không bị giữ bởi allocator từ lượt trước.
Corpus mặc định: 20 trang A4 @150 DPI, 7 trang có khác biệt — khớp corpus audit P-A.

Ví dụ::

    backend\venv\Scripts\python.exe scripts\benchmark_compare_pipeline.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def _working_set_bytes(pid: int) -> int:
    """Đọc WorkingSetSize qua Windows API, không thêm phụ thuộc psutil."""
    if os.name != "nt":
        return 0
    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(
        process_query_limited_information, False, pid
    )
    if not handle:
        return 0
    try:
        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(
            handle, ctypes.byref(counters), ctypes.sizeof(counters)
        )
        return int(counters.WorkingSetSize) if ok else 0
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _working_set_tree_bytes(root_pid: int) -> int:
    """Tổng working set parent + worker process để benchmark CL.4 không hụt RAM."""
    if os.name != "nt":
        return _working_set_bytes(root_pid)
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    snapshot = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        return _working_set_bytes(root_pid)
    parents: dict[int, list[int]] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = ctypes.windll.kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            parents.setdefault(int(entry.th32ParentProcessID), []).append(
                int(entry.th32ProcessID)
            )
            ok = ctypes.windll.kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        ctypes.windll.kernel32.CloseHandle(snapshot)

    process_ids = []
    stack = [int(root_pid)]
    seen = set()
    while stack:
        process_id = stack.pop()
        if process_id in seen:
            continue
        seen.add(process_id)
        process_ids.append(process_id)
        stack.extend(parents.get(process_id, []))
    return sum(_working_set_bytes(process_id) for process_id in process_ids)


def _make_pdf(path: Path, *, pages: int, changed: bool, all_diff: bool = False) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdf = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    for page in range(pages):
        pdf.setFillColorRGB(0.9, 0.9, 0.95)
        pdf.rect(20, 20, width - 40, height - 40, fill=1)
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont("Helvetica", 14)
        for row in range(40):
            pdf.drawString(
                40,
                height - 60 - row * 18,
                f"Dong noi dung {row} cua trang {page + 1} - PrynX benchmark",
            )
        pdf.setFillColorRGB(0.2, 0.4, 0.8)
        pdf.circle(width / 2, height / 2, 80, fill=0)
        # PERF (audit 2026-08-13 §PB-3): --all-diff = kịch bản xấu nhất về artifact
        # (mọi trang đều khác) để đo trần đĩa/RAM cho tài liệu dài.
        if changed and (all_diff or page % 3 == 0):
            pdf.setFillColorRGB(1, 0, 0)
            pdf.rect(width / 2 - 30, height / 2 - 30, 60, 60, fill=1)
        pdf.showPage()
    pdf.save()


def _artifact_hashes(result_dir: Path) -> dict[str, str]:
    if not result_dir.exists():
        return {}
    return {
        item.name: hashlib.sha256(item.read_bytes()).hexdigest()
        for item in sorted(result_dir.iterdir())
        if item.is_file()
    }


def _artifact_bytes(result_dir: Path) -> int:
    """PERF (audit 2026-08-13 §PB): tổng dung lượng PNG/GIF của job — số liệu
    nghiệm thu artifact-budget cho tài liệu dài, đo cùng chỗ với parity."""
    if not result_dir.exists():
        return 0
    return sum(item.stat().st_size for item in result_dir.iterdir() if item.is_file())


def _install_stage_probes(db) -> dict[str, float]:
    """PERF (audit 2026-08-13 §PB-2): đo tổng thời gian từng stage của pipeline.

    render/save/commit chạy trên main thread; compare chạy trong worker pool nên
    thời gian là TỔNG CỘNG DỒN trên mọi worker (không phải wall-clock). Chỉ dùng
    cho benchmark ``--stages`` trong process con — không đụng code sản phẩm.
    """
    from threading import Lock

    from app.core.highlight_renderer import HighlightRenderer
    from app.core.image_comparator import ImageComparator
    from app.core.pdf_processor import PDFDocumentReader

    totals = {
        "render_s": 0.0, "render_n": 0,
        "compare_s": 0.0, "compare_n": 0,
        "save_s": 0.0, "save_n": 0,
        "commit_s": 0.0, "commit_n": 0,
    }
    lock = Lock()

    def _wrap_method(cls, name: str, key: str) -> None:
        original = getattr(cls, name)

        def timed(self, *call_args, **call_kwargs):
            begin = time.perf_counter()
            try:
                return original(self, *call_args, **call_kwargs)
            finally:
                duration = time.perf_counter() - begin
                with lock:
                    totals[f"{key}_s"] += duration
                    totals[f"{key}_n"] += 1

        setattr(cls, name, timed)

    _wrap_method(PDFDocumentReader, "render_page", "render")
    _wrap_method(PDFDocumentReader, "render_page_cmyk", "render")
    _wrap_method(ImageComparator, "compare", "compare")
    _wrap_method(ImageComparator, "compare_cmyk", "compare")
    _wrap_method(HighlightRenderer, "save_highlighted_image", "save")
    # PB-2: pipeline ghi PNG bytes đã encode trong worker qua phương thức riêng.
    _wrap_method(HighlightRenderer, "save_highlighted_png_bytes", "save")
    _wrap_method(HighlightRenderer, "save_gif_image", "save")

    original_commit = db.commit

    def timed_commit():
        begin = time.perf_counter()
        try:
            return original_commit()
        finally:
            duration = time.perf_counter() - begin
            with lock:
                totals["commit_s"] += duration
                totals["commit_n"] += 1

    db.commit = timed_commit
    return totals


def _run_child(args: argparse.Namespace) -> int:
    sys.path.insert(0, str(BACKEND))
    os.environ["PRYNX_COMPARE_WORKERS"] = str(args.workers)
    os.environ["PRYNX_COMPARE_PROCESS_WORKERS"] = str(args.workers)
    os.environ["PRYNX_COMPARE_PROCESS_MIN_PAGES"] = "2"
    if args.process_min_pixels is not None:
        os.environ["PRYNX_COMPARE_PROCESS_MIN_PIXELS"] = str(args.process_min_pixels)
    if args.cv_threads is not None:
        os.environ["PRYNX_COMPARE_CV_THREADS"] = str(args.cv_threads)
    os.environ.setdefault("PRYNX_SIDECAR_TOKEN", "benchmark-compare-token")

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import cv2

    from app.config import settings
    from app.core.comparison_engine import run_comparison_pipeline
    from app.database import Base
    from app.models.job import ComparisonJob, PageResult, UploadedFile

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    settings.RESULTS_DIR = str(work_dir / "results")
    if args.cv_threads is not None:
        cv2.setNumThreads(max(1, args.cv_threads))
    engine = create_engine(
        f"sqlite:///{(work_dir / 'benchmark.db').as_posix()}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        file_a = UploadedFile(
            filename="a.pdf",
            original_name="a.pdf",
            file_path=args.pdf_a,
            page_count=args.pages,
        )
        file_b = UploadedFile(
            filename="b.pdf",
            original_name="b.pdf",
            file_path=args.pdf_b,
            page_count=args.pages,
        )
        db.add_all([file_a, file_b])
        db.commit()
        db.refresh(file_a)
        db.refresh(file_b)
        job = ComparisonJob(
            file_a_id=file_a.id,
            file_b_id=file_b.id,
            config={
                "comparison_mode": "full",
                "tolerance": "NORMAL",
                "dpi": args.dpi,
            },
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        peak = _working_set_tree_bytes(os.getpid())
        stop_sampling = threading.Event()

        def sample_memory() -> None:
            nonlocal peak
            while not stop_sampling.wait(0.01):
                peak = max(peak, _working_set_tree_bytes(os.getpid()))

        sampler = threading.Thread(target=sample_memory, daemon=True)
        sampler.start()
        # Cài probe SAU các commit setup để chỉ đo đúng phần pipeline.
        stage_totals = _install_stage_probes(db) if args.stages else None
        started = time.perf_counter()
        first_page_s = None
        cancel_event = threading.Event()

        def progress(job_id, progress, status, current_page, total_pages, message):
            nonlocal first_page_s
            if current_page > 0 and first_page_s is None:
                first_page_s = time.perf_counter() - started

        # Runtime desktop/local luôn truyền Event từ route. Benchmark phải đi đúng
        # đường này; cancel_check=None là nhánh Celery phải thăm trạng thái qua DB.
        run_comparison_pipeline(
            job.id,
            db,
            on_progress=progress,
            cancel_check=cancel_event.is_set,
        )
        elapsed_s = time.perf_counter() - started
        stop_sampling.set()
        sampler.join(timeout=1)
        peak = max(peak, _working_set_tree_bytes(os.getpid()))

        pages = (
            db.query(PageResult)
            .filter(PageResult.job_id == job.id)
            .order_by(PageResult.page_number)
            .all()
        )
        snapshot = [
            [
                page.page_number,
                page.status,
                page.diff_count,
                round(float(page.similarity_score or 0.0), 4),
                page.diff_regions,
            ]
            for page in pages
        ]
        result_dir = Path(settings.RESULTS_DIR) / job.id
        output = {
            "workers": args.workers,
            "elapsed_s": elapsed_s,
            "first_page_s": first_page_s,
            "peak_working_set_mib": peak / (1024 * 1024),
            "page_snapshot": snapshot,
            "summary": job.result_summary,
            "artifact_hashes": _artifact_hashes(result_dir),
            "artifact_bytes": _artifact_bytes(result_dir),
        }
        if stage_totals is not None:
            # main_serial = phần buộc tuần tự trên main thread của pipeline;
            # unaccounted = elapsed − main_serial (gồm chờ drain, overlay, ORM…).
            # Với workers=1 compare cũng nằm trên main thread nên unaccounted
            # phải trừ thêm compare_s khi đọc số liệu.
            main_serial = (
                stage_totals["render_s"]
                + stage_totals["save_s"]
                + stage_totals["commit_s"]
            )
            output["stages"] = {
                **{
                    key: (round(value, 3) if key.endswith("_s") else value)
                    for key, value in stage_totals.items()
                },
                "main_serial_s": round(main_serial, 3),
                "unaccounted_s": round(elapsed_s - main_serial, 3),
            }
        print("PRYNX_BENCH_JSON=" + json.dumps(output, ensure_ascii=False))
        return 0
    finally:
        db.close()
        engine.dispose()


def _run_one(
    python: str,
    *,
    workers: int,
    pdf_a: Path,
    pdf_b: Path,
    pages: int,
    dpi: int,
    work_dir: Path,
    cv_threads: int | None,
    process_min_pixels: int | None,
    stages: bool = False,
) -> dict:
    command = [
        python,
        str(Path(__file__).resolve()),
        "--child",
        "--workers",
        str(workers),
        "--pdf-a",
        str(pdf_a),
        "--pdf-b",
        str(pdf_b),
        "--pages",
        str(pages),
        "--dpi",
        str(dpi),
        "--work-dir",
        str(work_dir),
    ]
    if cv_threads is not None:
        command.extend(["--cv-threads", str(cv_threads)])
    if process_min_pixels is not None:
        command.extend(["--process-min-pixels", str(process_min_pixels)])
    if stages:
        command.append("--stages")
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PRYNX_SIDECAR_TOKEN", "benchmark-compare-token")
    completed = subprocess.run(
        command,
        cwd=str(ROOT),
        env=env,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"Process benchmark workers={workers} lỗi {completed.returncode}:\n"
            f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
        )
    marker = "PRYNX_BENCH_JSON="
    line = next(
        (line for line in completed.stdout.splitlines() if line.startswith(marker)),
        None,
    )
    if line is None:
        raise RuntimeError(f"Process benchmark không trả JSON:\n{completed.stdout}\n{completed.stderr}")
    return json.loads(line[len(marker):])


def _parse_workers(raw: str) -> list[int]:
    cpu_full = max(1, (os.cpu_count() or 2) - 1)
    values = []
    for item in raw.split(","):
        item = item.strip().lower()
        worker = cpu_full if item in {"cpu-1", "full"} else int(item)
        worker = max(1, worker)
        if worker not in values:
            values.append(worker)
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--workers", default="1,2,4,8,cpu-1")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--pages", type=int, default=20)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--pdf-a")
    parser.add_argument("--pdf-b")
    parser.add_argument("--work-dir")
    parser.add_argument("--cv-threads", type=int)
    parser.add_argument(
        "--process-min-pixels",
        type=int,
        help="Ép ngưỡng raster/trang để benchmark pipeline process CL.4.",
    )
    parser.add_argument(
        "--stages",
        action="store_true",
        help="PERF (audit 2026-08-13 §PB-2): đo thời gian từng stage "
        "(render/compare/save/commit) trong process con.",
    )
    parser.add_argument(
        "--all-diff",
        action="store_true",
        help="PERF (audit 2026-08-13 §PB-3): mọi trang đều khác biệt — "
        "kịch bản xấu nhất về artifact/đĩa cho tài liệu dài.",
    )
    args = parser.parse_args()

    if args.child:
        args.workers = int(args.workers)
        return _run_child(args)

    workers = _parse_workers(args.workers)
    root_tmp = Path(tempfile.mkdtemp(prefix="prynx_compare_pa2_"))
    pdf_a = root_tmp / "a.pdf"
    pdf_b = root_tmp / "b.pdf"
    _make_pdf(pdf_a, pages=args.pages, changed=False)
    _make_pdf(pdf_b, pages=args.pages, changed=True, all_diff=args.all_diff)

    # Xen kẽ cấu hình theo lượt để giảm bias nhiệt độ/cache.
    samples: dict[int, list[dict]] = {worker: [] for worker in workers}
    sequence = []
    for run in range(max(1, args.runs)):
        order = workers if run % 2 == 0 else list(reversed(workers))
        sequence.extend((run, worker) for worker in order)

    try:
        for index, (run, worker) in enumerate(sequence):
            result = _run_one(
                sys.executable,
                workers=worker,
                pdf_a=pdf_a,
                pdf_b=pdf_b,
                pages=args.pages,
                dpi=args.dpi,
                work_dir=root_tmp / f"run_{run}_{worker}_{index}",
                cv_threads=args.cv_threads,
                process_min_pixels=args.process_min_pixels,
                stages=args.stages,
            )
            samples[worker].append(result)
            print(
                f"workers={worker:>2} run={run + 1}: "
                f"elapsed={result['elapsed_s']:.3f}s, "
                f"first={result['first_page_s']:.3f}s, "
                f"peak={result['peak_working_set_mib']:.1f}MiB"
            )
            stage_data = result.get("stages")
            if stage_data:
                print(
                    f"  stages: render={stage_data['render_s']:.3f}s (n={stage_data['render_n']}) | "
                    f"compare(Σworker)={stage_data['compare_s']:.3f}s (n={stage_data['compare_n']}) | "
                    f"save={stage_data['save_s']:.3f}s (n={stage_data['save_n']}) | "
                    f"commit={stage_data['commit_s']:.3f}s (n={stage_data['commit_n']}) | "
                    f"main_serial={stage_data['main_serial_s']:.3f}s | "
                    f"unaccounted={stage_data['unaccounted_s']:.3f}s"
                )

        baseline = samples[1][0]
        parity_ok = True
        rows = []
        for worker in workers:
            group = samples[worker]
            elapsed = statistics.median(item["elapsed_s"] for item in group)
            first = statistics.median(item["first_page_s"] for item in group)
            peak = max(item["peak_working_set_mib"] for item in group)
            parity = all(
                item["page_snapshot"] == baseline["page_snapshot"]
                and item["summary"] == baseline["summary"]
                and item["artifact_hashes"] == baseline["artifact_hashes"]
                for item in group
            )
            parity_ok = parity_ok and parity
            rows.append(
                {
                    "workers": worker,
                    "median_elapsed_s": elapsed,
                    "median_first_page_s": first,
                    "max_peak_working_set_mib": peak,
                    "artifact_bytes": max(item.get("artifact_bytes", 0) for item in group),
                    "speedup_vs_1": (
                        statistics.median(item["elapsed_s"] for item in samples[1])
                        / elapsed
                    ),
                    "parity": parity,
                }
            )

        print("\nTỔNG HỢP")
        print(
            "workers | elapsed median | first-page median | peak max | artifact | speedup | parity"
        )
        for row in rows:
            print(
                f"{row['workers']:>7} | {row['median_elapsed_s']:>14.3f}s | "
                f"{row['median_first_page_s']:>17.3f}s | "
                f"{row['max_peak_working_set_mib']:>8.1f}MiB | "
                f"{row['artifact_bytes'] / (1024 * 1024):>6.1f}MiB | "
                f"{row['speedup_vs_1']:>7.3f}x | {row['parity']}"
            )
        print("PRYNX_BENCH_SUMMARY=" + json.dumps(rows, ensure_ascii=False))
        return 0 if parity_ok else 2
    finally:
        import shutil

        shutil.rmtree(root_tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

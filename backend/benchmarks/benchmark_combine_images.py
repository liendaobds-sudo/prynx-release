"""Benchmark tái lập cho Combine nhiều PNG/JPEG.

Chạy từ thư mục backend sau khi build extension:
    python benchmarks/benchmark_combine_images.py path1.png ... path8.png
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time

import pikepdf

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# PERF (audit 2026-08-02 §B.3): benchmark chạy trực tiếp từ repo vẫn import được
# backend và in tiếng Việt ổn định trên console Windows.
for stream in (sys.stdout, sys.stderr):
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")

from app.core.system_memory import plan_worker_count
from app.workers import pdf_manifest_engine

try:
    import pdfcompare_native
except ImportError as exc:  # pragma: no cover - công cụ chạy tay
    raise SystemExit(
        "Chưa có pdfcompare_native trong venv. Hãy chạy maturin develop trước."
    ) from exc


def _percentile_95(values: list[float]) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * 0.95)))
    return ordered[index]


def _summarize(times: list[float], sizes: list[int]) -> dict[str, float | int]:
    return {
        "runs": len(times),
        "median_seconds": round(statistics.median(times), 4),
        "p95_seconds": round(_percentile_95(times), 4),
        "median_output_bytes": int(statistics.median(sizes)),
    }


def _verify_pdf(path: Path, expected_pages: int) -> int:
    with pikepdf.Pdf.open(path) as pdf:
        if len(pdf.pages) != expected_pages:
            raise RuntimeError(
                f"Output {path.name} có {len(pdf.pages)} trang, cần {expected_pages}"
            )
    return path.stat().st_size


def _native_request(paths: list[Path]) -> tuple[dict, int]:
    sources = []
    largest_worker_mb = 64.0
    for path in paths:
        info = pdf_manifest_engine._inspect_image_source(str(path))
        sources.append(
            {
                "path": str(path),
                "width_px": info.width_px,
                "height_px": info.height_px,
                "width_pt": info.width_pt,
                "height_pt": info.height_pt,
            }
        )
        largest_worker_mb = max(
            largest_worker_mb,
            info.pixels * 8 / (1024 * 1024) + 64,
        )

    workers, reason = plan_worker_count(
        kind="combine-images-native",
        per_worker_mb=largest_worker_mb,
        env_override="PRYNX_COMBINE_IMAGE_WORKERS",
    )
    print(f"[BENCH COMBINE] {reason}")
    return {
        "sources": sources,
        "pages": [
            {
                "blank": False,
                "file_index": index,
                "rotation": 0,
            }
            for index in range(len(paths))
        ],
    }, min(len(paths), workers)


def _run_native(
    request: dict,
    output: Path,
    workers: int,
    completed: list[int],
) -> None:
    pdfcompare_native.combine_image_manifest_native(
        json.dumps(request, ensure_ascii=False),
        str(output),
        workers,
        completed.append,
        lambda: False,
    )


def _run_backend(paths: list[Path], output: Path) -> None:
    # PERF (audit 2026-08-02 §B.3): ép tắt native trong nhánh baseline để không
    # đo cùng một engine hai lần sau khi merge_manifest đã được tăng tốc.
    original_loader = pdf_manifest_engine._load_native_image_merger
    pdf_manifest_engine._load_native_image_merger = lambda: None
    try:
        pdf_manifest_engine.merge_manifest(
            [str(path) for path in paths],
            [{"file_index": index} for index in range(len(paths))],
            str(output),
        )
    finally:
        pdf_manifest_engine._load_native_image_merger = original_loader


def _measure(
    label: str,
    output_dir: Path,
    warmups: int,
    repeats: int,
    expected_pages: int,
    runner,
) -> dict[str, float | int]:
    times: list[float] = []
    sizes: list[int] = []
    for iteration in range(warmups + repeats):
        output = output_dir / f"{label}_{iteration}.pdf"
        if output.exists():
            output.unlink()
        started = time.perf_counter()
        runner(output)
        elapsed = time.perf_counter() - started
        size = _verify_pdf(output, expected_pages)
        if iteration >= warmups:
            times.append(elapsed)
            sizes.append(size)
            print(
                f"[BENCH COMBINE] {label} lần {iteration - warmups + 1}: "
                f"{elapsed:.3f}s, {size / (1024 * 1024):.2f} MiB"
            )
    return _summarize(times, sizes)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="A/B backend ReportLab và fast path native cho Combine ảnh"
    )
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument(
        "--skip-backend",
        action="store_true",
        help="Chỉ đo native khi không muốn chờ baseline ReportLab",
    )
    args = parser.parse_args()

    paths = [path.resolve() for path in args.images]
    if not paths or any(not path.is_file() for path in paths):
        raise SystemExit("Danh sách ảnh chứa đường dẫn không tồn tại")
    if any(path.suffix.lower() not in {".png", ".jpg", ".jpeg"} for path in paths):
        raise SystemExit("Lô benchmark đầu chỉ nhận PNG/JPEG")
    if args.warmups < 0 or args.repeats <= 0:
        raise SystemExit("warmups phải >=0 và repeats phải >0")

    request, workers = _native_request(paths)
    completed: list[int] = []
    with tempfile.TemporaryDirectory(prefix="prynx_combine_benchmark_") as temp:
        output_dir = Path(temp)
        results = {
            "native": _measure(
                "native",
                output_dir,
                args.warmups,
                args.repeats,
                len(paths),
                lambda output: _run_native(request, output, workers, completed),
            )
        }
        if not args.skip_backend:
            results["backend_reportlab"] = _measure(
                "backend",
                output_dir,
                args.warmups,
                args.repeats,
                len(paths),
                lambda output: _run_backend(paths, output),
            )

    print(
        json.dumps(
            {
                "images": len(paths),
                "workers": workers,
                "completed_source_events": len(completed),
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

"""Benchmark read-only cho pipeline export ảnh PDF.

Chạy trên Windows với backend venv:

    backend\venv\Scripts\python.exe scripts\benchmark_export_images.py

Không sửa file nguồn; output tạm tự dọn sau khi đo.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PDF = ROOT / "backend" / "tests" / "preflight_fixtures" / "pdfs" / "13_multipage_15.pdf"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--color-mode", choices=("rgb", "gray", "cmyk"), default="rgb")
    parser.add_argument("--multipage-tiff", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "backend"))
    from app.api.routes.export import render_pdf_to_images

    if not args.pdf.exists():
        raise FileNotFoundError(args.pdf)
    with tempfile.TemporaryDirectory(prefix="prynx_export_bench_") as temp_dir:
        started = time.perf_counter()
        files = render_pdf_to_images(
            str(args.pdf),
            temp_dir,
            fmt="tiff" if args.multipage_tiff or args.color_mode == "cmyk" else "png",
            dpi=args.dpi,
            color_mode=args.color_mode,
            multipage_tiff=args.multipage_tiff,
        )
        elapsed = time.perf_counter() - started
        total_bytes = sum(os.path.getsize(path) for path in files)
    print(json.dumps({
        "pdf": str(args.pdf),
        "pages": len(files),
        "dpi": args.dpi,
        "color_mode": args.color_mode,
        "multipage_tiff": args.multipage_tiff,
        "elapsed_s": round(elapsed, 4),
        "artifact_bytes": total_bytes,
        "per_page_ms": round(elapsed * 1000 / max(1, len(files)), 2),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

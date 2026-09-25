"""Đọc cấu hình luồng thực ở biên worker; engine giả không dựng hoặc sửa PDF."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
from app.workers import sticker_engine as engine_module
from app.utils import cutline_debug_log


def native_threads():
    import numpy

    libraries = Path(numpy.__file__).resolve().parent.parent / "numpy.libs"
    entries = []
    for path in libraries.glob("*openblas*.dll"):
        library = ctypes.CDLL(str(path))
        for symbol in ("openblas_get_num_threads64_", "openblas_get_num_threads", "openblas_get_num_threads_"):
            try:
                getter = getattr(library, symbol)
            except AttributeError:
                continue
            getter.argtypes = []
            getter.restype = ctypes.c_int
            entries.append({"dll": path.name, "symbol": symbol, "num_threads": getter()})
            break
    return entries


def snapshot():
    return {"openblas_env": os.environ.get("OPENBLAS_NUM_THREADS"),
            "numpy_openblas": native_threads(),
            "opencv_threads": engine_module.cv2.getNumThreads()}


def main():
    captured = {}

    class StubEngine:
        def __init__(self, **kwargs):
            pass

        def process_pdf(self, **kwargs):
            captured.update(snapshot())
            return (b"", [], [], False)

    before = snapshot()
    args = {key: None for key in (
        "dpi", "debug", "input_path", "cut_mode", "offset_mm", "corner_style",
        "cut_color", "bleed_mm", "fill_holes", "remove_white_bg", "bleed_color_type",
        "solid_bleed_color", "draw_cut_contour", "rectangle_mode", "edge_bite_mm",
        "cut_first_page_only",
    )}
    args.update(chunk_idx=0, page_indices=[0], threads_per_worker=1)
    with patch.object(engine_module, "StickerEngine", StubEngine), patch.object(cutline_debug_log, "log_cutline", lambda *a, **k: None):
        engine_module._process_sticker_chunk(args)
    evidence = {
        "scope": "Gọi worker thật với StickerEngine giả, không render PDF và không phải benchmark đa process",
        "logical_cpu_count": os.cpu_count(), "requested_threads_per_worker": 1,
        "before_worker": before, "inside_engine_after_worker_env_setup": captured,
    }
    Path(__file__).with_name("worker_threads_evidence.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()

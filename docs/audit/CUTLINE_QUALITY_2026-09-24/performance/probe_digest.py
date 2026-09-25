"""Probe nhẹ: đếm đọc hash và lỗi bị nuốt, không dựng hình học/PDF mới."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
from app.workers import sticker_classic_page_preview as preview


def main():
    source = ROOT / "test" / "Binder2.pdf"
    original_digest = hashlib.file_digest
    calls = []
    caught = []

    def counted(stream, *args, **kwargs):
        calls.append(str(stream.name))
        return original_digest(stream, *args, **kwargs)

    def trace(frame, event, arg):
        if event == "exception" and frame.f_code is preview.source_digest.__code__:
            caught.append({"line": frame.f_lineno, "type": arg[0].__name__, "message": str(arg[1])})
        return trace

    preview._DIGEST_CACHE.clear()
    values = []
    elapsed_ms = []
    sys.settrace(trace)
    try:
        with patch.object(preview.hashlib, "file_digest", counted):
            for _ in range(3):
                start = time.perf_counter()
                values.append(preview.source_digest(source))
                elapsed_ms.append((time.perf_counter() - start) * 1000)
    finally:
        sys.settrace(None)
    evidence = {
        "scope": "Gọi helper thật, không HTTP/Tauri; timer có trace instrumentation, không dùng làm benchmark speedup",
        "source": str(source), "source_bytes": source.stat().st_size,
        "source_sha256": values[0], "returned_same_digest": len(set(values)) == 1,
        "os_imported_in_module": "os" in vars(preview),
        "file_digest_calls_for_three_identical_requests": len(calls),
        "cache_entries_after": len(preview._DIGEST_CACHE),
        "caught_exceptions": caught, "elapsed_ms_with_trace": elapsed_ms,
    }
    target = Path(__file__).with_name("digest_evidence.json")
    target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()

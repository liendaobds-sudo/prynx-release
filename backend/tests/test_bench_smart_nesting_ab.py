"""Hợp đồng tối thiểu cho harness A/B native smart nesting."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "bench_smart_nesting_ab.py"


def _module():
    spec = importlib.util.spec_from_file_location("bench_smart_nesting_ab", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_harness_doc_lap_nhan_dien_hai_corpus_that():
    bench = _module()
    generic = bench.load_requests(ROOT / "backend/tests/fixtures/mixed_nesting/corpus.json")
    step_repeat = bench.load_requests(
        ROOT / "imposition_core/tests/fixtures/step_repeat_user_pages_20260907.json"
    )
    assert generic and all(case["mode"] == "generic" for case in generic)
    assert step_repeat and all(case["mode"] == "sr" for case in step_repeat)
    assert all(len(case["requestDigest"]) == 64 for case in generic + step_repeat)


def test_harness_timer_va_bang_chung_khong_nap_hai_native_cung_process():
    source = SCRIPT.read_text(encoding="utf-8")
    assert "subprocess.run" in source
    assert "before -> after" in source
    assert "after -> before" in source
    assert "t0 = time.perf_counter()" in source
    assert "encoded = run.solve(request_payload, expected_worker_grant)" in source
    assert "json.loads(encoded)" in source
    assert "validate_manifest" in source

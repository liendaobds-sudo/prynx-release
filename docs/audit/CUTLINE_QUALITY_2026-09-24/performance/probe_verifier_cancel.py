"""Hủy giữa verifier thật trên circle nhỏ, không dựng PDF hoặc chạy optimizer."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
from app.workers import cutline_fair_verify as verifier
from app.workers.cutline_polyline_reduction import split_cubic
from app.workers.cutline_preview_cancel import PreviewCancellation, PreviewCancelled, cancellation_scope


def main():
    r, k = 3.0, 3.0 * 0.5522847498307936
    candidate = [((r, 0.), (r, k), (k, r), (0., r)),
                 ((0., r), (-k, r), (-r, k), (-r, 0.)),
                 ((-r, 0.), (-r, -k), (-k, -r), (0., -r)),
                 ((0., -r), (k, -r), (r, -k), (r, 0.))]
    source = [part for curve in candidate for part in split_cubic(curve, .37)]
    token = PreviewCancellation()
    original_metrics, original_distance = verifier._curve_metrics, verifier._distance_bound
    metrics_calls, distance_calls = [], []

    def metrics(*args, **kwargs):
        token.cancel()
        metrics_calls.append(len(args[0]))
        return original_metrics(*args, **kwargs)

    def distance(*args, **kwargs):
        distance_calls.append(True)
        return original_distance(*args, **kwargs)

    start = time.perf_counter()
    try:
        with cancellation_scope(token), patch.object(verifier, "_curve_metrics", metrics), patch.object(verifier, "_distance_bound", distance):
            result = verifier.verify_fair_ring(source, candidate, tolerance_mm=.05)
        cancelled = False
        try:
            token.check()
        except PreviewCancelled:
            cancelled = True
        evidence = {
            "scope": "Hủy trong callback metric đầu tiên của verifier thật; circle 8->4 cubic; không solver/PDF/HTTP/Tauri",
            "token_cancelled": cancelled, "verifier_returned_accepted_after_cancel": result.accepted,
            "metric_calls_after_cancel": len(metrics_calls), "distance_bound_calls_after_cancel": len(distance_calls),
            "elapsed_ms_instrumented": (time.perf_counter() - start) * 1000,
            "limitation": "Chứng minh verifier tiếp tục tính sau cancel, không chứng minh publish stale; job caller vẫn chặn publish. Chưa đo latency worst-case.",
        }
    finally:
        token.close()
    Path(__file__).with_name("verifier_cancel_evidence.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()

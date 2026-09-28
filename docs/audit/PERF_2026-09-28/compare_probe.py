"""Adapter audit cho benchmark cũ: fixture token chỉ trong child riêng.

Benchmark gốc vẫn dùng env token nhưng guard nay chỉ nhận nó trong DEV_MODE.
Không bật DEV_MODE, không sửa guard/source, không chạy API đang phục vụ người dùng.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))


def main():
    os.environ["DEV_MODE"] = "false"
    os.environ["DATABASE_URL"] = "sqlite:///:memory:"
    os.environ.pop("PRYNX_TOKEN_SOURCE", None)
    if "--child" in sys.argv:
        work = Path(sys.argv[sys.argv.index("--work-dir") + 1]).resolve()
        os.environ["UPLOAD_DIR"] = str(work / "uploads")
        os.environ["RESULTS_DIR"] = str(work / "results")
        from app.core import license_guard
        license_guard._SIDECAR_TOKEN = "audit-local-benchmark-fixture"
        license_guard._SIDECAR_MASTER_TOKEN = None

    import benchmark_compare_pipeline as benchmark
    benchmark.__file__ = __file__
    original_run_one = benchmark._run_one

    def sampled(*args, **kwargs):
        result = original_run_one(*args, **kwargs)
        fields = ["workers", "elapsed_s", "first_page_s", "peak_working_set_mib", "artifact_bytes", "stages"]
        print("PRYNX_AUDIT_SAMPLE=" + json.dumps({key: result.get(key) for key in fields}), flush=True)
        return result

    benchmark._run_one = sampled
    return benchmark.main()


if __name__ == "__main__":
    raise SystemExit(main())

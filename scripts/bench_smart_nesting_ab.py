"""Đo A/B native cho smart nesting mà không làm bẩn process backend.

Đây là công cụ dev offline, không nằm trên đường thực thi sản xuất. Mỗi lần đo
được chạy trong process Python riêng vì hai wheel ``pdfcompare_native`` không thể
được nạp đồng thời trong một process. Driver chạy xen kẽ ``before -> after`` rồi
``after -> before``; hai bên không bao giờ chạy song song.

Ví dụ (corpus generic):

    backend\\venv\\Scripts\\python.exe scripts\\bench_smart_nesting_ab.py \
      --before native-before --after native-after \
      --requests backend/tests/fixtures/mixed_nesting/corpus.json \
      --runs 3 --warmups 1 --output tmp/smart-ab.json

Ví dụ (corpus S&R thật):

    ... --requests imposition_core/tests/fixtures/step_repeat_user_pages_20260907.json

``--native`` có thể là thư mục chứa ``pdfcompare_native*.pyd`` hoặc đường dẫn
đến chính file extension. Worker chỉ thêm thư mục đó vào ``sys.path`` rồi import
native trực tiếp; không dùng fake solver/fallback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parents[1]
WORKER_PROTOCOL = 1
SR_INTENTS = {"step_repeat_single_sheet"}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def native_identity(path: Path) -> dict[str, Any]:
    """Ghi nhận chính xác artifact native mà child process sẽ ưu tiên nạp."""

    resolved = path.resolve()
    if resolved.is_file():
        return {"path": str(resolved), "sha256": _sha256_file(resolved), "kind": "file"}
    if not resolved.is_dir():
        return {"path": str(resolved), "sha256": None, "kind": "missing"}
    all_candidates = sorted(
        item for item in resolved.rglob("*")
        if item.is_file() and item.name.lower().startswith("pdfcompare_native")
        and item.suffix.lower() in {".pyd", ".dll", ".so", ".dylib"}
    )
    package_candidates = [
        item for item in all_candidates
        if item.parent.name == "pdfcompare_native" and (item.parent / "__init__.py").is_file()
    ]
    candidates = package_candidates or [item for item in all_candidates if not item.parent.name.startswith("~")]
    return {
        "path": str(resolved),
        "sha256": _sha256_file(candidates[0]) if len(candidates) == 1 else None,
        "kind": "directory",
        "candidates": [str(item) for item in candidates],
        "candidateSha256": {str(item): _sha256_file(item) for item in candidates},
        "candidateCount": len(candidates),
    }


def resolve_native(path: Path) -> tuple[Path, Path]:
    """Resolve exactly one extension and its import root; never fall back to installed native."""

    resolved = path.resolve()
    if resolved.is_file():
        candidate = resolved
    elif resolved.is_dir():
        all_candidates = sorted(
            item for item in resolved.rglob("*")
            if item.is_file()
            and item.name.lower().startswith("pdfcompare_native")
            and item.suffix.lower() in {".pyd", ".dll", ".so", ".dylib"}
        )
        package_candidates = [
            item for item in all_candidates
            if item.parent.name == "pdfcompare_native" and (item.parent / "__init__.py").is_file()
        ]
        candidates = package_candidates or [item for item in all_candidates if not item.parent.name.startswith("~")]
        if len(candidates) != 1:
            raise RuntimeError(f"native directory must contain exactly one extension, got {len(candidates)}: {resolved}")
        candidate = candidates[0]
    else:
        raise RuntimeError(f"native path does not exist: {resolved}")
    if candidate.parent.name.lower() == "pdfcompare_native" and (candidate.parent / "__init__.py").is_file():
        import_root = candidate.parent.parent
    else:
        import_root = candidate.parent
    return candidate, import_root


def _case_mode(case: dict[str, Any], request: dict[str, Any]) -> str:
    explicit = str(case.get("mode", "")).strip().lower()
    if explicit in {"sr", "s&r", "step_repeat", "step-repeat"}:
        return "sr"
    if explicit in {"generic", "free", "mixed"}:
        return "generic"
    return "sr" if request.get("layoutIntent") in SR_INTENTS else "generic"


def load_requests(path: Path) -> list[dict[str, Any]]:
    """Đọc list request từ corpus generic hoặc fixture S&R production."""

    with path.open("r", encoding="utf-8") as handle:
        source = json.load(handle)
    if isinstance(source, list):
        raw_cases: Iterable[Any] = source
    elif isinstance(source, dict) and isinstance(source.get("cases"), list):
        raw_cases = source["cases"]
    else:
        raise ValueError("--requests phải là list hoặc object có cases[]")

    result: list[dict[str, Any]] = []
    for index, item in enumerate(raw_cases):
        if not isinstance(item, dict):
            raise ValueError(f"cases[{index}] phải là object")
        request = item.get("engineRequest", item.get("request"))
        if not isinstance(request, dict):
            raise ValueError(f"cases[{index}] thiếu engineRequest/request")
        case_id = str(item.get("id", item.get("caseId", item.get("label", f"case-{index + 1}"))))
        mode = _case_mode(item, request)
        result.append({
            "id": case_id,
            "mode": mode,
            "request": request,
            "requestDigest": _sha256_bytes(_canonical(request)),
            "sourceIndex": index,
            "sourcePage": item.get("sourcePage"),
        })
    if not result:
        raise ValueError("--requests không có case nào")
    return result


def _progress(run: Any) -> dict[str, Any] | None:
    try:
        value = json.loads(run.progress())
        return value if isinstance(value, dict) else {"value": value}
    except Exception as exc:  # noqa: BLE001 - diagnostic only
        return {"error": f"{type(exc).__name__}: {exc}"}


def _score_summary(manifest: dict[str, Any]) -> Any:
    search = manifest.get("search")
    if isinstance(search, dict):
        for key in ("selectedScore", "bestScore", "score", "objective"):
            if key in search:
                return search[key]
    stats = manifest.get("stats")
    if isinstance(stats, dict):
        for key in ("score", "objective"):
            if key in stats:
                return stats[key]
    return None


def _metrics(manifest: dict[str, Any], *, validation: dict[str, Any]) -> dict[str, Any]:
    placements = manifest.get("placements")
    if not isinstance(placements, list):
        placements = []
    stats = manifest.get("stats") if isinstance(manifest.get("stats"), dict) else {}
    pose_rows = [item.get("pose") for item in placements if isinstance(item, dict)]
    return {
        "manifestHash": _sha256_bytes(_canonical(manifest)),
        "placementsHash": _sha256_bytes(_canonical(placements)),
        "posesHash": _sha256_bytes(_canonical(pose_rows)),
        "status": manifest.get("status"),
        "sheetCount": stats.get("sheetCount"),
        "placedCount": stats.get("placedCount", len(placements)),
        "unplacedCount": stats.get("unplacedCount"),
        "terminationReason": stats.get("terminationReason"),
        "score": _score_summary(manifest),
        "validation": manifest.get("validation"),
        "revalidation": validation,
        "provenance": manifest.get("provenance"),
        "search": manifest.get("search"),
    }


def _worker(native_path: str, case: dict[str, Any], runs: int, warmups: int, workers: int | None) -> int:
    """Child process: native import + solve timing, one case only."""

    path = Path(native_path).expanduser().resolve()
    candidate, import_dir = resolve_native(path)
    sys.path.insert(0, str(import_dir))
    expected_worker_grant = workers if workers is not None else 1
    if workers is not None:
        # Chỉ là lab override; không áp cap mặc định lên máy mạnh.
        os.environ["PRYNX_MIXED_NEST_WORKERS"] = str(workers)
    started = time.perf_counter()
    try:
        import pdfcompare_native as native  # noqa: PLC0415 - cố ý nạp sau sys.path

        loaded_module = getattr(native, "pdfcompare_native", native)
        loaded_file = Path(getattr(loaded_module, "__file__", "")).resolve()
        if loaded_file != candidate:
            raise RuntimeError(f"native import mismatch: expected {candidate}, loaded {loaded_file}")

        run_class = getattr(native, "MixedNestingRun", None)
        if run_class is None:
            raise RuntimeError("pdfcompare_native không có MixedNestingRun")
        capabilities_raw = json.loads(run_class.capabilities())
        if not isinstance(capabilities_raw, dict):
            raise RuntimeError("capabilities không phải object")
        request_payload = json.dumps(case["request"], ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        rows: list[dict[str, Any]] = []
        for warmup_index in range(max(0, warmups)):
            warmup_run = run_class()
            warmup_run.solve(request_payload, expected_worker_grant)
            # Parse outside benchmark timer; warmup chỉ làm nóng native/cache.
            warmup_progress = _progress(warmup_run)
            rows.append({"phase": "warmup", "index": warmup_index, "progress": warmup_progress})
        for run_index in range(max(1, runs)):
            run = run_class()
            progress_before = _progress(run)
            # Chỉ lời gọi native solve nằm trong vùng đo. JSON parse/hash/validate ở ngoài.
            t0 = time.perf_counter()
            encoded = run.solve(request_payload, expected_worker_grant)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            progress_after = _progress(run)
            parse_error: str | None = None
            manifest: dict[str, Any] | None = None
            try:
                manifest_value = json.loads(encoded)
                if not isinstance(manifest_value, dict):
                    raise ValueError("manifest không phải object")
                manifest = manifest_value
            except Exception as exc:  # noqa: BLE001 - retain raw diagnostic
                parse_error = f"{type(exc).__name__}: {exc}"
            validation = {"checked": False}
            if manifest is not None:
                validate_fn = getattr(run_class, "validate_manifest", None)
                has_production_contract = "productionContract" in case["request"]
                if callable(validate_fn) and has_production_contract:
                    try:
                        validate_fn(request_payload, json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
                        validation = {"checked": True, "valid": True}
                    except Exception as exc:  # noqa: BLE001 - retain evidence
                        validation = {"checked": True, "valid": False, "error": f"{type(exc).__name__}: {exc}"}
                elif callable(validate_fn):
                    validation = {"checked": False, "reason": "generic request has no productionContract"}
                else:
                    validation = {"checked": False, "reason": "native validate_manifest unavailable"}
            actual_grant = (
                row_progress.get("runtimeControl", {}).get("workerGrant")
                if isinstance((row_progress := progress_after), dict)
                else None
            )
            if actual_grant is not None and actual_grant != expected_worker_grant:
                raise RuntimeError(
                    f"worker grant mismatch: requested={expected_worker_grant}, actual={actual_grant}"
                )
            row: dict[str, Any] = {
                "phase": "run",
                "index": run_index,
                "elapsedMs": round(elapsed_ms, 4),
                "progressBefore": progress_before,
                "progressAfter": progress_after,
                "parseError": parse_error,
            }
            if manifest is not None:
                row.update(_metrics(manifest, validation=validation))
            rows.append(row)
        run_rows = [row for row in rows if row.get("phase") == "run" and isinstance(row.get("elapsedMs"), (int, float))]
        elapsed = [float(row["elapsedMs"]) for row in run_rows]
        payload = {
            "protocol": WORKER_PROTOCOL,
            "caseId": case["id"],
            "mode": case["mode"],
            "requestDigest": case["requestDigest"],
            "native": native_identity(path),
            "capabilities": capabilities_raw,
            "warmups": max(0, warmups),
            "runs": max(1, runs),
            "workers": workers,
            "startedMonotonic": started,
            "results": rows,
            "summary": {
                "p50Ms": round(statistics.median(elapsed), 4) if elapsed else None,
                "minMs": round(min(elapsed), 4) if elapsed else None,
                "maxMs": round(max(elapsed), 4) if elapsed else None,
            },
        }
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as exc:  # noqa: BLE001 - child must preserve usable error text
        payload = {
            "protocol": WORKER_PROTOCOL,
            "caseId": case.get("id"),
            "mode": case.get("mode"),
            "requestDigest": case.get("requestDigest"),
            "native": native_identity(path),
            "error": f"{type(exc).__name__}: {exc}",
        }
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 2


def _invoke(native_path: Path, case: dict[str, Any], runs: int, warmups: int, workers: int | None) -> dict[str, Any]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--native",
        str(native_path),
        "--case-stdin",
        "--runs",
        str(runs),
        "--warmups",
        str(warmups),
    ]
    if workers is not None:
        command.extend(["--workers", str(workers)])
    wall_start = time.perf_counter()
    completed = subprocess.run(
        command,
        cwd=str(ROOT),
        input=json.dumps(case, ensure_ascii=False, separators=(",", ":")),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    wall_seconds = time.perf_counter() - wall_start
    parsed: dict[str, Any] | None = None
    for line in reversed(completed.stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("protocol") == WORKER_PROTOCOL:
            parsed = candidate
            break
    return {
        "exitCode": completed.returncode,
        "wallSeconds": round(wall_seconds, 6),
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "result": parsed,
        "command": command,
    }


def run_driver(args: argparse.Namespace) -> dict[str, Any]:
    if args.runs < 1 or args.warmups < 0 or args.rounds < 1:
        raise ValueError("runs/rounds phải >= 1, warmups phải >= 0")
    if args.workers is not None and args.workers < 1:
        raise ValueError("workers phải là số dương khi truyền override")
    requests_path = Path(args.requests).expanduser().resolve()
    cases = load_requests(requests_path)
    selected = [case for case in cases if args.mode == "all" or case["mode"] == args.mode]
    if not selected:
        raise ValueError(f"Không có case thuộc mode {args.mode!r}")
    before = Path(args.before).expanduser().resolve()
    after = Path(args.after).expanduser().resolve()
    invocations: list[dict[str, Any]] = []
    grouped: dict[str, dict[str, Any]] = {
        case["id"]: {"mode": case["mode"], "requestDigest": case["requestDigest"], "sourcePage": case.get("sourcePage"), "before": [], "after": []}
        for case in selected
    }
    for round_index in range(max(1, args.rounds)):
        sides = [("before", before), ("after", after)] if round_index % 2 == 0 else [("after", after), ("before", before)]
        for side, native_path in sides:
            for case in selected:
                invocation = _invoke(native_path, case, args.runs, args.warmups, args.workers)
                record = {"round": round_index, "side": side, "caseId": case["id"], "native": native_identity(native_path), **invocation}
                invocations.append(record)
                grouped[case["id"]][side].append(record)
    return {
        "schemaVersion": 1,
        "tool": "bench_smart_nesting_ab",
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version,
        "requests": {"path": str(requests_path), "sha256": _sha256_file(requests_path), "caseCount": len(selected)},
        "selection": {"mode": args.mode, "rounds": max(1, args.rounds), "runs": max(1, args.runs), "warmups": max(0, args.warmups), "workers": args.workers},
        "native": {"before": native_identity(before), "after": native_identity(after)},
        "cases": grouped,
        "invocations": invocations,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", help="thư mục/file native bản trước")
    parser.add_argument("--after", help="thư mục/file native bản sau")
    parser.add_argument("--requests", help="fixture JSON có cases[*].engineRequest hoặc cases[*].request")
    parser.add_argument("--output", help="đường dẫn evidence JSON của driver")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--workers", type=int, default=None, help="override lab PRYNX_MIXED_NEST_WORKERS; bỏ trống để planner tự chọn")
    parser.add_argument("--mode", choices=("all", "sr", "generic"), default="all")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--native")
    parser.add_argument("--case-json")
    parser.add_argument("--case-stdin", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker:
        if not args.native or (not args.case_json and not args.case_stdin):
            parser.error("worker cần --native và --case-json hoặc --case-stdin")
        if args.runs < 1 or args.warmups < 0:
            parser.error("runs phải >= 1, warmups phải >= 0")
        if args.workers is not None and args.workers < 1:
            parser.error("workers phải là số dương")
        case_text = args.case_json if args.case_json is not None else sys.stdin.read()
        case = json.loads(case_text)
        return _worker(args.native, case, args.runs, args.warmups, args.workers)
    for required in ("before", "after", "requests", "output"):
        if not getattr(args, required):
            parser.error(f"thiếu --{required}")
    report = run_driver(args)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "caseCount": report["requests"]["caseCount"], "invocations": len(report["invocations"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

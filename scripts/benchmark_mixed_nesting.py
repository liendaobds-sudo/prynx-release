"""Benchmark "Bình lồng ghép tự do" — phase P7b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §14, §17.

Chạy bằng Python của ``backend/venv`` từ thư mục gốc::

    backend\\venv\\Scripts\\python.exe scripts\\benchmark_mixed_nesting.py
    backend\\venv\\Scripts\\python.exe scripts\\benchmark_mixed_nesting.py --case ANGLE_ONLY --profiles balanced --runs 5
    backend\\venv\\Scripts\\python.exe scripts\\benchmark_mixed_nesting.py --json out.json

Bốn ràng buộc của script này, mỗi cái có test ở
``backend/tests/test_mixed_nesting_benchmark_contract.py``:

1. **Gọi đúng bridge thật** ``app.core.mixed_nesting_service`` — không có nhánh giả lập,
   không tự dựng lại solver. Thiếu native thì báo rõ và thoát, không "chạy tạm".
2. **Cardinal baseline là SÀN AN TOÀN**, không phải legal domain. Mọi dòng so sánh đều
   ghi kèm nhãn đó; baseline được dựng bằng cách **thay** rotation constraint thành
   ``discrete [0,90,180,270]``, không phải bằng cách đổi profile.
3. **Determinism đo bằng work-plan cố định** (không truyền ``timeBudgetMs``). Chế độ
   deadline đo quality-over-time và **không** đòi hai máy dừng cùng pose.
4. **Report ghi máy + số đo tìm kiếm**: CPU, tier RAM, worker theo planner, engine
   version, p50/p95, peak RSS cây tiến trình, sheetCount, utilization tính LẠI từ
   contour, unplaced, orientation evaluations, pose refinements, terminationReason.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
CORPUS_PATH = BACKEND / "tests" / "fixtures" / "mixed_nesting" / "corpus.json"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

#: Ba ca bắt buộc của gate P7b. Thiếu một ca là báo cáo không đủ bằng chứng.
REQUIRED_CASE_IDS = ("ANGLE_ONLY", "CONTINUOUS_XY", "CONSTRAINTS")

PROFILES = ("fast", "balanced", "tight")

#: Nhãn phải xuất hiện trong mọi báo cáo có so sánh baseline (§17).
BASELINE_DISCLAIMER = (
    "Baseline bốn góc cardinal là SÀN AN TOÀN để so sánh, "
    "KHÔNG phải legal domain của sản phẩm."
)

CARDINAL_ANGLES_DEG = (0.0, 90.0, 180.0, 270.0)


# ─────────────────────────────────────────────────────────────────────────────
#  Máy
# ─────────────────────────────────────────────────────────────────────────────


def _working_set_tree_bytes(root_pid: int) -> int:
    """Tổng working set của cây tiến trình. Trả 0 nếu không đọc được."""
    if os.name != "nt":
        try:
            with open(f"/proc/{root_pid}/status", "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("VmRSS:"):
                        return int(line.split()[1]) * 1024
        except OSError:
            return 0
        return 0

    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(
        process_query_limited_information, False, root_pid
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
        return int(counters.PeakWorkingSetSize) if ok else 0
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _ram_tier(total_mb: float | None) -> str:
    if total_mb is None:
        return "unknown"
    if total_mb < 8 * 1024:
        return "<8GB"
    if total_mb < 16 * 1024:
        return "<16GB"
    if total_mb < 64 * 1024:
        return ">=16GB"
    return ">=64GB"


def describe_machine(request: dict[str, Any]) -> dict[str, Any]:
    """Ảnh chụp phần cứng + ngân sách planner. Số worker lấy từ planner, không bịa."""
    from app.core.mixed_nesting_service import plan_hardware
    from app.core.system_memory import read_memory_status_mb

    total_mb, available_mb = read_memory_status_mb()
    plan = plan_hardware(request)
    return {
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "cpuCount": os.cpu_count(),
        "ramTotalMb": round(total_mb, 1) if total_mb is not None else None,
        "ramAvailableMb": round(available_mb, 1) if available_mb is not None else None,
        "ramTier": _ram_tier(total_mb),
        "workers": plan.workers,
        "perWorkerMb": round(plan.per_worker_mb, 2),
        "estimatedPeakMb": round(plan.estimated_peak_mb, 2),
        "plannerReason": plan.reason,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Corpus
# ─────────────────────────────────────────────────────────────────────────────


def load_corpus(path: Path = CORPUS_PATH) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        corpus = json.load(handle)
    ids = [case["id"] for case in corpus["cases"]]
    missing = [name for name in REQUIRED_CASE_IDS if name not in ids]
    if missing:
        raise SystemExit(f"Corpus thiếu ca bắt buộc: {', '.join(missing)}")
    return corpus


def cardinal_baseline_request(request: dict[str, Any]) -> dict[str, Any]:
    """Bản sao chỉ cho bốn góc cardinal — **sàn an toàn**, không phải legal domain.

    Thay rotation constraint ở CẢ policy cấp job lẫn từng chi tiết. Cố ý không đụng tới
    ``profile``: thu hẹp miền góc bằng profile là đúng thứ kế hoạch cấm.
    """
    cardinal = {"mode": "discrete", "anglesDeg": list(CARDINAL_ANGLES_DEG)}
    baseline = json.loads(json.dumps(request))
    baseline["orientationPolicy"]["defaultRotation"] = dict(cardinal)
    for part in baseline["parts"]:
        part["rotationConstraint"] = dict(cardinal)
    return baseline


# ─────────────────────────────────────────────────────────────────────────────
#  Số đo dẫn xuất
# ─────────────────────────────────────────────────────────────────────────────


def _ring_area_mm2(ring: list[list[float]]) -> float:
    total = 0.0
    count = len(ring)
    for index in range(count):
        x1, y1 = ring[index][0], ring[index][1]
        x2, y2 = ring[(index + 1) % count][0], ring[(index + 1) % count][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def recompute_utilization(request: dict[str, Any], manifest: dict[str, Any]) -> float | None:
    """Tính LẠI ``materialUtilization`` từ contour + số tờ (§17: không tin số solver báo)."""
    sheet = request["sheet"]
    sheet_count = int(manifest.get("stats", {}).get("sheetCount") or 0)
    if sheet_count <= 0:
        return None

    area_by_part = {
        part["partId"]: _ring_area_mm2(part["outer"]) for part in request["parts"]
    }
    placed_area = sum(
        area_by_part.get(placement["partId"], 0.0)
        for placement in manifest.get("placements", [])
    )
    sheet_area = float(sheet["widthMm"]) * float(sheet["heightMm"]) * sheet_count
    if sheet_area <= 0.0:
        return None
    return placed_area / sheet_area


def _is_cardinal(angle_deg: float, tolerance_deg: float = 1e-6) -> bool:
    for cardinal in CARDINAL_ANGLES_DEG:
        if abs(((angle_deg - cardinal + 180.0) % 360.0) - 180.0) <= tolerance_deg:
            return True
    return False


def pose_metrics(manifest: dict[str, Any]) -> dict[str, Any]:
    """Bằng chứng free-angle và continuous X/Y, đọc trực tiếp từ manifest."""
    non_cardinal = 0
    fractional_xy = 0
    for placement in manifest.get("placements", []):
        pose = placement.get("pose") or {}
        angle = float(pose.get("rotationDeg", 0.0))
        tx = float(pose.get("translateXmm", 0.0))
        ty = float(pose.get("translateYmm", 0.0))
        if not _is_cardinal(angle):
            non_cardinal += 1
        if abs(tx - round(tx)) > 1e-9 or abs(ty - round(ty)) > 1e-9:
            fractional_xy += 1
    return {
        "nonCardinalAngleCount": non_cardinal,
        "fractionalTranslationCount": fractional_xy,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Chạy
# ─────────────────────────────────────────────────────────────────────────────


def solve_once(request: dict[str, Any]) -> tuple[dict[str, Any], float]:
    """Một lần solve qua bridge THẬT. Trả ``(manifest, wall_seconds)``."""
    from app.core.mixed_nesting_service import create_run

    handle = create_run()
    started = time.perf_counter()
    manifest = handle.solve(request)
    return manifest, time.perf_counter() - started


def run_case(
    request: dict[str, Any],
    *,
    profile: str,
    runs: int,
    time_budget_ms: int | None,
) -> dict[str, Any]:
    """Chạy một cấu hình ``runs`` lần và tổng hợp.

    ``time_budget_ms=None`` ⇒ **work-plan cố định**: dùng cho determinism. Có budget ⇒
    chế độ deadline: chỉ cam kết best-so-far hợp lệ.
    """
    payload = json.loads(json.dumps(request))
    payload["profile"] = profile
    if time_budget_ms is None:
        payload.pop("timeBudgetMs", None)
    else:
        payload["timeBudgetMs"] = int(time_budget_ms)

    durations: list[float] = []
    manifests: list[dict[str, Any]] = []
    peak_rss = 0
    for _ in range(max(1, runs)):
        manifest, elapsed = solve_once(payload)
        durations.append(elapsed)
        manifests.append(manifest)
        peak_rss = max(peak_rss, _working_set_tree_bytes(os.getpid()))

    last = manifests[-1]
    stats = last.get("stats", {})
    sorted_durations = sorted(durations)
    p50 = statistics.median(sorted_durations)
    p95_index = min(len(sorted_durations) - 1, math.ceil(0.95 * len(sorted_durations)) - 1)

    # Determinism chỉ có nghĩa với work-plan cố định.
    canonical = [json.dumps(item.get("placements"), sort_keys=True) for item in manifests]
    deterministic = len(set(canonical)) == 1 if time_budget_ms is None else None

    return {
        "profile": profile,
        "runs": len(durations),
        "mode": "fixed_work_plan" if time_budget_ms is None else "deadline",
        "timeBudgetMs": time_budget_ms,
        "p50Ms": round(p50 * 1000.0, 2),
        "p95Ms": round(sorted_durations[p95_index] * 1000.0, 2),
        "minMs": round(sorted_durations[0] * 1000.0, 2),
        "maxMs": round(sorted_durations[-1] * 1000.0, 2),
        "peakRssMb": round(peak_rss / (1024.0 * 1024.0), 1),
        "deterministic": deterministic,
        "status": last.get("status"),
        "sheetCount": stats.get("sheetCount"),
        "placedCount": stats.get("placedCount"),
        "unplacedCount": stats.get("unplacedCount"),
        "reportedUtilization": stats.get("materialUtilization"),
        "recomputedUtilization": recompute_utilization(payload, last),
        "elapsedMsReported": stats.get("elapsedMs"),
        "attempts": stats.get("attempts"),
        "orientationEvaluations": stats.get("orientationEvaluations"),
        "poseRefinements": stats.get("poseRefinements"),
        "terminationReason": stats.get("terminationReason"),
        "validation": last.get("validation"),
        **pose_metrics(last),
    }


def benchmark(
    *,
    case_ids: list[str] | None,
    profiles: list[str],
    runs: int,
    deadline_ms: int | None,
    corpus_path: Path = CORPUS_PATH,
) -> dict[str, Any]:
    from app.core.mixed_nesting_service import EngineUnavailableError, engine_capabilities

    try:
        capabilities = engine_capabilities()
    except EngineUnavailableError as exc:
        raise SystemExit(
            f"Không chạy được benchmark: {exc.message}\n"
            "Cần bản native đã cài (maturin develop --release trong native/)."
        ) from exc

    corpus = load_corpus(corpus_path)
    selected = [
        case
        for case in corpus["cases"]
        if case_ids is None or case["id"] in case_ids
    ]
    if not selected:
        raise SystemExit(f"Không có ca nào khớp: {case_ids}")

    report: dict[str, Any] = {
        "corpusVersion": corpus["corpusVersion"],
        "engineVersion": capabilities.engine_version,
        "protocolVersion": capabilities.protocol_version,
        "baselineDisclaimer": BASELINE_DISCLAIMER,
        "machine": describe_machine(selected[0]["request"]),
        "cases": [],
    }

    for case in selected:
        request = case["request"]
        entry: dict[str, Any] = {
            "id": case["id"],
            "title": case["title"],
            "expect": case.get("expect", {}),
            "freeAngle": [],
            "cardinalBaseline": None,
            "deadline": None,
        }
        for profile in profiles:
            entry["freeAngle"].append(
                run_case(request, profile=profile, runs=runs, time_budget_ms=None)
            )

        # Sàn an toàn: cùng hình học, chỉ thu hẹp về bốn góc cardinal.
        baseline_request = cardinal_baseline_request(request)
        try:
            entry["cardinalBaseline"] = run_case(
                baseline_request, profile=profiles[-1], runs=1, time_budget_ms=None
            )
        except Exception as exc:  # noqa: BLE001 - baseline có thể vô nghiệm, đó là dữ liệu
            entry["cardinalBaseline"] = {"error": str(exc)}

        if deadline_ms is not None:
            entry["deadline"] = run_case(
                request, profile="tight", runs=1, time_budget_ms=deadline_ms
            )

        report["cases"].append(entry)

    return report


# ─────────────────────────────────────────────────────────────────────────────
#  In báo cáo
# ─────────────────────────────────────────────────────────────────────────────


def print_report(report: dict[str, Any]) -> None:
    machine = report["machine"]
    print("=" * 78)
    print("BENCHMARK BINH LONG GHEP TU DO")
    print("=" * 78)
    print(f"  engine       : {report['engineVersion']} (protocol {report['protocolVersion']})")
    print(f"  corpus       : v{report['corpusVersion']}")
    print(f"  may          : {machine['platform']}, python {machine['python']}, "
          f"{machine['cpuCount']} loi")
    print(f"  RAM          : {machine['ramTotalMb']} MB tong, tier {machine['ramTier']}")
    print(f"  worker       : {machine['workers']} (planner: {machine['plannerReason']})")
    print(f"  LUU Y        : {report['baselineDisclaimer']}")
    print()

    header = (
        f"{'ca':<16}{'profile':<10}{'mode':<18}{'p50 ms':>9}{'p95 ms':>9}"
        f"{'to':>4}{'dat':>5}{'thieu':>6}{'util':>8}{'goc-le':>8}{'xy-le':>7}{'det':>5}"
    )
    print(header)
    print("-" * len(header))
    for case in report["cases"]:
        for row in case["freeAngle"]:
            util = row["recomputedUtilization"]
            print(
                f"{case['id']:<16}{row['profile']:<10}{row['mode']:<18}"
                f"{row['p50Ms']:>9.1f}{row['p95Ms']:>9.1f}"
                f"{(row['sheetCount'] or 0):>4}{(row['placedCount'] or 0):>5}"
                f"{(row['unplacedCount'] or 0):>6}"
                f"{(f'{util:.4f}' if util is not None else '-'):>8}"
                f"{row['nonCardinalAngleCount']:>8}{row['fractionalTranslationCount']:>7}"
                f"{('y' if row['deterministic'] else 'n'):>5}"
            )
        baseline = case.get("cardinalBaseline") or {}
        if "error" in baseline:
            print(f"{case['id']:<16}{'baseline':<10}{'cardinal (san an toan)':<18}  LOI: {baseline['error'][:40]}")
        else:
            print(
                f"{case['id']:<16}{'baseline':<10}{'cardinal(san)':<18}"
                f"{baseline.get('p50Ms', 0):>9.1f}{baseline.get('p95Ms', 0):>9.1f}"
                f"{(baseline.get('sheetCount') or 0):>4}{(baseline.get('placedCount') or 0):>5}"
                f"{(baseline.get('unplacedCount') or 0):>6}"
            )
        deadline = case.get("deadline")
        if deadline:
            print(
                f"{case['id']:<16}{'tight':<10}{'deadline':<18}"
                f"{deadline['p50Ms']:>9.1f}{deadline['p95Ms']:>9.1f}"
                f"{(deadline['sheetCount'] or 0):>4}{(deadline['placedCount'] or 0):>5}"
                f"{(deadline['unplacedCount'] or 0):>6}"
                f"   reason={deadline['terminationReason']}"
            )
        print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", dest="cases", help="Mã ca (lặp được)")
    parser.add_argument(
        "--profiles",
        default="fast,balanced",
        help="Danh sách profile, phân tách bằng dấu phẩy (mặc định: fast,balanced)",
    )
    parser.add_argument("--runs", type=int, default=3, help="Số lần chạy mỗi cấu hình")
    parser.add_argument(
        "--deadline-ms",
        type=int,
        default=None,
        help="Chạy thêm chế độ deadline với ngân sách này (ms)",
    )
    parser.add_argument("--json", dest="json_path", default=None, help="Ghi report JSON")
    args = parser.parse_args(argv)

    profiles = [name.strip() for name in args.profiles.split(",") if name.strip()]
    unknown = [name for name in profiles if name not in PROFILES]
    if unknown:
        raise SystemExit(f"Profile không hợp lệ: {unknown}. Chỉ có {list(PROFILES)}.")

    report = benchmark(
        case_ids=args.cases,
        profiles=profiles,
        runs=args.runs,
        deadline_ms=args.deadline_ms,
    )
    print_report(report)

    if args.json_path:
        Path(args.json_path).write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"Da ghi report: {args.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Trace JSONL chẩn đoán preview → export của true-shape nesting.

File này cố ý chỉ ghi metadata hình học và identity đã băm. Không ghi
payload PDF, license/HWID, đường dẫn nguồn hay nội dung report của khách.

Mỗi event được serialize trước rồi append bằng đúng một ``os.write``. Preview
và export chạy khác process nên mỗi dòng luôn mang timestamp, PID và thread.
Trace là best-effort: lỗi ghi file tuyệt đối không được làm hỏng lượt bình.
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib
import json
import logging
import math
import os
import re
import threading
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

logger = logging.getLogger(__name__)

TRACE_PATH_ENV = "PRYNX_NESTING_TRACE_PATH"
TRACE_ENABLED_ENV = "PRYNX_NESTING_TRACE_ENABLED"
MAX_TRACE_BYTES = 8 * 1024 * 1024
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.:@-]+")
_NATIVE_RUNTIME_CACHE_LOCK = threading.Lock()
_NATIVE_RUNTIME_CACHE: tuple[tuple[str, int, int], str] | None = None


def nesting_trace_path() -> Path:
    """Vị trí trace có thể mở trực tiếp trên máy người dùng."""

    override = str(os.environ.get(TRACE_PATH_ENV) or "").strip()
    if override:
        return Path(override)
    appdata = str(os.environ.get("APPDATA") or "").strip()
    root = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    return root / "PrynX" / "logs" / "nesting_trace.jsonl"


def sanitize_trace_id(value: Any, *, limit: int = 96) -> str | None:
    """Giữ ID đủ để đối chiếu, bỏ ký tự có thể phá dòng log."""

    if not isinstance(value, str):
        return None
    cleaned = _SAFE_ID.sub("_", value.strip())[:limit]
    return cleaned or None


def nesting_trace_enabled() -> bool:
    """Tự bật khi chạy dev; release tắt trừ khi operator opt-in.

    Lô chẩn đoán này cần người dùng chỉ restart ``run_dev`` và bấm
    Bình, không phải cấu hình shell. Release không được ghi telemetry cục bộ
    thường trực; muốn chẩn đoán installer thì bật env tường minh.
    """

    explicit = os.environ.get(TRACE_ENABLED_ENV)
    if explicit is not None:
        return str(explicit).strip().lower() in {"1", "true", "on", "yes"}
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    try:
        from app.config import settings

        return bool(settings.DEV_MODE)
    except Exception:
        return False


def _json_default(value: Any) -> str:
    # Không ``repr(value)``: object lạ có thể mang đường dẫn hoặc payload nhạy cảm.
    return f"<unsupported:{type(value).__name__}>"


def trace_nesting_event(
    event: str,
    *,
    trace_id: Any = None,
    request_id: Any = None,
    job_id: Any = None,
    **details: Any,
) -> Path:
    """Append một event JSONL; luôn fail-soft và trả về vị trí dự kiến."""

    path = nesting_trace_path()
    if not nesting_trace_enabled():
        return path
    try:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "event": sanitize_trace_id(event, limit=64) or "unknown",
            "pid": os.getpid(),
            "thread": threading.current_thread().name[:64],
            "traceId": sanitize_trace_id(trace_id),
            "requestId": sanitize_trace_id(request_id),
            "jobId": sanitize_trace_id(job_id),
        }
        payload.update(details)
        encoded = (
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=_json_default,
            )
            + "\n"
        ).encode("utf-8")
        path.parent.mkdir(parents=True, exist_ok=True)
        # Giới hạn fail-soft: khi trace đã đủ 8 MiB thì ngừng append. Không
        # rotate/xóa tự động vì preview và export là hai process có thể race.
        try:
            if path.stat().st_size >= MAX_TRACE_BYTES:
                return path
        except FileNotFoundError:
            pass
        flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY | getattr(os, "O_BINARY", 0)
        fd = os.open(str(path), flags, 0o600)
        try:
            # PERF (audit 2026-08-29 §NEST-TRACE-1): một event = một append,
            # không log trong hot loop của solver.
            os.write(fd, encoded)
        finally:
            os.close(fd)
    except Exception:
        logger.debug("Không ghi được nesting trace.", exc_info=True)
    return path


def job_identity_digest(job: Any) -> str | None:
    """Băm session identity, không để lộ path nằm trong identity gốc."""

    try:
        from app.core.nesting_preview_session import job_identity_key

        raw = repr(job_identity_key(job)).encode("utf-8", errors="replace")
        return "sha256:" + hashlib.sha256(raw).hexdigest()
    except Exception:
        logger.debug("Không băm được nesting session identity.", exc_info=True)
        return None


def production_identity_summary(production: Any) -> dict[str, Any]:
    """Tóm tắt identity authoritative mà không ghi request/hình học nguồn.

    PERF (audit 2026-08-30 §NEST-D0-A): các hash này cho phép đối chiếu chính xác
    preview → handoff → export. Chỉ băm ``engine_request`` canonical; tuyệt đối
    không ghi payload request, RenderBundle, contour hoặc locator nguồn vào trace.
    """

    try:
        from app.core.nesting_production_adapter import canonical_sha256

        return {
            "canonicalEngineRequestHash": canonical_sha256(
                getattr(production, "engine_request")
            ),
            "inputHash": getattr(production, "input_hash"),
            "solverConfigHash": getattr(production, "solver_config_hash"),
            "geometryConstraintsHash": getattr(
                production, "geometry_constraints_hash"
            ),
            "renderBundleHash": getattr(production, "render_bundle_hash"),
            "layoutFingerprint": getattr(production, "layout_fingerprint"),
            "nativeBuildIdentity": getattr(production, "native_build_identity"),
        }
    except Exception:
        logger.debug("Không tóm tắt được identity production nesting.", exc_info=True)
        return {}


def native_runtime_summary() -> dict[str, Any]:
    """SHA-256 binary native đang chạy; không bao giờ trả đường dẫn binary.

    Cache theo ``(resolved path, size, mtime_ns)`` để mỗi event không đọc lại
    toàn bộ ``.pyd``. Path chỉ là khoá nội bộ và không đi vào JSONL.
    """

    global _NATIVE_RUNTIME_CACHE
    try:
        native_module = importlib.import_module(
            "pdfcompare_native.pdfcompare_native"
        )
        raw_path = getattr(native_module, "__file__", None)
        if not isinstance(raw_path, str) or not raw_path:
            raise RuntimeError("Native runtime không có __file__.")
        path = Path(raw_path).resolve(strict=True)
        stat = path.stat()
        cache_key = (os.fspath(path), int(stat.st_size), int(stat.st_mtime_ns))
        with _NATIVE_RUNTIME_CACHE_LOCK:
            cached = _NATIVE_RUNTIME_CACHE
            if cached is not None and cached[0] == cache_key:
                return {"nativePydSha256": cached[1]}

        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        value = "sha256:" + digest.hexdigest()
        with _NATIVE_RUNTIME_CACHE_LOCK:
            _NATIVE_RUNTIME_CACHE = (cache_key, value)
        return {"nativePydSha256": value}
    except Exception as exc:
        logger.debug("Không băm được native runtime nesting.", exc_info=True)
        return {"nativePydSha256": None, "nativeRuntimeErrorType": type(exc).__name__}


def _finite_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else round(number, 6)


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if dataclasses.is_dataclass(value):
        converted = dataclasses.asdict(value)
        return converted if isinstance(converted, Mapping) else None
    return None


def summarize_pont_config(value: Any) -> dict[str, Any] | None:
    """Tóm tắt hình học ốc; chỉ whitelist field không nhạy cảm."""

    raw = _as_mapping(value)
    if raw is None:
        return None
    summary: dict[str, Any] = {
        "shape": raw.get("shape"),
        "sizeMm": _finite_number(raw.get("size", raw.get("size_mm"))),
        "thicknessMm": _finite_number(
            raw.get("thickness", raw.get("thickness_mm"))
        ),
        "disableCollision": bool(
            raw.get("disableCollision", raw.get("disable_collision", False))
        ),
    }
    for side in ("Top", "Bottom", "Left", "Right"):
        camel = f"margin{side}"
        snake = f"margin_{side.lower()}_mm"
        summary[camel + "Mm"] = _finite_number(raw.get(camel, raw.get(snake)))

    guides: list[dict[str, Any]] = []
    nested_guides = raw.get("guides")
    if isinstance(nested_guides, (list, tuple)):
        for item in nested_guides:
            guide = _as_mapping(item)
            if guide is not None:
                guides.append({"position": guide.get("position")})
    else:
        for index in (1, 2):
            if bool(raw.get(f"guide{index}Enabled", False)):
                guides.append({"position": raw.get(f"guide{index}Pos")})
    summary["guides"] = guides
    return summary


def summarize_finishing_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """Tóm tắt ốc/CUT/report mà không ghi nội dung đơn hàng."""

    display = settings.get("reportDisplay")
    report: dict[str, Any] = {"enabled": False}
    if isinstance(display, Mapping):
        order = display.get("fieldOrder")
        report = {
            "enabled": bool(display.get("enabled", False)),
            "placement": display.get("placement"),
            "fieldCount": len(order) if isinstance(order, (list, tuple)) else 0,
        }
    return {
        "align": settings.get("align"),
        "pont": {
            "type": settings.get("pontType"),
            "config": summarize_pont_config(settings.get("pontConfig")),
        },
        "cut": {
            "type": settings.get("cutType"),
            "separatePage": settings.get("separateCutPage"),
            "pontsOnCutFile": settings.get("pontsOnCutFile"),
            "fillBlockGapMm": _finite_number(settings.get("fillBlockGap")),
            "dieSizeMode": settings.get("dieSizeMode"),
            "dieOffsetMm": _finite_number(settings.get("dieOffsetMm")),
        },
        "artifact": {
            "exportUniqueSheets": settings.get("exportUniqueSheets"),
            "report": report,
        },
    }


def summarize_quantities(value: Any) -> dict[str, int]:
    """Chỉ ghi kích thước/tổng; không dump map quantity có thể rất lớn."""

    if not isinstance(value, Mapping):
        return {"pageCount": 0, "nonZeroPageCount": 0, "total": 0}
    page_count = 0
    non_zero = 0
    total = 0
    for raw in value.values():
        page_count += 1
        try:
            quantity = int(raw)
        except (TypeError, ValueError):
            continue
        if quantity > 0:
            non_zero += 1
            total += quantity
    return {
        "pageCount": page_count,
        "nonZeroPageCount": non_zero,
        "total": total,
    }


def rotation_histogram(
    manifest: Mapping[str, Any], *, sheet_index: int | None = None
) -> dict[str, int]:
    """Histogram góc pose; key là độ canonical để JSON dễ đọc."""

    counts: Counter[str] = Counter()
    for placement in manifest.get("placements") or ():
        if not isinstance(placement, Mapping):
            continue
        if sheet_index is not None and int(placement.get("sheetIndex") or 0) != sheet_index:
            continue
        pose = placement.get("pose") or {}
        if not isinstance(pose, Mapping):
            continue
        angle = _finite_number(pose.get("rotationDeg"))
        if angle is None:
            continue
        canonical = float(angle) % 360.0
        if abs(canonical - 360.0) < 1e-9 or abs(canonical) < 1e-9:
            canonical = 0.0
        key = (
            str(int(canonical))
            if canonical.is_integer()
            else f"{canonical:.3f}".rstrip("0").rstrip(".")
        )
        counts[key] += 1
    return dict(sorted(counts.items(), key=lambda item: float(item[0])))


def manifest_trace_summary(
    manifest: Mapping[str, Any], *, layout_fingerprint: Any = None
) -> dict[str, Any]:
    """Identity, sức chứa và telemetry solver cần cho đối chiếu."""

    stats = manifest.get("stats") or {}
    search = manifest.get("search") or {}
    validation = manifest.get("validation") or {}
    provenance = manifest.get("provenance") or {}
    selected = search.get("selectedCandidate") if isinstance(search, Mapping) else None
    if isinstance(selected, Mapping):
        selected = selected.get("kind") or dict(selected)
    fingerprint = layout_fingerprint or manifest.get("layoutFingerprint")
    return {
        "manifestId": manifest.get("manifestId"),
        "layoutFingerprint": fingerprint,
        "capacity": int(stats.get("placedCount") or 0),
        "sheetCount": int(stats.get("sheetCount") or 0),
        "selectedCandidate": selected,
        "trialsRun": int(search.get("trialsRun") or 0)
        if isinstance(search, Mapping)
        else 0,
        "trialsRejected": int(search.get("trialsRejected") or 0)
        if isinstance(search, Mapping)
        else 0,
        "searchBudget": _trace_number_fields(
            search.get("budget") if isinstance(search, Mapping) else None,
            (
                "trialCount",
                "orientationProposalsPerPart",
                "beamWidth",
                "refinementRounds",
                "multiStartRestarts",
                "evaluationBudget",
                "timeBudgetMs",
            ),
        ),
        "baselineScore": _trace_number_fields(
            search.get("baselineScore") if isinstance(search, Mapping) else None,
            (
                "invalidCount",
                "primaryPenalty",
                "sheetCount",
                "lastSheetUsedAreaFixed",
                "wastedWithinEnvelopeFixed",
                "scoreVersion",
            ),
        ),
        "selectedScore": _trace_number_fields(
            search.get("selectedScore") if isinstance(search, Mapping) else None,
            (
                "invalidCount",
                "primaryPenalty",
                "sheetCount",
                "lastSheetUsedAreaFixed",
                "wastedWithinEnvelopeFixed",
                "scoreVersion",
            ),
        ),
        "termination": stats.get("terminationReason"),
        "elapsedMs": _finite_number(stats.get("elapsedMs")),
        "attempts": _finite_number(stats.get("attempts")),
        "orientationEvaluations": _finite_number(
            stats.get("orientationEvaluations")
        ),
        "poseRefinements": _finite_number(stats.get("poseRefinements")),
        "validationValid": (
            validation.get("valid") if isinstance(validation, Mapping) else None
        ),
        "manifestNativeBuildIdentity": (
            provenance.get("nativeBuildIdentity")
            if isinstance(provenance, Mapping)
            else None
        ),
        "rotationHistogram": rotation_histogram(manifest),
        "sheet0RotationHistogram": rotation_histogram(manifest, sheet_index=0),
    }


def _trace_number_fields(value: Any, fields: Iterable[str]) -> dict[str, Any] | None:
    """Whitelist các counter/score số; không dump mapping native nguyên khối."""

    raw = _as_mapping(value)
    if raw is None:
        return None
    return {field: _finite_number(raw.get(field)) for field in fields}


_NFP_DIAGNOSTIC_FIELDS = (
    "feasibleRegionCalls",
    "interruptedCalls",
    "blockersConsidered",
    "bboxRejects",
    "blockerRingsGenerated",
    "cacheHits",
    "cacheMisses",
    "cacheEntriesBuilt",
    "cacheInsertSkipped",
    "cachePeakEstimatedBytes",
    "nfpBuildTimeUs",
    "differenceCalls",
    "differenceTimeUs",
    # PERF (audit 2026-08-30 §NEST-NFP-P1): đo mức song song thực tế của
    # cold-miss batch, không suy từ worker grant danh nghĩa.
    "prewarmBatches",
    "prewarmTasks",
    "prewarmPeakWorkers",
    "prewarmWallTimeUs",
)


def nfp_diagnostics_summary(value: Any) -> dict[str, dict[str, int | float | None]] | None:
    """Whitelist counter NFP theo phase để ghi vào trace dễ đọc.

    PERF (audit 2026-08-30 §NEST-D0-D): trace chỉ nhận số aggregate do native trả;
    không dump contour, key cache hay payload hình học. Field lạ bị bỏ qua để log
    vẫn tương thích khi native được nâng version.
    """

    raw = _as_mapping(value)
    if raw is None:
        return None
    result: dict[str, dict[str, int | float | None]] = {}
    for phase in ("baseline", "search"):
        phase_raw = _as_mapping(raw.get(phase))
        if phase_raw is None:
            continue
        result[phase] = {
            field: _finite_number(phase_raw.get(field))
            for field in _NFP_DIAGNOSTIC_FIELDS
        }
    return result or None


def contour_envelope_summary(
    rings: Iterable[Iterable[Iterable[Any]]],
    *,
    sheet_width_mm: float,
    sheet_height_mm: float,
    margins_mm: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Bao contour thật tờ 0 và khoảng trống tới bốn cạnh vùng in."""

    points: list[tuple[float, float]] = []
    for ring in rings:
        for point in ring:
            try:
                x, y = float(point[0]), float(point[1])
            except (IndexError, TypeError, ValueError):
                continue
            if math.isfinite(x) and math.isfinite(y):
                points.append((x, y))
    if not points:
        return None

    min_x = min(point[0] for point in points)
    max_x = max(point[0] for point in points)
    min_y = min(point[1] for point in points)
    max_y = max(point[1] for point in points)
    left = float(margins_mm.get("left") or 0.0)
    right = float(sheet_width_mm) - float(margins_mm.get("right") or 0.0)
    bottom = float(margins_mm.get("bottom") or 0.0)
    top = float(sheet_height_mm) - float(margins_mm.get("top") or 0.0)

    def rounded(value: float) -> float:
        return round(value, 6)

    return {
        "contourEnvelopeMm": {
            "minX": rounded(min_x),
            "minY": rounded(min_y),
            "maxX": rounded(max_x),
            "maxY": rounded(max_y),
            "width": rounded(max_x - min_x),
            "height": rounded(max_y - min_y),
        },
        "usableEnvelopeMm": {
            "minX": rounded(left),
            "minY": rounded(bottom),
            "maxX": rounded(right),
            "maxY": rounded(top),
        },
        "freeSpaceMm": {
            "left": rounded(min_x - left),
            "right": rounded(right - max_x),
            "bottom": rounded(min_y - bottom),
            "top": rounded(top - max_y),
        },
        "shiftToCenterMm": {
            "x": rounded(((left + right) - (min_x + max_x)) / 2.0),
            "y": rounded(((bottom + top) - (min_y + max_y)) / 2.0),
        },
    }

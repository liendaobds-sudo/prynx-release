"""Các đoạn blocking của detect-shape, chạy ngoài event loop và qua scheduler."""

from __future__ import annotations

import base64
import os
import zlib
from contextlib import asynccontextmanager
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.core.heavy_job_scheduler import run_scheduled_in_threadpool


@asynccontextmanager
async def canonical_detection_path(source_path: str):
    """Enter/exit canonical_page_space ngoài event loop và luôn dọn file tạm."""
    from app.workers.nup_engine import canonical_page_space

    manager = canonical_page_space(source_path)
    canonical_path = await run_in_threadpool(manager.__enter__)
    try:
        yield canonical_path
    finally:
        await run_in_threadpool(manager.__exit__, None, None, None)


def raster_fallback_budget(
    shapes,
    statuses,
    *,
    max_tries=None,
    fail_streak_stop: int = 2,
) -> dict:
    """Chọn số trang cần raster fallback, giữ nguyên contract/budget hiện có."""
    if max_tries is None:
        try:
            max_tries = int((os.environ.get("PRYNX_DETECT_RASTER_MAX") or "3").strip())
        except ValueError:
            max_tries = 3
    max_tries = max(0, min(max_tries, 50))

    candidates: list[int] = []
    vector_ok = 0
    for index, shape in enumerate(shapes):
        source = getattr(shape, "source", None) or ""
        status = statuses[index] if index < len(statuses) else None
        ok = bool(getattr(status, "ok", True)) if status is not None else True
        if source in ("vector", "separation", "xobject"):
            vector_ok += 1
            continue
        if source == "custom" and ok:
            candidates.append(index)

    if not candidates or max_tries == 0:
        return {
            "indices": [],
            "max_tries": 0,
            "fail_streak_stop": fail_streak_stop,
            "reason": "none_or_disabled",
            "vector_ok": vector_ok,
            "custom_n": len(candidates),
        }

    if vector_ok >= 1:
        budget = min(1, max_tries, len(candidates))
        reason = "probe_only_has_vector_master"
    else:
        budget = min(max_tries, len(candidates))
        reason = "all_custom_capped"

    return {
        "indices": candidates[:budget] if budget else [],
        "max_tries": budget,
        "fail_streak_stop": fail_streak_stop,
        "reason": reason,
        "vector_ok": vector_ok,
        "custom_n": len(candidates),
        "all_custom_indices": candidates,
    }


def _run_vector_detection_sync(
    file_path: str,
    config: Any,
    timer_start: float,
    filename: str,
    perf_log,
    perf_mark,
):
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.die_detection import (
        apply_master_die_inheritance,
        detect_die_shapes,
    )

    document = pdf_lib.open(file_path)
    perf_mark(
        "DETECT",
        "open_doc",
        timer_start,
        file=filename,
        pages=getattr(document, "page_count", "?"),
    )
    try:
        result = detect_die_shapes(document, config)
        source_counts: dict[str, int] = {}
        for shape in result.shapes:
            source_counts[shape.source] = source_counts.get(shape.source, 0) + 1
        perf_mark(
            "DETECT",
            "vector_done",
            timer_start,
            pages=result.total_pages,
            sources=str(source_counts),
        )

        before_custom = sum(1 for shape in result.shapes if shape.type.name == "CUSTOM")
        result = apply_master_die_inheritance(result)
        after_custom = sum(1 for shape in result.shapes if shape.type.name == "CUSTOM")
        if after_custom != before_custom:
            source_counts = {}
            for shape in result.shapes:
                source_counts[shape.source] = source_counts.get(shape.source, 0) + 1
            perf_log(
                "DETECT",
                "master_inherit",
                before_custom=before_custom,
                after_custom=after_custom,
                sources=str(source_counts),
            )

        budget = raster_fallback_budget(result.shapes, result.statuses)
        perf_log(
            "DETECT",
            "raster_budget",
            reason=budget.get("reason"),
            max_tries=budget.get("max_tries"),
            vector_ok=budget.get("vector_ok"),
            custom_n=budget.get("custom_n"),
        )
        return result, budget, source_counts
    finally:
        try:
            document.close()
        except Exception:
            pass


async def run_vector_detection(
    file_path: str,
    config: Any,
    timer_start: float,
    filename: str,
    perf_log,
    perf_mark,
):
    """Parse/vector detection trong worker thread có admission control."""
    return await run_scheduled_in_threadpool(
        "pdf-tools",
        _run_vector_detection_sync,
        file_path,
        config,
        timer_start,
        filename,
        perf_log,
        perf_mark,
    )


def _classify_raster_separations_sync(
    separation_result: dict,
    page_index: int,
    config: Any,
    detect_logger,
):
    import cv2
    import numpy as np

    from app.workers.die_detection import _match_die_channel, build_shape_from_raster

    plates = [
        plate
        for plate in separation_result.get("plates", [])
        if plate["name"] not in ("Cyan", "Magenta", "Yellow", "Black")
    ]
    if not plates:
        return None, ""

    names = frozenset(name.strip().lower() for name in (config.die_channel_names or ()))
    plates.sort(
        key=lambda plate: 0
        if _match_die_channel(plate.get("name"), names)
        else 1
    )

    for plate in plates:
        try:
            raw_bytes = zlib.decompress(base64.b64decode(plate["alpha_data"]))
            height = separation_result["height"]
            width = separation_result["width"]
            mask = np.frombuffer(raw_bytes, dtype=np.uint8).reshape((height, width))
            contours, _ = cv2.findContours(
                mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            if contours:
                solid = np.zeros_like(mask)
                cv2.drawContours(solid, contours, -1, 255, cv2.FILLED)
                mask = solid
            ys, xs = np.where(mask > 0)
            if len(ys) == 0:
                continue
            dpi = config.raster_fallback_dpi
            spot_width = float((xs.max() - xs.min()) * 72.0 / dpi)
            spot_height = float((ys.max() - ys.min()) * 72.0 / dpi)
            return (
                build_shape_from_raster(
                    page_index, mask, spot_width, spot_height
                ),
                str(plate.get("name", "")),
            )
        except Exception as exc:  # noqa: BLE001
            detect_logger.warning(
                "Raster classify page %s failed: %s", page_index + 1, exc
            )
    return None, ""


async def classify_raster_separations(
    separation_result: dict,
    page_index: int,
    config: Any,
    detect_logger,
):
    """Decompress/OpenCV raster mask ngoài event loop."""
    return await run_scheduled_in_threadpool(
        "pdf-tools",
        _classify_raster_separations_sync,
        separation_result,
        page_index,
        config,
        detect_logger,
    )

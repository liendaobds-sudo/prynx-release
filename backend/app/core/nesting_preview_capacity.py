"""Preview cho "Nesting tối ưu theo đường bế" — số và hình đến từ CHÍNH manifest.

FIX (audit 2026-08-28 §NEST-PREVIEW-1). Chủ dự án báo: "preview không đúng như kết quả
chạy" — preview hiện 41 tem/tờ, engine thật cho 46, và layout khác hẳn.

## Lỗi gốc

`POST /imposition/preview-layout` nhận `strategy` nguyên văn rồi đưa xuống
`sticker_imposer_pkg/orchestrator.py`. Ở đó dispatch chỉ biết `optimal_auto`,
`head_to_tail`, `staggered`; mọi giá trị khác rơi vào ``else: # grid`` (orchestrator.py:460)
⇒ `true_shape_nesting` được tính bằng **lưới chữ nhật thuần**, còn yếu hơn `optimal_auto`.
Không có log, không có lỗi — chỉ là một con số khác.

Trong khi đó export đi `nup_engine.py:283` → `run_true_shape_nesting` → kernel Rust. Hai
engine khác nhau thì không có cách nào khớp.

## Cách sửa

Module này dựng preview từ **cùng một phiên nesting** mà export dùng:

1. Dịch `PreviewLayoutRequest` (snake_case, point) → `settings` (camelCase, mm).
2. `get_or_solve` trên kho phiên dùng chung. Đây là chỗ đóng luôn một lỗ thứ hai:
   `attach_preview_session_reference` (route, lúc launch job) chỉ `peek()`, nên trước bản vá
   nó **luôn** no-op vì chưa ai tạo phiên. Giờ preview tạo phiên ⇒ export nạp lại đúng
   manifest đó và render, không solve lần hai.
3. Dựng `cells` bằng **chính seam của writer** (`resolve_manifest_artwork_placement` +
   `transform_manifest_polygon_rings`). Không có đường thứ hai nào đọc pose, nên hình
   preview không thể lệch hình xuất.

## Hai hệ toạ độ, đổi đúng một lần

- Manifest: mm, gốc góc **trái dưới** tờ, Y hướng **lên**.
- `cell.diePolylines`: point, toạ độ trang đích **TOP-DOWN** — hợp đồng của
  `nup_artwork.die_polylines_for_placement` mà frontend đã biết vẽ.
- `cell.absX/absY`: point, gốc trái dưới, Y **lên** (dùng với `absPlacement=True`).

Hai quy ước ngược nhau về Y là có thật trong hợp đồng sẵn có, nên `_to_top_down_pt` và
`_bbox_abs_pt` là hai hàm riêng, mỗi hàm đổi đúng một lần.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any, Callable, Mapping, Sequence

if TYPE_CHECKING:
    from app.workers.nup_artwork import ManifestPartContext

logger = logging.getLogger(__name__)

#: Point trên milimét. Cùng giá trị với `imposition_pdf_form.PT_PER_MM`.
PT_PER_MM = 72.0 / 25.4


#: Số chữ số thập phân khi quy point về mm.
#:
#: FIX (audit 2026-08-28 §NEST-PREVIEW-1): **bắt buộc phải làm tròn.** Frontend gửi
#: `sheet_h = 430.0 * PT_PER_MM`, chia lại ra `429.99999999999994` — lệch một ULP. Mà
#: `job_identity_key` băm chính các số này, nên job của preview và job của export thành hai
#: khoá khác nhau ⇒ phiên **không bao giờ** được tái dùng ⇒ export solve lại và bất biến
#: preview ≡ output vỡ **im lặng**. Test `test_khoa_settings_khop_de_phien_tai_dung_duoc_voi_export`
#: là chỗ phát hiện ra điều này.
#:
#: 9 chữ số = độ phân giải nanomét, thấp hơn dung sai hình học của engine (`linear_mm`) ba
#: bậc, nên không đổi một quyết định hình học nào.
_MM_DECIMALS = 9


def _mm(value_pt: Any) -> float:
    try:
        return round(float(value_pt) / PT_PER_MM, _MM_DECIMALS)
    except (TypeError, ValueError):
        return 0.0


def settings_from_preview_request(req: Any) -> dict[str, Any]:
    """`PreviewLayoutRequest` → `settings` mà `build_true_shape_nesting_job` đọc.

    Preview gửi **point**, job dùng **mm**; preview dùng snake_case, job dùng camelCase.
    Chỉ dịch những khoá nesting thực sự đọc — thêm khoá lạ chỉ làm khác
    `job_identity_key` và phá việc tái dùng phiên với export.
    """

    quantities = {
        str(key): int(value)
        for key, value in (getattr(req, "target_quantities_by_page", None) or {}).items()
    }
    shapes = {
        str(key): value
        for key, value in (getattr(req, "detected_shapes_by_page", None) or {}).items()
    }
    shape_params = {
        str(key): value
        for key, value in (
            getattr(req, "detected_shape_params_by_page", None) or {}
        ).items()
    }
    return {
        "gridStrategy": "true_shape_nesting",
        "isDieCutMode": bool(getattr(req, "is_die_cut", False)),
        "imposerMode": getattr(req, "imposer_mode", None),
        # PARITY (audit 2026-08-29 §MAP-NEST-02): preview phải dựng cùng cặp
        # Front/Back và cùng cạnh lật với export; đây là field logic, không đổi đơn vị.
        "cncTwoSided": bool(getattr(req, "cnc_two_sided", False)),
        "cncFlipEdge": getattr(req, "cnc_flip_edge", None) or "long",
        # PARITY (audit 2026-09-05 §NEST26.1): dấu canh cũng là một phần identity
        # nesting vì chúng tạo 4 vật cản cố định trên tờ CNC hai mặt.
        "cncDuplexMarks": bool(getattr(req, "cnc_duplex_marks", False)),
        "taskMode": getattr(req, "task_mode", "nup"),
        "layoutType": getattr(req, "layout_type", None),
        # PARITY (audit 2026-08-29 MAP-NEST-04): preview/export phải giữ đúng
        # intent; `maximize_area` không được biến thành free gang vì mapper làm rơi field.
        "groupingStrategy": getattr(req, "grouping_strategy", None) or "maximize_area",
        "page_sheet_mode": bool(getattr(req, "page_sheet_mode", False)),
        "sheetWidth": _mm(getattr(req, "sheet_w", 0)),
        "sheetHeight": _mm(getattr(req, "sheet_h", 0)),
        "gapX": _mm(getattr(req, "gap_x", 0)),
        "gapY": _mm(getattr(req, "gap_y", 0)),
        # PARITY (audit 2026-08-30 §B10-6): cổng lưới và render export đều đọc bleed
        # theo mm; bỏ khoá này từng làm gate quyết trên hình học khác provisional.
        "bleed": _mm(getattr(req, "bleed", 0)),
        "marginLeft": _mm(getattr(req, "margin_left", 0)),
        "marginRight": _mm(getattr(req, "margin_right", 0)),
        "marginTop": _mm(getattr(req, "margin_top", 0)),
        "marginBottom": _mm(getattr(req, "margin_bottom", 0)),
        "align": getattr(req, "align", "center") or "center",
        # PARITY (audit 2026-08-29 §MAP-NEST-01): quantity chung là mặc định cho
        # mọi trang; override theo trang (kể cả 0) được merge tại một SSOT backend.
        "targetQuantity": int(getattr(req, "target_quantity", 0) or 0),
        "targetQuantitiesByPage": quantities,
        "detectedShapesByPage": shapes,
        "detectedShapeParamsByPage": shape_params,
        # PARITY (audit 2026-08-29 §NEST-PARITY-1): render bundle nằm trong session
        # identity. Thiếu chỉ một field CUT/report cũng làm export miss phiên preview và
        # solve lại. Giữ đúng tên camelCase mà `processHandlers` gửi cho export.
        "cutType": getattr(req, "cut_type", None) or "default",
        "fillBlockGap": getattr(req, "fill_block_gap", None) or 0,
        "dieSizeMode": getattr(req, "die_size_mode", None) or "die",
        "dieOffsetMm": getattr(req, "die_offset_mm", None) or 0,
        "separateCutPage": bool(getattr(req, "separate_cut_page", True)),
        "pontsOnCutFile": bool(getattr(req, "ponts_on_cut_file", True)),
        "exportUniqueSheets": bool(getattr(req, "export_unique_sheets", True)),
        "reportDisplay": getattr(req, "report_display", None),
        "reportMaterial": getattr(req, "report_material", None),
        "reportLamination": getattr(req, "report_lamination", None),
        "reportLaminationSides": getattr(req, "report_lamination_sides", None),
        "reportOrderCode": getattr(req, "report_order_code", None),
        # Ốc là vật cản của solver, nên cả loại lẫn config đều phải khớp export.
        **_pont_settings(
            getattr(req, "pont_type", None), getattr(req, "pont_config", None)
        ),
    }


def _pont_settings(pont_type: Any, pont_config: Any) -> dict[str, Any]:
    """Khoá ốc preview, giữ nguyên loại thật; client cũ mới suy ``custom``.

    FIX (audit 2026-08-29 §NEST-PARITY-1): trước đây mọi ốc bật đều bị đổi thành
    ``custom``. Export giữ ``5mm`` nên hai render spec khác nhau dù hình học config giống
    hệt, khiến handoff chắc chắn miss.
    """

    normalized_type = pont_type if pont_type in {"none", "corner", "5mm", "custom"} else None
    if normalized_type == "none":
        return {"pontType": "none"}
    if not isinstance(pont_config, Mapping) or not pont_config:
        return {"pontType": normalized_type or "none"}
    return {
        "pontType": normalized_type or "custom",
        "pontConfig": dict(pont_config),
    }


def _to_top_down_pt(
    point_mm: tuple[float, float], *, sheet_height_mm: float
) -> list[float]:
    """mm gốc trái-dưới → point trang đích TOP-DOWN. Hợp đồng của `diePolylines`."""

    return [
        float(point_mm[0]) * PT_PER_MM,
        (sheet_height_mm - float(point_mm[1])) * PT_PER_MM,
    ]


def _placed_rings_mm(
    placement: Mapping[str, Any],
    part: Mapping[str, Any] | ManifestPartContext,
    *,
    sheet_frame: Any,
    render_bundle_hash: str,
) -> list[list[list[float]]]:
    """Đường bế đã áp pose, mm gốc trái-dưới.

    Dùng **đúng** hai hàm mà writer dùng cho trang CUT. Đó là điều làm preview và output
    không thể có hai hình khác nhau: chỉ có MỘT đường đọc pose.
    """

    from app.workers.nup_artwork import (
        ManifestPartContext,
        resolve_manifest_artwork_placement,
    )
    from app.workers.nup_clip_shape import transform_manifest_polygon_rings

    resolved = resolve_manifest_artwork_placement(
        placement=placement,
        part=part,
        sheet_frame=sheet_frame,
        side="cut",
        render_bundle_hash=render_bundle_hash,
    )
    return transform_manifest_polygon_rings(
        part.cut_contour if isinstance(part, ManifestPartContext) else part["cutContour"],
        sheet_frame=resolved.sheet_frame,
        pose=resolved.pose,
        reference_point_mm=resolved.reference_point_mm,
        field="cutContour",
    )


def _bbox_abs_pt(rings: list[list[list[float]]]) -> tuple[float, float, float, float]:
    """Bbox theo point, gốc trái-dưới, Y hướng lên — hợp đồng của `absX/absY/width/height`."""

    xs = [float(point[0]) for ring in rings for point in ring]
    ys = [float(point[1]) for ring in rings for point in ring]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return (
        min_x * PT_PER_MM,
        min_y * PT_PER_MM,
        (max_x - min_x) * PT_PER_MM,
        (max_y - min_y) * PT_PER_MM,
    )


def build_nesting_preview(
    req: Any,
    *,
    source_path: str,
    job_id: str | None = None,
    cancel_event: Any = None,
    progress_callback: Callable[[Mapping[str, Any]], None] | None = None,
    subscriber_id: str | None = None,
    legacy_preview_for_page: Callable[[int], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Kết quả preview cho nhánh nesting, đúng khuôn `BackendLayoutResult` của frontend.

    Ném `ValueError` khi thiết lập không chạy được nesting — route đổi thành 422. Cố ý
    **không** fail-soft về lưới: người dùng chọn một cách xếp cụ thể, trả cho họ số của
    cách xếp khác chính là lỗi đang phải sửa.
    """

    from app.core.nesting_preview_session import (
        get_preview_session_store,
        session_capacity,
        session_sheet_count,
    )
    from app.core.nesting_debug_trace import (
        contour_envelope_summary,
        job_identity_digest,
        manifest_trace_summary,
        native_runtime_summary,
        nfp_diagnostics_summary,
        nesting_trace_enabled,
        production_identity_summary,
        summarize_finishing_settings,
        summarize_pont_config,
        summarize_quantities,
        trace_nesting_event,
    )
    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    def _raise_if_cancelled() -> None:
        checker = getattr(cancel_event, "is_set", None)
        if cancel_event is not None and (
            bool(checker()) if callable(checker) else bool(cancel_event)
        ):
            raise InterruptedError("Đã hủy preview nesting.")

    _raise_if_cancelled()
    trace_id = getattr(req, "diagnostic_trace_id", None)
    request_id = getattr(req, "diagnostic_request_id", None)
    trace_enabled = nesting_trace_enabled()
    started = time.perf_counter()
    settings = settings_from_preview_request(req)
    # PARITY (audit 2026-08-31 §NEST-PREVIEW-INTENT): bit transport này chỉ
    # điều khiển policy publication, không được đưa vào settings/job identity.
    allow_legacy_fallback = bool(
        getattr(req, "allow_legacy_fallback", False)
    )
    if trace_enabled:
        requested_finishing = {
            "align": getattr(req, "align", None),
            "pontType": getattr(req, "pont_type", None),
            "pontConfig": getattr(req, "pont_config", None),
            "cutType": getattr(req, "cut_type", None),
            "fillBlockGap": getattr(req, "fill_block_gap", None),
            "dieSizeMode": getattr(req, "die_size_mode", None),
            "dieOffsetMm": getattr(req, "die_offset_mm", None),
            "separateCutPage": getattr(req, "separate_cut_page", None),
            "pontsOnCutFile": getattr(req, "ponts_on_cut_file", None),
            "exportUniqueSheets": getattr(req, "export_unique_sheets", None),
            "reportDisplay": getattr(req, "report_display", None),
            "reportMaterial": getattr(req, "report_material", None),
            "reportLamination": getattr(req, "report_lamination", None),
            "reportLaminationSides": getattr(
                req, "report_lamination_sides", None
            ),
            "reportOrderCode": getattr(req, "report_order_code", None),
        }
        trace_nesting_event(
            "preview.request",
            trace_id=trace_id,
            request_id=request_id,
            requestedAlign=getattr(req, "align", None),
            pont={
                "rawTypeAvailable": bool(getattr(req, "pont_type", None)),
                "rawType": getattr(req, "pont_type", None),
                "enabledByConfig": bool(getattr(req, "pont_config", None)),
                "rawConfig": summarize_pont_config(getattr(req, "pont_config", None)),
                "effectiveType": settings.get("pontType"),
                "effectiveConfig": summarize_pont_config(settings.get("pontConfig")),
            },
            requestedFinishing=summarize_finishing_settings(requested_finishing),
            effectiveFinishing=summarize_finishing_settings(settings),
            quantities=summarize_quantities(
                settings.get("targetQuantitiesByPage")
            ),
            sheetMm={
                "width": settings.get("sheetWidth"),
                "height": settings.get("sheetHeight"),
            },
            marginsMm={
                "left": settings.get("marginLeft"),
                "right": settings.get("marginRight"),
                "top": settings.get("marginTop"),
                "bottom": settings.get("marginBottom"),
            },
            gapsMm={"x": settings.get("gapX"), "y": settings.get("gapY")},
        )
    # §B10-4: Bình trang (S&R) = MỖI MẪU MỘT TỜ. Rẽ sớm sang nhánh dựng `sheets[]` (một tờ
    # cho mỗi mẫu, nest sát), thay vì gang mọi mẫu chung một tờ. Nup và ca khác đi tiếp
    # đường một-job bên dưới (giữ nguyên hành vi cũ).
    _task_mode = str(settings.get("taskMode") or "").strip().lower()
    if _task_mode in ("step_repeat", "sr"):
        return _build_step_repeat_preview(
            source_path,
            settings,
            job_id=job_id,
            cancel_event=cancel_event,
            progress_callback=progress_callback,
            subscriber_id=subscriber_id,
            legacy_preview_for_page=legacy_preview_for_page,
            allow_legacy_fallback=allow_legacy_fallback,
            raise_if_cancelled=_raise_if_cancelled,
        )

    job_build_started = time.perf_counter()
    job = build_true_shape_nesting_job(source_path, settings, job_id=job_id)
    _raise_if_cancelled()
    job_build_wall_ms = (time.perf_counter() - job_build_started) * 1000.0
    identity_digest = job_identity_digest(job) if trace_enabled else None
    if trace_enabled:
        pont_config = getattr(getattr(job, "pont", None), "config", None)
        trace_nesting_event(
            "preview.job",
            trace_id=trace_id,
            request_id=request_id,
            sessionIdentityDigest=identity_digest,
            tool=job.tool,
            intent=job.layout_intent,
            partCount=len(job.parts),
            pont={
                "type": getattr(getattr(job, "pont", None), "type", None),
                "config": summarize_pont_config(pont_config),
            },
            fixedObstacleCount=len(job.fixed_obstacles or ()),
            fixedObstacleIds=[
                str(obstacle.get("obstacleId"))
                for obstacle in (job.fixed_obstacles or ())
                if isinstance(obstacle, Mapping)
            ],
            profile=job.profile,
            timeBudgetMs=job.time_budget_ms,
        )
    store = get_preview_session_store()
    lookup_started = time.perf_counter()
    try:
        lookup = store.get_or_solve(
            job,
            subscriber_id=subscriber_id,
            cancel_event=cancel_event,
            progress_callback=progress_callback,
        )
    except Exception as exc:
        if trace_enabled:
            trace_nesting_event(
                "preview.error",
                trace_id=trace_id,
                request_id=request_id,
                sessionIdentityDigest=identity_digest,
                errorType=type(exc).__name__,
                jobBuildWallMs=round(job_build_wall_ms, 3),
                sessionLookupWallMs=round(
                    (time.perf_counter() - lookup_started) * 1000.0, 3
                ),
                nativeRuntime=native_runtime_summary(),
                elapsedMs=round((time.perf_counter() - started) * 1000.0, 3),
            )
        raise
    lookup_finished = time.perf_counter()
    _raise_if_cancelled()
    session = lookup.session

    # PERF (audit 2026-09-02 §PERF-NEST-05/07): quyết định quality gate phải hoàn
    # tất trên snapshot pin ngay sau solve, trước khi trả chi phí chiếu placement.
    # Proof được lưu trước tín hiệu grid để handoff đang chờ vẫn nhận đúng quyết định.
    nesting_capacity = session_capacity(session)
    if allow_legacy_fallback and len(job.parts) == 1:
        quality_gate_proof = _quality_gate_proof_for_session(
            settings=settings,
            job=job,
            session=session,
            store=store,
        )
        if _quality_gate_proof_selects_grid(quality_gate_proof):
            from app.core.nesting_quality_gate import GridBeatsNestingSignal

            raise GridBeatsNestingSignal(
                grid_capacity=int(quality_gate_proof["gridCapacity"]),
                nesting_capacity=nesting_capacity,
            )

    production = session.solved.production_request
    bundle = production.render_bundle
    manifest = session.solved.manifest
    parts = {str(part["partId"]): part for part in bundle["parts"]}
    sheet_height_mm = float(job.sheet_height_mm)

    # Preview mặc định hiện tờ 0. Số tờ đi riêng ở `sheetsNeeded`. (S&R nhiều mẫu đã rẽ sớm
    # sang `_build_step_repeat_preview` để trả `sheets[]` — mỗi mẫu một tờ.)
    sheet_zero_rings: list[list[list[float]]] = []
    cells = _project_sheet_cells(
        job,
        session,
        sheet_index=0,
        collect_rings=sheet_zero_rings if trace_enabled else None,
    )

    response = {
        "success": True,
        "totalItems": nesting_capacity,
        "overallWidth": float(job.sheet_width_mm) * PT_PER_MM,
        "overallHeight": sheet_height_mm * PT_PER_MM,
        "strategyUsed": "true_shape_nesting",
        "cells": cells,
        # Backend đã trả toạ độ tuyệt đối — frontend KHÔNG được canh giữa lại.
        "absPlacement": True,
        "isMixedPreview": len(parts) > 1,
        "sheetsNeeded": session_sheet_count(session),
        "placedByPage": _placed_by_page(job, manifest),
        "coordinateSpace": "sheet_abs_pt",
    }
    if trace_enabled:
        runtime_diagnostics = session.solved.runtime_diagnostics
        native_phase_timings = runtime_diagnostics.get("phaseTimings")
        if not isinstance(native_phase_timings, Mapping):
            native_phase_timings = None
        native_boundary_timings = runtime_diagnostics.get("nativeBoundaryTimings")
        if not isinstance(native_boundary_timings, Mapping):
            native_boundary_timings = None
        nfp_diagnostics = nfp_diagnostics_summary(
            runtime_diagnostics.get("nfpDiagnostics")
        )
        production_boundary_timings = runtime_diagnostics.get(
            "productionBoundaryTimings"
        )
        if not isinstance(production_boundary_timings, Mapping):
            production_boundary_timings = None
        trace_nesting_event(
            "preview.result",
            trace_id=trace_id,
            request_id=request_id,
            sessionIdentityDigest=identity_digest,
            cacheReused=lookup.reused,
            requestedAlign=getattr(req, "align", None),
            absPlacement=True,
            jobBuildWallMs=round(job_build_wall_ms, 3),
            sessionLookupWallMs=round(
                (lookup_finished - lookup_started) * 1000.0, 3
            ),
            previewProjectionWallMs=round(
                (time.perf_counter() - lookup_finished) * 1000.0, 3
            ),
            elapsedTotalMs=round((time.perf_counter() - started) * 1000.0, 3),
            productionIdentity=production_identity_summary(production),
            nativeRuntime=native_runtime_summary(),
            nativePhaseTimings=native_phase_timings,
            nativeBoundaryTimings=native_boundary_timings,
            productionBoundaryTimings=production_boundary_timings,
            nfpDiagnostics=nfp_diagnostics,
            **manifest_trace_summary(
                manifest, layout_fingerprint=production.layout_fingerprint
            ),
            sheet0Geometry=contour_envelope_summary(
                sheet_zero_rings,
                sheet_width_mm=float(job.sheet_width_mm),
                sheet_height_mm=float(job.sheet_height_mm),
                margins_mm=job.margin_mm or {},
            ),
        )
    return response


def _grid_capacity_for_design(
    source_path: str, settings: Mapping[str, Any], job: Any
) -> int:
    """Sức chứa đường cũ cho một job single-design (mỗi mẫu một tờ của S&R)."""

    from app.core.nesting_quality_gate import grid_capacity_from_settings

    parts = getattr(job, "parts", ()) or ()
    if len(parts) != 1:
        return 0
    return grid_capacity_from_settings(
        source_path, settings, int(parts[0].page_index)
    )


def _quality_gate_proof_for_session(
    *,
    settings: Mapping[str, Any],
    job: Any,
    session: Any,
    store: Any,
) -> dict[str, Any] | None:
    """Đo gate trên snapshot pin rồi lưu proof server-owned đã verify.

    ``grid_capacity == 0`` nghĩa là probe không có ý kiến. Trường hợp đó không được
    tạo proof ``nesting`` vì export phải có quyền đo lại trên snapshot đã resolve.
    """

    from app.core.nesting_quality_gate import (
        build_quality_gate_proof_for_session,
        grid_capacity_from_settings,
        quality_gate_source_for_session,
        verify_quality_gate_proof_for_session,
    )

    parts = getattr(job, "parts", ()) or ()
    if len(parts) != 1:
        return None
    source = quality_gate_source_for_session(
        session,
        job,
        part_id=str(getattr(parts[0], "part_id", "")),
    )
    if source is None:
        return None
    grid_capacity = grid_capacity_from_settings(
        str(source["source_path"]),
        settings,
        int(getattr(parts[0], "page_index")),
    )
    if grid_capacity <= 0:
        return None
    proof = build_quality_gate_proof_for_session(
        settings,
        job,
        session,
        grid_capacity=grid_capacity,
    )
    verified = verify_quality_gate_proof_for_session(
        proof,
        settings,
        job,
        session,
    )
    if verified is None:
        return None
    detached = verified.to_dict()
    remember = getattr(store, "remember_quality_gate_proof", None)
    if not callable(remember) or not bool(remember(job, detached)):
        return None
    return detached


def _quality_gate_proof_selects_grid(proof: Any) -> bool:
    """Chỉ proof đã verify, có phép đo dương mới được chọn đường lưới."""

    if not isinstance(proof, Mapping):
        return False
    try:
        return str(proof.get("decision")) == "grid" and int(
            proof.get("gridCapacity") or 0
        ) > 0
    except (TypeError, ValueError):
        return False


def _enforce_quality_gate_totals(*, nesting_capacity: int, grid_capacity: int) -> None:
    """Ném tín hiệu khi TỔNG của đường cũ ≥ tổng nesting (dùng cho S&R nhiều mẫu)."""

    from app.core.nesting_quality_gate import GridBeatsNestingSignal, grid_wins

    if grid_wins(nesting_capacity, grid_capacity):
        logger.info(
            "[NEST-GATE] S&R: tổng lưới %s ≥ tổng nesting %s ⇒ dùng đường cũ",
            grid_capacity,
            nesting_capacity,
        )
        raise GridBeatsNestingSignal(
            grid_capacity=grid_capacity, nesting_capacity=nesting_capacity
        )


def _enforce_quality_gate(
    source_path: str,
    settings: Mapping[str, Any],
    *,
    page_index: int,
    nesting_capacity: int,
    layout_intent: str = "autofill_single_sheet",
    nesting_sheets: int = 0,
    total_quantity: int = 0,
) -> None:
    """Ném `GridBeatsNestingSignal` nếu đường cũ xếp được ≥ nesting cho mẫu này.

    Gọi SAU khi đã có sức chứa nesting. Người bắt tín hiệu (route sync / runner job) đổi nó
    thành preview của đường cũ, nên người dùng luôn nhận con số TỐT HƠN — không bao giờ thấy
    "Xếp tối ưu" tệ hơn "Lưới đơn giản".
    """

    from app.core.nesting_quality_gate import (
        GridBeatsNestingSignal,
        grid_beats_nesting,
        grid_capacity_from_settings,
    )

    grid_capacity = grid_capacity_from_settings(source_path, settings, page_index)
    if grid_beats_nesting(
        layout_intent=layout_intent,
        nesting_placed=nesting_capacity,
        nesting_sheets=nesting_sheets,
        total_quantity=total_quantity,
        grid_capacity=grid_capacity,
    ):
        logger.info(
            "[NEST-GATE] trang %s (%s): lưới %s ⇒ dùng đường cũ "
            "(nesting placed=%s sheets=%s qty=%s)",
            page_index,
            layout_intent,
            grid_capacity,
            nesting_capacity,
            nesting_sheets,
            total_quantity,
        )
        raise GridBeatsNestingSignal(
            grid_capacity=grid_capacity, nesting_capacity=nesting_capacity
        )


def _project_sheet_cells(
    job: Any,
    session: Any,
    *,
    sheet_index: int = 0,
    collect_rings: list | None = None,
) -> list[dict[str, Any]]:
    """Dựng danh sách cell (toạ độ tuyệt đối pt + `diePolylines`) cho MỘT tờ của phiên.

    Tách khỏi `build_nesting_preview` để nhánh S&R (mỗi mẫu một tờ) và nhánh một-job dùng
    chung đúng một cách chiếu placement → cell, không lệch hình.
    """

    production = session.solved.production_request
    bundle = production.render_bundle
    manifest = session.solved.manifest
    parts = {str(part["partId"]): part for part in bundle["parts"]}
    sheet_frame = bundle["sheetFrames"]["cut"]
    sheet_height_mm = float(job.sheet_height_mm)
    # PERF (audit 2026-09-07 §TEMPERF.3): chỉ chuẩn hóa khuôn có placement trên
    # tờ đang chiếu, không đọc side/part không dùng và không giữ alias JSON.
    from app.workers.nup_artwork import prepare_manifest_part_context
    part_contexts: dict[str, ManifestPartContext] = {}

    cells: list[dict[str, Any]] = []
    for placement in manifest.get("placements") or ():
        if int(placement.get("sheetIndex") or 0) != sheet_index:
            continue
        part = parts.get(str(placement.get("partId")))
        if part is None:
            continue
        part_id = str(placement.get("partId"))
        if part_id not in part_contexts:
            part_contexts[part_id] = prepare_manifest_part_context(
                part=part, side="cut",
                render_bundle_hash=production.render_bundle_hash,
            )
        rings = _placed_rings_mm(
            placement,
            part_contexts[part_id],
            sheet_frame=sheet_frame,
            render_bundle_hash=production.render_bundle_hash,
        )
        if not rings or not rings[0]:
            continue
        if collect_rings is not None:
            collect_rings.extend(rings)
        abs_x, abs_y, width, height = _bbox_abs_pt(rings)
        rotation = float((placement.get("pose") or {}).get("rotationDeg") or 0.0)
        cells.append(
            {
                "x": abs_x,
                "y": abs_y,
                "absX": abs_x,
                "absY": abs_y,
                "width": width,
                "height": height,
                # Nesting dùng pose liên tục; hai cờ này là ngôn ngữ của lưới. Suy gần
                # đúng để phần chú thích hướng của UI không nói sai, không dùng để vẽ —
                # hình thật nằm ở `diePolylines`.
                "isRotated": abs((rotation % 180.0) - 90.0) < 1e-6,
                "isRotated180": abs((rotation % 360.0) - 180.0) < 1e-6,
                "blockId": 0,
                "pageIdx": _page_index_of(job, str(placement.get("partId"))),
                "diePolylines": [
                    [
                        _to_top_down_pt((point[0], point[1]), sheet_height_mm=sheet_height_mm)
                        for point in ring
                    ]
                    for ring in rings
                ],
            }
        )
    return cells


def _build_step_repeat_preview(
    source_path: str,
    settings: Mapping[str, Any],
    *,
    job_id: str | None,
    cancel_event: Any,
    progress_callback: Callable[[Mapping[str, Any]], None] | None,
    subscriber_id: str | None,
    legacy_preview_for_page: Callable[[int], Mapping[str, Any]] | None = None,
    allow_legacy_fallback: bool = False,
    raise_if_cancelled: Callable[[], None],
) -> dict[str, Any]:
    """Preview S&R: policy publication đi theo intent tường minh của request.

    Khi ``allow_legacy_fallback`` bật và caller cung cấp ``legacy_preview_for_page``,
    cổng chất lượng so từng mẫu rồi lấy nguyên layout lưới khi lưới thắng. Token nesting
    tường minh tắt bit này: mọi tờ giữ manifest nesting hoặc báo lỗi, khớp export.
    """

    from app.core.nesting_preview_session import (
        commit_and_reference,
        get_preview_session_store,
        session_capacity,
        session_sheet_count,
        step_repeat_subscriber_id,
    )
    from app.core.nesting_quality_gate import (
        GridBeatsNestingSignal,
        QUALITY_GATE_PROOF_FIELD,
    )
    from app.workers.nup_true_shape_nesting import (
        build_true_shape_nesting_jobs,
        run_step_repeat_batch_wave,
    )

    jobs = build_true_shape_nesting_jobs(source_path, settings, job_id=job_id)
    if not jobs:  # pragma: no cover - build luôn trả ≥1 job cho S&R
        raise ValueError("Không dựng được job nào cho Bình trang (S&R).")

    store = get_preview_session_store()
    # PERF/PARITY (audit 2026-09-01 §PERF-NEST-01): mọi preview S&R nhiều mẫu
    # công bố durable reference theo batch, không chỉ batch vượt LRU. Nếu chỉ latch
    # ca spill, handoff bấm giữa wave có thể gặp một job wave sau chưa submit rồi coi
    # là cache miss, khiến process export solve lại toàn batch. Một mẫu vẫn dùng đường
    # session nóng cũ để không trả thêm chi phí persist không cần thiết.
    spill_references: list[dict[str, Any] | None] | None = (
        [None] * len(jobs) if len(jobs) > 1 else None
    )
    quality_gate_proofs: list[dict[str, Any] | None] = [None] * len(jobs)
    batch_publication = (
        store.begin_reference_batch(jobs)
        if spill_references is not None
        and callable(getattr(store, "begin_reference_batch", None))
        else None
    )
    # PERF (audit 2026-09-02 §PERF-NEST-10): nếu batch reference đã được
    # `load_many()` xác minh, mọi session trong batch (kể cả bảy session còn nóng
    # trong LRU) đã có identity bền. Không để callback phía dưới persist lại các
    # manifest này — đó là một lượt băm/ghi đĩa đắt tiền nhưng không thêm bằng chứng.
    # Nếu kho cũ không hỗ trợ peek hoặc reference không đủ/không hợp lệ, giữ đường
    # cold hiện hữu và commit từng session như trước.
    existing_batch_references: tuple[dict[str, Any], ...] | None = None
    if spill_references is not None:
        peek_references = getattr(store, "peek_reference_batch", None)
        if callable(peek_references):
            try:
                cached = peek_references(jobs)
                if isinstance(cached, Sequence) and len(cached) == len(jobs):
                    normalized: list[dict[str, Any]] = []
                    for item in cached:
                        if not isinstance(item, Mapping):
                            raise ValueError("Reference batch cache không phải object.")
                        manifest_id = item.get("manifestId")
                        layout_fingerprint = item.get("layoutFingerprint")
                        if not isinstance(manifest_id, str) or not isinstance(
                            layout_fingerprint, str
                        ):
                            raise ValueError("Reference batch cache thiếu identity.")
                        normalized.append(dict(item))
                    existing_batch_references = tuple(normalized)
                    spill_references[:] = [
                        dict(reference) for reference in existing_batch_references
                    ]
            except Exception:  # pragma: no cover - cache chỉ là đường tăng tốc
                logger.debug(
                    "Không đọc được reference batch cache; sẽ commit lại session.",
                    exc_info=True,
                )

    def solve_and_publish(
        job: Any,
        *,
        design_index: int,
        cancel_event: Any,
        progress_callback: Callable[[Mapping[str, Any]], None] | None,
        runtime_worker_grant_request: Any,
    ) -> Any:
        """Một lane vẫn đi qua store; publication được bảo vệ khỏi LRU."""

        def raise_if_batch_cancelled() -> None:
            checker = getattr(cancel_event, "is_set", None)
            if callable(checker) and checker():
                raise InterruptedError("Đã hủy publication preview S&R.")

        def gate_and_publish_session(session: Any) -> None:
            raise_if_batch_cancelled()
            proof: dict[str, Any] | None = None
            if allow_legacy_fallback:
                # PERF (audit 2026-09-02 §PERF-NEST-05/07): từng lane đo đúng
                # snapshot pin, lưu proof theo design_index rồi mới được commit ref.
                proof = _quality_gate_proof_for_session(
                    settings=settings,
                    job=job,
                    session=session,
                    store=store,
                )
                quality_gate_proofs[design_index] = proof
            raise_if_batch_cancelled()
            if spill_references is None:
                return
            try:
                if existing_batch_references is not None:
                    reference = dict(existing_batch_references[design_index])
                    # Identity lệch ở đây nghĩa là cache/session bị hỏng giữa hai
                    # chốt. Fail-closed để không công bố layout của mẫu khác.
                    if (
                        str(getattr(session, "manifest_id", ""))
                        != str(reference.get("manifestId"))
                        or str(getattr(session, "layout_fingerprint", ""))
                        != str(reference.get("layoutFingerprint"))
                    ):
                        raise ValueError(
                            "Identity session không khớp reference batch đã xác minh."
                        )
                else:
                    reference = commit_and_reference(session)
            except InterruptedError:
                raise
            except Exception as exc:
                # PARITY (audit 2026-08-31 §S&R-HANDOFF-SPILL): preview chỉ được
                # công bố khi mọi manifest đã có reference bền. Lỗi một lane làm cả
                # batch fail-closed; scheduler sẽ hủy cooperative các lane còn lại.
                raise RuntimeError(
                    "Không thể công bố manifest preview S&R "
                    f"mẫu {design_index + 1}/{len(jobs)}."
                ) from exc
            raise_if_batch_cancelled()
            if proof is not None:
                reference[QUALITY_GATE_PROOF_FIELD] = dict(proof)
            spill_references[design_index] = reference

        return store.get_or_solve(
            job,
            subscriber_id=step_repeat_subscriber_id(subscriber_id, design_index),
            cancel_event=cancel_event,
            progress_callback=progress_callback,
            runtime_worker_grant_request=runtime_worker_grant_request,
            session_callback=(
                gate_and_publish_session
                if allow_legacy_fallback or spill_references is not None
                else None
            ),
        )

    # PERF (audit 2026-09-01 §PERF-NEST-01): preview và execution dùng cùng
    # scheduler wave/hardware grant. Kết quả được collect theo index nên completion
    # order không thể đổi pose, thứ tự mẫu hay batch reference công bố cho export.
    try:
        lookups = run_step_repeat_batch_wave(
            jobs,
            cancel_event=cancel_event,
            progress_callback=progress_callback,
            runner=solve_and_publish,
        )
    except BaseException as exc:
        if batch_publication is not None:
            store.finish_reference_batch(jobs, batch_publication, error=exc)
        raise

    # Mọi manifest spill đã commit ở đây. Công bố batch identity trước projection để
    # handoff đang chờ không phải gom session qua một LRU đang biến động. Export vẫn
    # chạy lại quality gate theo cùng policy/fingerprint nên reference không bypass
    # quyết định grid-vs-nesting của từng mẫu.
    if spill_references is not None:
        if any(reference is None for reference in spill_references):
            exc = RuntimeError("Batch reference preview S&R không đủ mọi mẫu.")
            if batch_publication is not None:
                store.finish_reference_batch(jobs, batch_publication, error=exc)
            raise exc
        ordered_references = [
            reference for reference in spill_references if reference is not None
        ]
        try:
            if batch_publication is not None:
                store.finish_reference_batch(
                    jobs,
                    batch_publication,
                    references=ordered_references,
                )
            else:
                store.remember_reference_batch(jobs, ordered_references)
        except Exception as exc:
            if batch_publication is not None:
                store.finish_reference_batch(jobs, batch_publication, error=exc)
            raise RuntimeError(
                "Không thể lưu batch reference của preview S&R."
            ) from exc

    sheets: list[dict[str, Any]] = []
    placed_by_page: dict[str, int] = {}
    total_sheets = 0
    for design_index, (job, lookup) in enumerate(zip(jobs, lookups, strict=True)):
        raise_if_cancelled()
        session = lookup.session
        nesting_capacity = session_capacity(session)
        page_index = int(job.parts[0].page_index)

        # PERF (audit 2026-09-02 §PERF-NEST-05/07): geometry lưới chỉ được dựng
        # khi proof server-owned đã chọn grid; nesting thắng không trả chi phí này.
        proof = quality_gate_proofs[design_index]
        grid_capacity = (
            int(proof.get("gridCapacity") or 0)
            if isinstance(proof, Mapping)
            else 0
        )
        grid_selected = _quality_gate_proof_selects_grid(proof)
        legacy_result: Mapping[str, Any] | None = None
        if grid_selected and legacy_preview_for_page is not None:
            try:
                candidate = legacy_preview_for_page(page_index)
                if isinstance(candidate, Mapping) and bool(candidate.get("success")):
                    legacy_result = candidate
            except Exception:  # noqa: BLE001 - gate lỗi không được che layout nesting hợp lệ
                logger.warning(
                    "[NEST-GATE] không dựng được preview lưới trang %s",
                    page_index,
                    exc_info=True,
                )
            if grid_selected and legacy_result is None:
                # Vẫn giữ cổng chất lượng: nếu đo được lưới thắng nhưng không lấy được
                # geometry lưới thì để caller dùng đường fallback legacy đã có.
                raise GridBeatsNestingSignal(
                    grid_capacity=grid_capacity,
                    nesting_capacity=nesting_capacity,
                )
        elif grid_selected:
            # Caller auto hiện tại luôn truyền callback per-design. Caller cũ không
            # có geometry thì nhường toàn bộ về fallback legacy, không công bố preview
            # nesting trái với proof mà export sắp dùng.
            raise GridBeatsNestingSignal(
                grid_capacity=grid_capacity,
                nesting_capacity=nesting_capacity,
            )

        if grid_selected and legacy_result is not None:
            cells = [
                {**dict(cell), "pageIdx": page_index}
                for cell in (legacy_result.get("cells") or ())
                if isinstance(cell, Mapping)
            ]
            selected_capacity = grid_capacity
            selected_strategy = str(
                legacy_result.get("strategyUsed") or "optimal_auto"
            )
            selected_sheet_count = max(
                1, int(legacy_result.get("sheetsNeeded") or 1)
            )
            overall_width = float(
                legacy_result.get("overallWidth")
                or float(job.sheet_width_mm) * PT_PER_MM
            )
            overall_height = float(
                legacy_result.get("overallHeight")
                or float(job.sheet_height_mm) * PT_PER_MM
            )
            placed_by_page[str(page_index)] = selected_capacity
        else:
            nesting_cells = _project_sheet_cells(job, session, sheet_index=0)
            cells = nesting_cells
            selected_capacity = nesting_capacity
            selected_strategy = "true_shape_nesting"
            selected_sheet_count = max(1, session_sheet_count(session))
            overall_width = float(job.sheet_width_mm) * PT_PER_MM
            overall_height = float(job.sheet_height_mm) * PT_PER_MM
            for key, value in _placed_by_page(job, session.solved.manifest).items():
                placed_by_page[key] = placed_by_page.get(key, 0) + int(value)

        sheets.append(
            {
                "cells": cells,
                "overallWidth": overall_width,
                "overallHeight": overall_height,
                "totalItems": selected_capacity,
                "strategyUsed": selected_strategy,
                "absPlacement": True,
                "physicalSheetIndex": design_index,
                "runCount": 1,
            }
        )
        total_sheets += selected_sheet_count
        logger.info(
            "[NEST-GATE] S&R trang %s: lưới=%s nesting=%s ⇒ %s",
            page_index + 1,
            grid_capacity,
            nesting_capacity,
            selected_strategy,
        )

    first = sheets[0]
    return {
        "success": True,
        # `per_design_best` báo frontend đây là publication all-page đã chốt; nhãn
        # hiển thị lấy `strategyUsed` của chính tờ đang xem.
        "totalItems": first["totalItems"],
        "overallWidth": first["overallWidth"],
        "overallHeight": first["overallHeight"],
        "strategyUsed": (
            "per_design_best"
            if allow_legacy_fallback and legacy_preview_for_page is not None
            else "true_shape_nesting"
        ),
        "cells": first["cells"],
        "absPlacement": True,
        "isMixedPreview": False,
        "sheetsNeeded": max(1, total_sheets),
        "placedByPage": placed_by_page,
        "coordinateSpace": "sheet_abs_pt",
        "sheets": sheets,
    }


def _page_index_of(job: Any, part_id: str) -> int:
    for part in job.parts:
        if part.part_id == part_id:
            return int(part.page_index)
    return 0


def _placed_by_page(job: Any, manifest: Mapping[str, Any]) -> dict[str, int]:
    """Số con theo TRANG NGUỒN trên tờ 0 — cột "SL/tờ" của bảng mẫu đọc khoá này."""

    counts: dict[str, int] = {}
    for placement in manifest.get("placements") or ():
        if int(placement.get("sheetIndex") or 0) != 0:
            continue
        key = str(_page_index_of(job, str(placement.get("partId"))))
        counts[key] = counts.get(key, 0) + 1
    return counts

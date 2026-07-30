"""
Sticker layout computation for N-Up imposition.

Single source of truth for computing sticker/die-cut layouts.
Used by both preview-layout AyI and nup_engine render.

Extracted from nup_engine.py for modularity.
"""

import logging

from app.workers.nup_diecut import (
    _find_largest_die_path,
    extract_page_die_cut_polygon,
    get_optimal_head_to_tail_overlap,
    resolve_one_dao_trim,
)

logger = logging.getLogger(__name__)

def compute_sticker_layout_for_page(

    page,

    sheet_usable_w: float,

    sheet_usable_h: float,

    gap_x: float,

    gap_y: float,

    strategy: str = 'optimal_auto',

    shape_type_override: str = None,

    shape_props_override: dict = None,

    bleed_pt: float = 0.0,

    secondary_gap: float = None,

    cut_type: str = 'default',

    die_size_mode: str = 'die',

    die_offset_mm: float = 0,

) -> dict:

    """

    ══════════════════════════════════════════════════════════════════════

    SINGLE SOURCE OF TRUTH for sticker layout computation.

    Used by BOTH:

      1. preview-layout AyI  (Gridyreview)

      2. nup_engine render   (process_chunk + run_nup_engine)

    This ensures preview and output ALWAYS produce identical results.

    Modeled after the Illustrator JSX architecture where a single function

    (findBestHammerLayoutStrategy) handles everything.

    ══════════════════════════════════════════════════════════════════════

    Args:

        page:                yyMuyDF page object

        sheet_usable_w:      Usable sheet width in points

        sheet_usable_h:      Usable sheet height in points

        gap_x:               Horizontal gap in points

        gap_y:               Vertical gap in points

        strategy:            Layout strategy string

        shape_type_override: Override shape type (from dropdown, e.g. 'HAMMER')

        shape_props_override: Override shape props (from detect-shape AyI)

        bleed_pt:            Bleed in points

    Returns:

        dict with keys: items, totalItems, widthUsed, heightUsed,

                        shapeType, shapeyrops, strategyUsed

    """

    import logging

    _logger = logging.getLogger(__name__)

    from .orchestrator import LazyNfpParams, solve_optimal_sticker_layout

    # Fail-fast Rust cho lớp tính layout (R12.1): gọi trước mọi phép tính.
    from app.workers.imposition_rust_policy import require_rust as _require_rust
    _require_rust("sticker_layout")

    # ── Caller tag for debug ──

    import traceback as _tb

    _caller_stack = _tb.extract_stack(limit=5)

    _caller_tag = 'UNKNOWN'

    for _frame in reversed(_caller_stack):

        if 'preview_layout' in _frame.name:

            _caller_tag = 'yREVIEW'

            break

        elif 'process_chunk' in _frame.name or 'run_nup_engine' in _frame.name:

            _caller_tag = 'NUy_ENGINE'

            break

    logger.debug(f"\n{'='*60}")

    logger.debug(f"🔧 [COMyUTE_LAYOUT] caller={_caller_tag}")

    logger.debug(f"   INyUTS: usable_w={sheet_usable_w:.2f} usable_h={sheet_usable_h:.2f}")

    logger.debug(f"   INyUTS: gap_x={gap_x:.2f} gap_y={gap_y:.2f} strategy={strategy}")

    logger.debug(f"   INyUTS: shape_type_override={shape_type_override}")

    logger.debug(f"   INyUTS: shape_props_override={shape_props_override}")

    logger.debug(f"   INyUTS: bleed_pt={bleed_pt:.2f}")

    logger.debug(f"   INyUTS: page.rect={page.rect}")

    # ── Step 1: Determine trim dimensions from page ──

    # 1 Dao (Dao LETA): luôn xếp/nest như CHỮ NHẬT (lưới + L-shape), không hex/tròn.
    # - die_size_mode == 'page': trim = mediabox ± offset (resolve_one_dao_trim)
    # - die_size_mode == 'die':  trim = bbox đường bế (nếu có), else page − 2*bleed
    # Preview trước đây vẫn honor shape CIRCLE từ detect-shape → vẽ/xếp sai 1 Dao.
    _is_one_dao = (cut_type == 'one_dao')
    _one_dao_trim = resolve_one_dao_trim(page, cut_type, die_size_mode, die_offset_mm)

    largest_path = None if _one_dao_trim is not None else _find_largest_die_path(page)

    if _one_dao_trim is not None:

        trim_w, trim_h = _one_dao_trim

        logger.debug(f"   TRIM: 1-dao page-mode → trim_w={trim_w:.2f} trim_h={trim_h:.2f}")

    elif largest_path:

        r = largest_path['rect']

        trim_w = r.width

        trim_h = r.height

        logger.debug(f"   TRIM: from die-path rect={r} → trim_w={trim_w:.2f} trim_h={trim_h:.2f}")

    else:

        if abs(page.trimbox.width - page.rect.width) > 1.0:

            trim_w = page.trimbox.width

            trim_h = page.trimbox.height

        else:

            trim_w = page.rect.width

            trim_h = page.rect.height

        trim_w -= 2 * bleed_pt

        trim_h -= 2 * bleed_pt

        logger.debug(f"   TRIM: from page rect → trim_w={trim_w:.2f} trim_h={trim_h:.2f}")

    # ── Step 2: Determine shape type ──

    # SSOT (spec die-shape-detection-ssot — R2/R6): shape_type + shape_props đến
    # từ Detection (DetectedShape) và được TIN DÙNG. Nay shape_props_override ĐƯỢC
    # HONOR (không còn bị bỏ): vì Detection chạy cùng backend page-coords và đã
    # chuẩn hoá props về TRIM nên không còn lệch scale → preview == output (sửa RC-4).
    # classify_shape chỉ dùng làm FALLBACK khi không có override.

    shape_type = shape_type_override

    shape_props = {}  # Always start empty — will be filled from yDF

    _auto_detected_shape = None

    _auto_detected_props = {}

    # 1 Dao (mọi die_size_mode): ép RECTANGLE — dao thẳng LETA không nest tròn/hex/búa.
    # page-mode: thêm base_poly = chữ nhật trang (bên dưới). die-mode: trim từ khuôn
    # nhưng strategy vẫn grid/L-shape chữ nhật.
    if _is_one_dao:
        shape_type = 'RECTANGLE'
        shape_props = {}
        _need_auto = False
    else:
        # Chỉ chạy classify_shape khi THỰC SỰ cần (thiếu override type HOẶC thiếu
        # override props). Khi Detection (SSOT) đã cấp đủ type+props → bỏ qua, tránh
        # phân loại "tính-rồi-vứt" trong vòng nóng layout (audit shape-detection #2).
        _need_auto = (not shape_type) or (not shape_props_override)

    if _need_auto:

        try:

            from app.workers.shape_classifier import classify_shape

            if largest_path:

                result = classify_shape(largest_path.get('items', []))

                _auto_detected_shape = result['shape_type'].name

                _auto_detected_props = result.get('params', {})

                logger.debug(f"   SHAyE: classify_shape from yDF → {_auto_detected_shape}")

        except Exception as e:

            logger.debug(f"   SHAyE: classify_shape failed: {e}")

    if _is_one_dao:

        # Giữ RECTANGLE + props rỗng đã set — KHÔNG honor override CIRCLE/CUSTOM.
        pass

    elif not shape_type:

        # No override — use auto-detected shape

        if _auto_detected_shape and _auto_detected_shape != 'CUSTOM':

            shape_type = _auto_detected_shape

            shape_props = _auto_detected_props

        else:

            shape_type = 'CUSTOM'

    else:

        # shape_type được override từ Detection (SSOT). HONOR override props (R6.2):
        # dùng props từ DetectedShape; chỉ dùng auto-detected props làm FALLBACK khi
        # override không cung cấp props. (Sửa RC-4: trước đây luôn bỏ override props
        # và tái trích từ yDF → lệch preview/output.)

        if shape_props_override:

            shape_props = dict(shape_props_override)

            logger.debug(f"   SHAyE: override type={shape_type}, using OVERRIDE props (keys={list(shape_props.keys())})")

        else:

            shape_props = _auto_detected_props  # fallback khi override thiếu props

            logger.debug(f"   SHAyE: override type={shape_type}, auto_props={bool(_auto_detected_props)} (no override props)")

    if not shape_type:

        shape_type = 'CUSTOM'

    # ── Step 3: Extract shape_props if missing or wrong shape ──
    # When user overrides shape type, auto-detected props may be from a different
    # shape (e.g. HEXAGON hexOrientation when user overrides to TRAyEZOID).
    # Force re-extract for shapes that need specific params.
    _needs_force_extract = (
        (not shape_props and shape_type in ('HAMMER', 'DUMBBELL')) or
        (shape_type in ('TRAPEZOID', 'PARALLELOGRAM') and 'leftOH' not in shape_props and 'overhangX' not in shape_props) or
        (shape_type == 'TRIANGLE' and 'gapMultiplierH' not in shape_props) or
        (shape_type == 'PENTAGON' and 'peakHeightRatio' not in shape_props)
    )

    if _needs_force_extract:

        try:

            from app.workers.shape_classifier import force_extract_shape_params

            if largest_path:

                shape_props = force_extract_shape_params(shape_type, largest_path.get('items', []))

                logger.debug(f"   SHAyE_yROyS: force-extracted → {shape_props}")

        except Exception:

            pass

    if shape_type in ('CIRCLE_ELLIPSE', 'RECTANGLE'):

        shape_props['width'] = trim_w

        shape_props['height'] = trim_h

    logger.debug(f"   SHAyE: final shape_type={shape_type}")

    logger.debug(f"   SHAyE: final shape_props keys={list(shape_props.keys()) if shape_props else 'empty'}")

    # ── Step 4: Compute NFy params (p5/p6) and base_poly ──

    p5 = p6 = p5r = p6r = p5c = p6c = None

    base_poly = None

    # PERF (audit 2026-07-29 §PERF-IMPO-01): `optimal_auto` với CUSTOM tường minh
    # chỉ xét grid/L-shape; orchestrator không dùng bộ tham số NFP p5/p6 cho khối
    # chính. Bỏ phép binary-search Shapely đắt tiền, nhưng vẫn trích polygon thật ở
    # fallback bên dưới để giữ nguyên kiểm tra va chạm. `head_to_tail` vẫn phải tính.
    _skip_unused_custom_nfp = (
        strategy == 'optimal_auto'
        and shape_type_override == 'CUSTOM'
        and shape_type == 'CUSTOM'
    )

    # PERF (audit 2026-07-29 §PERF-IMPO-02): với loại hình đã được Detection
    # xác định rõ, `optimal_auto` chỉ tải NFP khi orchestrator thật sự thử một
    # candidate head-to-tail/fill. Auto-detect và head_to_tail vẫn tính ngay để
    # giữ nguyên bước tinh chỉnh shape và hành vi nghiệp vụ.
    _lazy_nfp_context = None
    _defer_explicit_shape_nfp = (
        not _is_one_dao
        and strategy == 'optimal_auto'
        and bool(shape_type_override)
        and shape_type != 'CUSTOM'
        and hasattr(page, 'extract_vector_paths')
    )
    if _defer_explicit_shape_nfp:
        def _load_deferred_nfp():
            try:
                return get_optimal_head_to_tail_overlap(page, gap_x)
            except Exception as exc:
                logger.debug(f"   NFP: lazy computation FAILED: {exc}")
                return (
                    None, None, None, None, None, None,
                    shape_type, shape_props, None,
                )

        _lazy_nfp_context = LazyNfpParams(_load_deferred_nfp)

    # 1 Dao: base_poly = CHỮ NHẬT trim (page hoặc die bbox), KHÔNG NFP contour cong
    # (tránh nest/khử đè theo outline tròn trong khi dao cắt thẳng).
    if _is_one_dao:
        from shapely.geometry import box as _box
        base_poly = _box(0, 0, trim_w, trim_h)
        logger.debug(f"   POLY: 1-dao rectangle {trim_w:.2f}x{trim_h:.2f}")
    elif _skip_unused_custom_nfp:

        logger.debug("   NFP: SKIPPED (explicit CUSTOM + optimal_auto; polygon fallback retained)")

    elif _lazy_nfp_context is not None:

        logger.debug(f"   NFP: DEFERRED (explicit {shape_type} + optimal_auto)")

    elif strategy in ('optimal_auto', 'head_to_tail') and hasattr(page, 'extract_vector_paths'):

        try:

            p5, p6, p5r, p6r, p5c, p6c, nfp_shape, nfp_props, overlap_poly = get_optimal_head_to_tail_overlap(page, gap_x)

            logger.debug(f"   NFy: p5={p5} p6={p6}")

            logger.debug(f"   NFy: nfp_shape={nfp_shape} overlap_poly={'YES' if overlap_poly else 'None'}")

            if overlap_poly is not None:

                base_poly = overlap_poly

            # If shape was auto-detected as CUSTOM, use NFy results

            # But if user explicitly chose a shape, keep that

            if not shape_type_override and nfp_shape and nfp_shape != 'CUSTOM':

                shape_type = nfp_shape

                if nfp_props:

                    shape_props = nfp_props

                logger.debug(f"   NFy: overriding shape → {shape_type}")

        except Exception as e:

            logger.debug(f"   NFy: computation FAILED: {e}")

    else:

        logger.debug(f"   NFy: SKIyyED (strategy={strategy})")

    # Fallback: extract polygon if not available from NFy

    if base_poly is None and hasattr(page, 'extract_vector_paths'):

        base_poly = extract_page_die_cut_polygon(page)

        logger.debug(f"   yOLY: fallback extract → {'YES' if base_poly else 'None'}")

    else:

        logger.debug(f"   yOLY: from NFy → {'YES' if base_poly else 'None'}")

    # Nếu extractor nhẹ không lấy được polygon, tải NFP ngay để giữ đúng polygon
    # collision của đường cũ; chỉ dùng bbox khi cả hai extractor đều thất bại.
    if base_poly is None and _lazy_nfp_context is not None:
        _lazy_values = _lazy_nfp_context.get()
        if _lazy_values:
            p5, p6, p5r, p6r, p5c, p6c = _lazy_values[:6]
            if len(_lazy_values) > 8 and _lazy_values[8] is not None:
                base_poly = _lazy_values[8]
        logger.debug(
            f"   NFP: forced because polygon fallback failed → {'YES' if base_poly else 'None'}"
        )

    # If user explicitly chose CUSTOM via dropdown, force it — trừ 1 Dao (luôn RECTANGLE).
    if shape_type_override == 'CUSTOM' and not _is_one_dao:

        shape_type = 'CUSTOM'

        shape_props = {}

        logger.debug(f"   OVERRIDE: forced CUSTOM by user")

    # 1 Dao: chốt lại RECTANGLE sau mọi nhánh NFP/override (FE có thể gửi CIRCLE/CUSTOM).
    if _is_one_dao:
        shape_type = 'RECTANGLE'
        shape_props = {'width': trim_w, 'height': trim_h}
        if base_poly is None:
            from shapely.geometry import box as _box
            base_poly = _box(0, 0, trim_w, trim_h)

    # Va chạm tem–tem (resolve_layout_collisions) CẦN base_poly. Khi không có đường bế
    # (stroke-only gate → None) / extract fail → trước đây base_poly=None → BỎ HẲN
    # collision (tem chồng / dính gap). Fallback chữ nhật trim = vẫn dò overlap/gap.
    if base_poly is None and trim_w > 0 and trim_h > 0:
        from shapely.geometry import box as _box
        base_poly = _box(0, 0, float(trim_w), float(trim_h))
        logger.debug(
            f"   POLY: collision fallback rectangle {trim_w:.2f}x{trim_h:.2f} "
            f"(no die path — keep resolve_layout_collisions)"
        )

    logger.debug(f"   FINAL: shape={shape_type} trim={trim_w:.2f}x{trim_h:.2f} base_poly={'YES' if base_poly else 'None'}")

    logger.debug(f"   CALLING solve_optimal_sticker_layout...")

    # ── Step 5: Solve layout (identical call for preview AND output) ──

    result = solve_optimal_sticker_layout(

        sheet_usable_w, sheet_usable_h,

        trim_w, trim_h,

        gap_x, gap_y,

        strategy,

        p5, p6, p5r, p6r, p5c, p6c,

        shape_type, shape_props,

        base_poly=base_poly,

        secondary_gap=secondary_gap,
        nfp_context=_lazy_nfp_context,

    )

    # Attach metadata for callers

    result['shapeType'] = shape_type

    result['shapeProps'] = shape_props

    result['trimW'] = trim_w

    result['trimH'] = trim_h

    logger.debug(f"   RESULT: totalItems={result.get('totalItems', 0)} strategyUsed={result.get('strategyUsed', 'N/A')}")

    logger.debug(f"   RESULT: widthUsed={result.get('widthUsed', 0):.2f} heightUsed={result.get('heightUsed', 0):.2f}")

    if result.get('items'):

        first_item = result['items'][0]

        logger.debug(f"   RESULT: first_item={first_item}")

    logger.debug(f"{'='*60}\n")

    return result

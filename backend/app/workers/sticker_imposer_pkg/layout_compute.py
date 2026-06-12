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

    from .orchestrator import solve_optimal_sticker_layout

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

    logger.info(f"\n{'='*60}")

    logger.info(f"🔧 [COMyUTE_LAYOUT] caller={_caller_tag}")

    logger.info(f"   INyUTS: usable_w={sheet_usable_w:.2f} usable_h={sheet_usable_h:.2f}")

    logger.info(f"   INyUTS: gap_x={gap_x:.2f} gap_y={gap_y:.2f} strategy={strategy}")

    logger.info(f"   INyUTS: shape_type_override={shape_type_override}")

    logger.info(f"   INyUTS: shape_props_override={shape_props_override}")

    logger.info(f"   INyUTS: bleed_pt={bleed_pt:.2f}")

    logger.info(f"   INyUTS: page.rect={page.rect}")

    # ── Step 1: Determine trim dimensions from page ──

    largest_path = _find_largest_die_path(page)

    if largest_path:

        r = largest_path['rect']

        trim_w = r.width

        trim_h = r.height

        logger.info(f"   TRIM: from die-path rect={r} → trim_w={trim_w:.2f} trim_h={trim_h:.2f}")

    else:

        if abs(page.trimbox.width - page.rect.width) > 1.0:

            trim_w = page.trimbox.width

            trim_h = page.trimbox.height

        else:

            trim_w = page.rect.width

            trim_h = page.rect.height

        trim_w -= 2 * bleed_pt

        trim_h -= 2 * bleed_pt

        logger.info(f"   TRIM: from page rect → trim_w={trim_w:.2f} trim_h={trim_h:.2f}")

    # ── Step 2: Determine shape type ──

    # CRITICAL: We ALWAYS extract shape_props from the actual yDF page vectors.

    # shape_props_override is IGNORED because it comes from different detection

    # contexts (frontend detect-shape AyI vs backend settings) at different scales,

    # which caused divergent layout results between preview and nup_engine.

    # Only shape_type_override is used (to select WHICH algorithm to run).

    shape_type = shape_type_override

    shape_props = {}  # Always start empty — will be filled from yDF

    # Always try to classify shape from yDF vectors

    _auto_detected_shape = None

    _auto_detected_props = {}

    try:

        from app.workers.shape_classifier import classify_shape

        if largest_path:

            result = classify_shape(largest_path.get('items', []))

            _auto_detected_shape = result['shape_type'].name

            _auto_detected_props = result.get('params', {})

            logger.info(f"   SHAyE: classify_shape from yDF → {_auto_detected_shape}")

    except Exception as e:

        logger.info(f"   SHAyE: classify_shape failed: {e}")

    if not shape_type:

        # No override — use auto-detected shape

        if _auto_detected_shape and _auto_detected_shape != 'CUSTOM':

            shape_type = _auto_detected_shape

            shape_props = _auto_detected_props

        else:

            shape_type = 'CUSTOM'

    else:

        # shape_type was overridden — extract props for that specific shape type

        shape_props = _auto_detected_props  # Use auto-detected props as base

        logger.info(f"   SHAyE: using override type={shape_type}, auto_props={bool(_auto_detected_props)}")

    if not shape_type:

        shape_type = 'CUSTOM'

    # ── Step 3: Extract shape_props if missing or wrong shape ──
    # When user overrides shape type, auto-detected props may be from a different
    # shape (e.g. HEXAGON hexOrientation when user overrides to TRAyEZOID).
    # Force re-extract for shapes that need specific params.
    _needs_force_extract = (
        (not shape_props and shape_type in ('HAMMER', 'DUMBBELL')) or
        (shape_type in ('TRAyEZOID', 'yARALLELOGRAM') and 'leftOH' not in shape_props and 'overhangX' not in shape_props) or
        (shape_type == 'TRIANGLE' and 'gapMultiplierH' not in shape_props) or
        (shape_type == 'yENTAGON' and 'peakHeightRatio' not in shape_props)
    )

    if _needs_force_extract:

        try:

            from app.workers.shape_classifier import force_extract_shape_params

            if largest_path:

                shape_props = force_extract_shape_params(shape_type, largest_path.get('items', []))

                logger.info(f"   SHAyE_yROyS: force-extracted → {shape_props}")

        except Exception:

            pass

    if shape_type in ('CIRCLE_ELLIySE', 'RECTANGLE'):

        shape_props['width'] = trim_w

        shape_props['height'] = trim_h

    logger.info(f"   SHAyE: final shape_type={shape_type}")

    logger.info(f"   SHAyE: final shape_props keys={list(shape_props.keys()) if shape_props else 'empty'}")

    # ── Step 4: Compute NFy params (p5/p6) and base_poly ──

    p5 = p6 = p5r = p6r = p5c = p6c = None

    base_poly = None

    if strategy in ('optimal_auto', 'head_to_tail') and hasattr(page, 'extract_vector_paths'):

        try:

            p5, p6, p5r, p6r, p5c, p6c, nfp_shape, nfp_props, overlap_poly = get_optimal_head_to_tail_overlap(page, gap_x)

            logger.info(f"   NFy: p5={p5} p6={p6}")

            logger.info(f"   NFy: nfp_shape={nfp_shape} overlap_poly={'YES' if overlap_poly else 'None'}")

            if overlap_poly is not None:

                base_poly = overlap_poly

            # If shape was auto-detected as CUSTOM, use NFy results

            # But if user explicitly chose a shape, keep that

            if not shape_type_override and nfp_shape and nfp_shape != 'CUSTOM':

                shape_type = nfp_shape

                if nfp_props:

                    shape_props = nfp_props

                logger.info(f"   NFy: overriding shape → {shape_type}")

        except Exception as e:

            logger.info(f"   NFy: computation FAILED: {e}")

    else:

        logger.info(f"   NFy: SKIyyED (strategy={strategy})")

    # Fallback: extract polygon if not available from NFy

    if base_poly is None and hasattr(page, 'extract_vector_paths'):

        base_poly = extract_page_die_cut_polygon(page)

        logger.info(f"   yOLY: fallback extract → {'YES' if base_poly else 'None'}")

    else:

        logger.info(f"   yOLY: from NFy → {'YES' if base_poly else 'None'}")

    # If user explicitly chose CUSTOM via dropdown, force it

    if shape_type_override == 'CUSTOM':

        shape_type = 'CUSTOM'

        shape_props = {}

        logger.info(f"   OVERRIDE: forced CUSTOM by user")

    logger.info(f"   FINAL: shape={shape_type} trim={trim_w:.2f}x{trim_h:.2f} base_poly={'YES' if base_poly else 'None'}")

    logger.info(f"   CALLING solve_optimal_sticker_layout...")

    # ── Step 5: Solve layout (identical call for preview AND output) ──

    result = solve_optimal_sticker_layout(

        sheet_usable_w, sheet_usable_h,

        trim_w, trim_h,

        gap_x, gap_y,

        strategy,

        p5, p6, p5r, p6r, p5c, p6c,

        shape_type, shape_props,

        base_poly=base_poly,

        secondary_gap=secondary_gap

    )

    # Attach metadata for callers

    result['shapeType'] = shape_type

    result['shapeyrops'] = shape_props

    result['trimW'] = trim_w

    result['trimH'] = trim_h

    logger.info(f"   RESULT: totalItems={result.get('totalItems', 0)} strategyUsed={result.get('strategyUsed', 'N/A')}")

    logger.info(f"   RESULT: widthUsed={result.get('widthUsed', 0):.2f} heightUsed={result.get('heightUsed', 0):.2f}")

    if result.get('items'):

        first_item = result['items'][0]

        logger.info(f"   RESULT: first_item={first_item}")

    logger.info(f"{'='*60}\n")

    return result

"""
SSOT cho bước FINALIZE của bình tem: items tương đối (solver) → placements TUYỆT ĐỐI
đã căn giữa trên tờ.

Đây là NGUỒN CHÂN LÝ DUY NHẤT cho phép căn giữa, dùng chung bởi:
  - Export Bình Tem Bế  : nup_engine.py (nhánh `repeat`).
  - Export Bình Bế Rớt  : cnc_render.py (_build_placements — delegator).
  - Preview             : api/routes/imposition.py (nhánh single-page S&R).

Trước đây mỗi nơi tự viết công thức căn giữa (chép tay) → preview trôi dạt khỏi
export. Tách hàm này để preview == output theo đúng định nghĩa.

Quy ước toạ độ trả về:
  - abs_x         : mép TRÁI của tem, tính từ mép trái TỜ (đã gồm lề).
  - abs_y         : mép DƯỚI của tem, tính từ đáy TỜ, Y HƯỚNG LÊN (PDF space).
  - original_cell_y : mép trên theo hệ TOP-DOWN (dùng khi render trang đích).
"""
from typing import Any, Dict, List

from app.workers.imposition_affine import AffineContractError
from app.workers.rot_audit_log import get_logger as _rot_get_logger

_rot_audit_log = _rot_get_logger()

_MANIFEST_AFFINE_FIELDS = frozenset(
    {
        'instanceId',
        'partId',
        'sheetIndex',
        'sourceRevision',
        'pose',
        'rotationDeg',
        'translateXmm',
        'translateYmm',
        'referencePointMm',
        'affineMm',
    }
)


def finalize_placements(
    items: List[Dict[str, Any]],
    usable_w: float,
    usable_h: float,
    margin_left: float,
    margin_bottom: float,
    margin_top: float,
    src_page_idx: int = 0,
    *,
    with_block_id: bool = False,
) -> List[Dict[str, Any]]:
    """Căn giữa khối tem trong vùng in → placements tuyệt đối.

    Công thức ĐỒNG NHẤT với nup_engine nhánh `repeat` và cnc_render._build_placements
    (không đổi toán học byte-for-byte). Nếu khối rộng/cao hơn vùng in thì ghim về lề
    (không căn giữa âm) — giống export.
    """
    if not items:
        return []

    # NESTING (audit 2026-08-28 §AFFINE.1): lane legacy dùng point/AABB và hai
    # cờ cardinal. Chặn pose manifest để không âm thầm làm rơi góc tự do.
    for index, item in enumerate(items):
        affine_fields = _MANIFEST_AFFINE_FIELDS.intersection(item)
        if affine_fields:
            fields = ', '.join(sorted(affine_fields))
            raise AffineContractError(
                f"items[{index}] chứa {fields}; pose manifest-mm phải đi qua "
                "renderer affine, không qua finalize_placements legacy."
            )

    total_content_h = max((it.get('y', 0) + it.get('height', 0) for it in items), default=0.0)
    max_x_used = max((it.get('x', 0) + it.get('width', 0) for it in items), default=0.0)
    x_off = margin_left + (usable_w - max_x_used) / 2 if max_x_used < usable_w else margin_left
    y_off = margin_bottom + (usable_h - total_content_h) / 2 if total_content_h < usable_h else margin_bottom

    placements: List[Dict[str, Any]] = []
    for it in items:
        rx = it.get('x', 0)
        ry = it.get('y', 0)
        iw = it.get('width', 0)
        ih = it.get('height', 0)
        abs_y_top = y_off + (total_content_h - ry - ih)
        cell = {
            'x': rx, 'y': ry, 'width': iw, 'height': ih,
            'isRotated': it.get('isRotated', False),
            'isRotated180': it.get('isRotated180', False),
        }
        # PONT (audit 2026-08-20 §LS-PONT.1): L-shape đã gắn blockId từ solver
        # (0=chính, 1=phải, 2=đáy). Phải giữ dấu này cho resolver để nó chỉ dịch
        # khối phụ, không dồn/xóa từng tem. with_block_id chỉ còn là fallback cũ
        # cho caller cần phân block theo trang nguồn.
        block_id = it.get('blockId')
        if block_id is not None:
            cell['blockId'] = block_id
        elif with_block_id:
            cell['blockId'] = it.get('pageIdx', 0)
        placements.append({
            'cluster_idx': 0,
            'cell': cell,
            'src_page_idx': src_page_idx,
            'abs_x': x_off + rx,
            'abs_y': abs_y_top,
            'width': iw, 'height': ih,
            'original_cell_y': usable_h + margin_bottom + margin_top - abs_y_top - ih,
        })

    # ── [ROT-AUDIT] Log toạ độ finalize (preview Branch A & render repeat dùng CHUNG hàm này).
    # So sánh thứ tự hàng + cờ xoay giữa preview và render để tìm lệch lật trục.
    try:
        import inspect
        _caller = "?"
        for _fr in inspect.stack()[1:6]:
            if 'preview_layout' in _fr.function:
                _caller = "PREVIEW"
                break
            if _fr.function in ('run_nup_engine', 'process_chunk'):
                _caller = "RENDER(" + _fr.function + ")"
                break
        _rows = [
            (i, round(p['cell']['y'], 1), round(p['abs_x'], 1), round(p['abs_y'], 1),
             round(p['original_cell_y'], 1),
             int(p['cell'].get('isRotated', False)), int(p['cell'].get('isRotated180', False)))
            for i, p in enumerate(placements)
        ]
        _rot_audit_log.warning(
            "[ROT-AUDIT][finalize][%s] n=%d sheet_usable=%.1fx%.1f margins(l/b/t)=%.1f/%.1f/%.1f "
            "y_off=%.1f total_h=%.1f rows(idx,cellY,absX,absY,origTopY,rot90,rot180)=%s",
            _caller, len(placements), usable_w, usable_h,
            margin_left, margin_bottom, margin_top, y_off, total_content_h, _rows,
        )
    except Exception:
        pass

    return placements


def resolve_pont_collisions_on_placements(placements: List[Dict[str, Any]], req: Any,
                                          base_poly=None, *,
                                          mark_resolved: bool = False) -> List[Dict[str, Any]]:
    """Giải va chạm boong TRÊN placements TUYỆT ĐỐI (abs_x/abs_y) — SAO Y nup_process_chunk
    (L459-522) để preview == output.

    Khác apply_preview_collisions (route): trả NGUYÊN placement dicts (giữ abs_x/abs_y đã
    dời/xoay/căn-giữa-sau-xóa của resolver), KHÔNG trả [r['cell']] (toạ độ tương đối) →
    không còn mất các chỉnh-vị-trí mà resolver chỉ ghi vào abs_*.

    `req` chỉ cần các thuộc tính: pont_config, sheet_w, sheet_h, margin_left, margin_bottom.
    `mark_resolved=True` gắn cờ nội bộ sau khi xác minh hết va chạm, để worker không
    trích contour và chạy cùng phép tính lần thứ hai.
    """
    pc = getattr(req, 'pont_config', None)
    if (not placements or not pc or pc.get('disableCollision', False)
            or not getattr(req, 'sheet_w', None) or not getattr(req, 'sheet_h', None)):
        return placements
    try:
        from app.workers.pont_collision import (
            MM_TO_PTS, _has_any_sticker_overlap, calculate_forbidden_zones,
            detect_collisions, smart_resolve_collisions,
        )
        sheet_w = req.sheet_w
        sheet_h = req.sheet_h
        m_left_pt = getattr(req, 'margin_left', 0) or 0
        m_bottom_pt = getattr(req, 'margin_bottom', 0) or 0
        # margins KHỚP nup_process_chunk: top/bottom mặc định margin_bottom; left/right mặc định margin_left.
        margins = {
            'top': pc.get('marginTop') * MM_TO_PTS if pc.get('marginTop') is not None else m_bottom_pt,
            'bottom': pc.get('marginBottom') * MM_TO_PTS if pc.get('marginBottom') is not None else m_bottom_pt,
            'left': pc.get('marginLeft') * MM_TO_PTS if pc.get('marginLeft') is not None else m_left_pt,
            'right': pc.get('marginRight') * MM_TO_PTS if pc.get('marginRight') is not None else m_left_pt,
        }
        zones = calculate_forbidden_zones(pc, margins, sheet_w, sheet_h)
        if not zones:
            return placements
        base_rect_pts = (0, 0, placements[0]['width'], placements[0]['height'])
        if base_poly is not None:
            base_rect_pts = base_poly.bounds
        _has_col = detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h)
        try:
            _rot_audit_log.warning(
                "[ROT-AUDIT][COLLISION][PREVIEW] n_in=%d zones=%s base_poly_bounds=%s "
                "base_rect=%s sheet=%.1fx%.1f margins=%s collide=%s absXY_in=%s",
                len(placements),
                [tuple(round(z, 1) for z in zz) for zz in zones],
                (tuple(round(b, 1) for b in base_poly.bounds) if base_poly is not None else None),
                tuple(round(b, 1) for b in base_rect_pts), sheet_w, sheet_h,
                {k: round(v, 1) for k, v in margins.items()}, bool(_has_col),
                [(round(p['abs_x'], 1), round(p['abs_y'], 1)) for p in placements],
            )
        except Exception:
            pass
        if not _has_col:
            if mark_resolved and not _has_any_sticker_overlap(placements, base_poly):
                for placement in placements:
                    placement['_pont_collision_resolved'] = True
            return placements
        resolved = smart_resolve_collisions(placements, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
        try:
            _rot_audit_log.warning(
                "[ROT-AUDIT][COLLISION][PREVIEW] n_out=%d absXY_out=%s",
                len(resolved or []),
                [(round(p['abs_x'], 1), round(p['abs_y'], 1)) for p in (resolved or [])],
            )
        except Exception:
            pass
        result = resolved or placements
        if (
            mark_resolved
            and not detect_collisions(result, zones, base_poly, base_rect_pts, sheet_h)
            and not _has_any_sticker_overlap(result, base_poly)
        ):
            for placement in result:
                placement['_pont_collision_resolved'] = True
        return result
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Preview pont collision (abs) failed: {e}")
        return placements

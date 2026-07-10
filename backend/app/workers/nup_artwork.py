"""
Đặt artwork lên trang output — NGUỒN CHÂN LÝ DUY NHẤT cho việc render 1 ô.

Rút (extract) nguyên văn từ vòng lặp render của `nup_process_chunk.process_chunk`
để cả luồng Bình Tem Bế (process_chunk) lẫn công cụ Bình Bế Rớt CNC (cnc_render)
dùng CHUNG một logic đặt artwork — tránh phân kỳ kết quả về sau.

Hàm `place_one_artwork` xử lý cho MỘT placement:
- Tính trim_rect / bleed_rect / out_clip (bleed mép ngoài, nửa gap mép trong).
- Với die-cut: cache hình học, strip đường bế khỏi trang nguồn (khi tách trang khuôn),
  và đặt theo 4 biến thể xoay.
- Trả về `trim_rect` để caller tự bookkeeping (block_cuts…).
"""

import logging

from app.workers import pdf_wrapper as pdf_lib

logger = logging.getLogger(__name__)


def _die_channel_names_lower():
    """Tên kênh bế chuẩn (lowercase) — tái dùng cấu hình detection để nhất quán."""
    try:
        from app.workers.die_detection import DetectionConfig
        return frozenset(n.strip().lower() for n in DetectionConfig().die_channel_names)
    except Exception:
        return frozenset({"cutcontour", "dieline", "thru-cut", "kiss", "crease"})


def _spot_key(spot_name):
    """Chuẩn hoá tên spot → khoá so khớp (tập tên lowercase, tách '+' cho DeviceN)."""
    if not spot_name:
        return None
    parts = frozenset(s.strip().lower() for s in str(spot_name).split("+") if s.strip())
    return parts or None


def strip_color_from_stream(page_or_xobj, target_color, die_names_lower=None, target_spot=None):
    """Strip CHỈ nét vẽ của ĐƯỜNG BẾ khỏi content stream (khi tách trang khuôn).

    Nét bị xoá khi: (a) màu stroke KHỚP `target_color` (màu đường bế đã nhận diện),
    HOẶC (b) tên kênh spot của nét KHỚP kênh bế chuẩn (CutContour/Dieline/...),
    HOẶC (c) tên kênh spot KHỚP `target_spot` — spot bế THẬT đã nhận diện của CHÍNH
    file này (kể cả tên lạ ngoài danh sách chuẩn).

    Vì sao cần (c): file tạo SẴN đường cắt có thể dùng spot tên riêng (theo RIP/xưởng)
    KHÔNG nằm trong danh sách chuẩn → chỉ (b) sẽ trượt → khuôn còn sót trên trang in
    dù đã tách trang khuôn (bug 2026-07-08). Detection đã biết spot bế thật → truyền
    vào đây để strip đúng của từng file.

    KHÔNG xoá "mọi nét spot" như bản rất cũ: nét spot trang trí của artwork (viền
    Pantone, đường UV) có tên KHÁC spot bế → được GIỮ (bảo toàn nội dung 2026-07-07).
    """
    import pikepdf
    try:
        stream = pikepdf.parse_content_stream(page_or_xobj)
    except Exception as e:
        logger.debug(f"[_strip_color] Parse stream error: {e}", flush=True)
        return False

    if die_names_lower is None:
        die_names_lower = _die_channel_names_lower()

    target_spot_key = _spot_key(target_spot)

    # Resources để resolve tên CS operand (vd /CS0) → tên kênh spot thật.
    try:
        from app.workers.pdf_content_parser import _resolve_spot_name
        _resources = page_or_xobj.get('/Resources')
    except Exception:
        _resolve_spot_name = None
        _resources = None

    def _spot_of(cs_token):
        # Tên spot của colorspace đặt tên; None nếu là process/không resolve được.
        if _resolve_spot_name is None or _resources is None or not cs_token:
            return None
        try:
            return _resolve_spot_name(cs_token, _resources, None)
        except Exception:
            return None

    new_stream = []
    current_stroke_color = None   # tuple màu process, hoặc None
    current_stroke_spot = None    # tên kênh spot (chuỗi) nếu CS là Separation/DeviceN
    stack = []
    stripped = False

    for operands, operator in stream:
        op = str(operator)

        if op == 'q':
            stack.append((current_stroke_color, current_stroke_spot))
        elif op == 'Q':
            if stack:
                current_stroke_color, current_stroke_spot = stack.pop()
        elif op == 'CS':
            if operands:
                cs_name = str(operands[0])
                if cs_name not in ('/DeviceRGB', '/DeviceCMYK', '/DeviceGray', '/Pattern'):
                    current_stroke_spot = _spot_of(cs_name)
                    current_stroke_color = None
                else:
                    current_stroke_spot = None
                    current_stroke_color = None
        elif op in ('SCN', 'SC'):
            pass
        elif op in ('RG', 'K', 'G'):
            try:
                current_stroke_color = tuple(round(float(x), 3) for x in operands)
            except Exception:
                current_stroke_color = None
            current_stroke_spot = None

        if op in ('S', 's', 'B', 'B*', 'b', 'b*'):
            match = False
            # (b) tên spot khớp kênh bế chuẩn → chắc chắn là đường bế.
            if current_stroke_spot:
                from app.workers.die_detection import _match_die_channel
                if _match_die_channel(current_stroke_spot, die_names_lower):
                    match = True
                # (c) tên spot khớp spot bế THẬT đã nhận diện của file này (tên lạ
                # ngoài danh sách chuẩn vẫn strip đúng — file tạo sẵn đường cắt).
                if not match and target_spot_key:
                    if _spot_key(current_stroke_spot) == target_spot_key:
                        match = True
            # (a) màu khớp màu đường bế đã nhận diện (cho file bế bằng màu thuần,
            # không có kênh spot riêng — vd magenta quy ước VN).
            if not match and current_stroke_color and target_color:
                if len(current_stroke_color) == len(target_color):
                    match = True
                    for c1, c2 in zip(current_stroke_color, target_color):
                        if abs(c1 - c2) > 0.01:
                            match = False
                            break

            if match:
                stripped = True
                if op in ('S', 's'):
                    continue
                elif op == 'B':
                    operator = pikepdf.Operator('f')
                elif op == 'B*':
                    operator = pikepdf.Operator('f*')
                elif op == 'b':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('f')
                elif op == 'b*':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('f*')

        new_stream.append((operands, operator))

    if stripped:
        new_contents = pikepdf.unparse_content_stream(new_stream)
        if isinstance(page_or_xobj, pikepdf.Page):
            page_or_xobj.contents_coalesce()
            page_or_xobj.get('/Contents').write(new_contents)
        else:
            page_or_xobj.write(new_contents)
        return True
    return False


def compute_block_bbox(placements):
    """Bbox mỗi (cluster, block) theo toạ độ abs để xác định mép ngoài vs trong."""
    block_bbox = {}
    for _p in placements:
        _k = (_p['cluster_idx'], _p['cell'].get('blockId', 0))
        _x0 = _p['abs_x']
        _y0 = _p['original_cell_y']
        _x1 = _x0 + _p['width']
        _y1 = _y0 + _p['height']
        if _k not in block_bbox:
            block_bbox[_k] = [_x0, _y0, _x1, _y1]
        else:
            bb = block_bbox[_k]
            bb[0] = min(bb[0], _x0)
            bb[1] = min(bb[1], _y0)
            bb[2] = max(bb[2], _x1)
            bb[3] = max(bb[3], _y1)
    return block_bbox


def place_one_artwork(
    out_page,
    src_doc,
    p,
    *,
    bleed_pt,
    is_die_cut,
    cut_type,
    separate_cut_page,
    local_stripped_pages,
    job_id,
    diecut_geom_cache,
    die_items_cache,
    max_geom_cache,
    block_bbox,
    clip_off_x,
    clip_off_y,
    find_largest_die_path,
    mirror_x=False,
    mirror_y=False,
    homogeneous_clip=None,
    homogeneous_rect=None,
):
    """Đặt MỘT placement `p` lên `out_page`. Trả về (trim_rect, src_page_idx).

    Logic rút nguyên văn từ process_chunk — KHÔNG đổi hành vi.

    mirror_x / mirror_y: lật gương nội dung quanh tâm ô (cho Mặt sau bình bế 2 mặt).

    homogeneous_clip / homogeneous_rect (chế độ ĐỒNG NHẤT — sticker-homogeneous-nup):
    khi ``homogeneous_clip`` ≠ None → đi nhánh REGISTRATION: đặt artwork của trang nội
    dung bằng ``show_pdf_page(rect=khuôn ô, clip=bbox artwork, keep_proportion=True)``
    → bỏ lệch vị trí trên trang gốc + co khít + căn tâm vào khuôn. Khi None (mặc định)
    GIỮ NGUYÊN hành vi cũ.
    """
    cell = p['cell']
    cluster_idx = p['cluster_idx']
    src_page_idx = p['src_page_idx']
    src_page = src_doc[src_page_idx]
    cell_x = p['abs_x']
    cell_y = p['original_cell_y']

    # ── [ROT-AUDIT] Sự thật render: vị trí + cờ xoay thật khi đặt từng tem lên trang.
    try:
        from app.workers.rot_audit_log import get_logger as _rot_get_logger
        _rot_get_logger().warning(
            "[ROT-AUDIT][place][src=%d clu=%d] abs_x=%.1f original_cell_y=%.1f w=%.1f h=%.1f "
            "rot90=%d rot180=%d die_cut=%d mirror=(%d,%d)",
            src_page_idx, cluster_idx, cell_x, cell_y, cell['width'], cell['height'],
            int(cell.get('isRotated', False)), int(cell.get('isRotated180', False)),
            int(bool(is_die_cut)), int(bool(mirror_x)), int(bool(mirror_y)),
        )
    except Exception:
        pass

    trim_rect = pdf_lib.Rect(cell_x, cell_y, cell_x + cell['width'], cell_y + cell['height'])
    bleed_rect = pdf_lib.Rect(
        trim_rect.x0 - bleed_pt, trim_rect.y0 - bleed_pt,
        trim_rect.x1 + bleed_pt, trim_rect.y1 + bleed_pt,
    )

    # ── Chế độ ĐỒNG NHẤT: registration (căn-tâm + co-khít) — short-circuit ──
    # PHẢI đọc cờ xoay của ô: nesting có thể xoay tem để lồng khít khuôn (tem ngang
    # vào ô dọc → isRotated). show_pdf_page khi rotate%180≠0 tự HOÁN scale_x/scale_y
    # theo clip (dòng 342-350 pdf_ops) rồi keep_proportion lấy min → VỪA xoay VỪA
    # co-khít căn tâm đúng. Trước đây nhánh này bỏ qua rotate + chỉ keep_proportion
    # → tem ngang bị CO theo bề rộng ô dọc thay vì xoay (regression bình tem chung khuôn).
    if homogeneous_clip is not None:
        reg_rect = homogeneous_rect if homogeneous_rect is not None else trim_rect
        if cell.get('isRotated', False) and cell.get('isRotated180', False):
            _reg_rotate = 270
        elif cell.get('isRotated180', False):
            _reg_rotate = 180
        elif cell.get('isRotated', False):
            _reg_rotate = 90
        else:
            _reg_rotate = 0
        out_page.show_pdf_page(
            reg_rect, src_doc, src_page_idx,
            rotate=_reg_rotate,
            clip=homogeneous_clip, keep_proportion=True,
            mirror_x=mirror_x, mirror_y=mirror_y,
        )
        return trim_rect, src_page_idx

    # out_clip: bleed đầy ở mép ngoài block, nửa gap ở mép trong.
    _bb = block_bbox.get((cluster_idx, cell.get('blockId', 0)))
    if _bb is not None and bleed_pt > 0:
        _is_left = abs(trim_rect.x0 - _bb[0]) <= 0.5
        _is_right = abs(trim_rect.x1 - _bb[2]) <= 0.5
        _is_top = abs(trim_rect.y0 - _bb[1]) <= 0.5
        _is_bottom = abs(trim_rect.y1 - _bb[3]) <= 0.5
        _cx0 = trim_rect.x0 - (bleed_pt if _is_left else clip_off_x)
        _cx1 = trim_rect.x1 + (bleed_pt if _is_right else clip_off_x)
        _cy0 = trim_rect.y0 - (bleed_pt if _is_top else clip_off_y)
        _cy1 = trim_rect.y1 + (bleed_pt if _is_bottom else clip_off_y)
        cell_out_clip = pdf_lib.Rect(_cx0, _cy0, _cx1, _cy1)
    else:
        cell_out_clip = None

    if is_die_cut:
        cache_key = f"{job_id}_{src_page_idx}"
        largest_path = None
        if cache_key not in diecut_geom_cache:
            sx0, sy0, sx1, sy1 = src_page.rect
            largest_path = find_largest_die_path(src_page)
            if largest_path:
                r = largest_path['rect']
                tx0, ty0, tx1, ty1 = r.x0, r.y0, r.x1, r.y1
            else:
                tx0, ty0, tx1, ty1 = src_page.trimbox

            if len(diecut_geom_cache) >= max_geom_cache:
                diecut_geom_cache.pop(next(iter(diecut_geom_cache)))
                die_items_cache.pop(next(iter(die_items_cache)), None)

            diecut_geom_cache[cache_key] = (sx0, sy0, sx1, sy1, tx0, ty0, tx1, ty1)
            if largest_path:
                die_items_cache[cache_key] = {
                    'items': largest_path.get('items', []),
                    'rect': largest_path['rect'],
                    'color': largest_path.get('color', (0, 0, 0)),
                    'width': largest_path.get('width', 0.5),
                    # spot bế THẬT của file (tên có thể lạ, ngoài danh sách chuẩn) →
                    # truyền vào strip để gỡ đúng đường bế khi tách trang khuôn.
                    'spot_name': largest_path.get('spot_name'),
                }
            else:
                die_items_cache[cache_key] = None

        # Strip die-cut paths khỏi trang nguồn (để không in lên artwork khi tách trang khuôn)
        if (separate_cut_page or cut_type == 'one_dao') and src_page_idx not in local_stripped_pages:
            local_stripped_pages.add(src_page_idx)
            try:
                pike_page = src_doc._pdf.pages[src_page_idx]
                pike_page.contents_coalesce()
                _cached = die_items_cache.get(cache_key)
                local_target_color = _cached.get('color') if _cached else None
                # Spot bế THẬT của file này (tên có thể lạ, ngoài danh sách chuẩn) →
                # truyền vào strip để xoá đúng đường bế kể cả file tạo sẵn đường cắt.
                local_target_spot = _cached.get('spot_name') if _cached else None
                _stripped = False
                contents = pike_page.get('/Contents')
                if contents is not None:
                    try:
                        # CHỈ dùng parser chính xác (theo màu bế + tên kênh spot chuẩn).
                        # ĐÃ BỎ regex _PAT_A/_PAT_B: chúng xoá mọi khối q..CS..Q nên cắt
                        # nhầm cả họa tiết artwork vẽ trong colorspace đặt tên (ICCBased/
                        # Separation) → mất nét thiết kế (audit bảo toàn nội dung 2026-07-07).
                        if strip_color_from_stream(pike_page, local_target_color, target_spot=local_target_spot):
                            _stripped = True
                    except Exception as e_c:
                        logger.debug(f"[STRIP_DIECUT] page={src_page_idx} content strip error: {e_c}", flush=True)
                try:
                    import pikepdf
                    resources = pike_page.get('/Resources')
                    if resources:
                        xobjects = resources.get('/XObject')
                        if xobjects:
                            for name, xobj in xobjects.items():
                                try:
                                    xobj_resolved = xobj
                                    subtype = str(xobj_resolved.get('/Subtype', ''))
                                    if '/Form' in subtype:
                                        # Chỉ parser chính xác (đã bỏ regex quá rộng — xem trên).
                                        if strip_color_from_stream(xobj_resolved, local_target_color, target_spot=local_target_spot):
                                            _stripped = True
                                except Exception:
                                    pass
                except Exception as e_xo:
                    logger.debug(f"[STRIP_DIECUT] page={src_page_idx} XObject scan error: {e_xo}", flush=True)
            except Exception as e:
                logger.debug(f"[STRIP_DIECUT] page={src_page_idx} FAILED: {e}", flush=True)

        sx0, sy0, sx1, sy1, tx0, ty0, tx1, ty1 = diecut_geom_cache[cache_key]
        vis_w = sx1 - sx0
        vis_h = sy1 - sy0
        rel_tx0 = tx0 - sx0
        rel_ty0 = ty0 - sy0
        rel_tx1 = tx1 - sx0
        rel_ty1 = ty1 - sy0

        # target_rect map CẢ trang nguồn lên (vis = page rect), die box căn vào trim_rect
        # → nội dung NGOÀI đường bế (crop-mark, color-bar, slug ở lề MediaBox) vẽ tràn
        # quanh tem, ĐÈ tem hàng xóm khi xếp lồng sát. Clip vùng vẽ về quanh tem + bleed:
        # cell_out_clip (bleed mép ngoài block, nửa gap mép trong) hoặc bleed_rect (fallback).
        # out_clip chỉ giới hạn vùng trên trang ĐÍCH, KHÔNG đổi scale/vị trí → hình học giữ
        # nguyên (audit bảo toàn nội dung 2026-07-07). GIỚI HẠN: clip là bbox chữ nhật, tem
        # hình lồng phức tạp vẫn có thể chồng nhẹ ở vùng bleed — nhưng marks/slug ở xa bị loại hẳn.
        _die_clip = cell_out_clip if cell_out_clip is not None else bleed_rect

        if cell.get('isRotated', False) and cell.get('isRotated180', False):
            shift_x = trim_rect.x0 - (vis_h - rel_ty1)
            shift_y = trim_rect.y0 - rel_tx0
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_h, shift_y + vis_w)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, rotate=270, out_clip=_die_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        elif cell.get('isRotated180', False):
            shift_x = trim_rect.x0 - (vis_w - rel_tx1)
            shift_y = trim_rect.y0 - (vis_h - rel_ty1)
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_w, shift_y + vis_h)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, rotate=180, out_clip=_die_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        elif cell.get('isRotated', False):
            shift_x = trim_rect.x0 - rel_ty0
            shift_y = trim_rect.y0 - (vis_w - rel_tx1)
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_h, shift_y + vis_w)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, rotate=90, out_clip=_die_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        else:
            shift_x = trim_rect.x0 - rel_tx0
            shift_y = trim_rect.y0 - rel_ty0
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_w, shift_y + vis_h)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, out_clip=_die_clip, mirror_x=mirror_x, mirror_y=mirror_y)
    else:
        if cell.get('isRotated', False) and cell.get('isRotated180', False):
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, rotate=270, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        elif cell.get('isRotated180', False):
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, rotate=180, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        elif cell.get('isRotated', False):
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, rotate=90, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        else:
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)

    return trim_rect, src_page_idx


def transform_die_point(px, py, die_rect, abs_x, abs_y, is_rotated=False, is_rotated_180=False):
    """NGUỒN CHÂN LÝ DUY NHẤT cho phép biến đổi 1 điểm đường bế (vị trí + xoay).

    Dùng CHUNG bởi: draw_die_lines_for_placement (render file xuất) và preview
    (/preview-layout) → preview KHÔNG reimplement hình học → không thể lệch output.

    Toạ độ vào (px,py) theo hệ trang nguồn; ra theo hệ trang đích TOP-DOWN mà
    cut_shape/show_pdf_page tiêu thụ (y0 nhỏ = TRÊN).
    """
    if is_rotated and is_rotated_180:
        return (abs_x + (die_rect.y1 - py), abs_y + px - die_rect.x0)
    elif is_rotated_180:
        return (abs_x + (die_rect.x1 - px), abs_y + (die_rect.y1 - py))
    elif is_rotated:
        return (abs_x + (py - die_rect.y0), abs_y + (die_rect.x1 - px))
    else:
        return (abs_x + (px - die_rect.x0), abs_y + (py - die_rect.y0))


def die_polylines_for_placement(die_items, die_rect, abs_x, abs_y,
                                is_rotated=False, is_rotated_180=False, bezier_steps=10):
    """Trả list polyline (mỗi polyline = list điểm [x,y] toạ độ trang đích TOP-DOWN),
    dùng CHÍNH transform_die_point như render file xuất. Bezier được lấy mẫu thành
    đoạn thẳng để frontend chỉ việc vẽ polyline (không cần engine bezier)."""
    def T(px, py):
        return list(transform_die_point(px, py, die_rect, abs_x, abs_y, is_rotated, is_rotated_180))
    out = []
    for item in die_items:
        cmd = item[0]
        if cmd == 'l':
            p1 = pdf_lib.Point(item[1]); p2 = pdf_lib.Point(item[2])
            out.append([T(p1.x, p1.y), T(p2.x, p2.y)])
        elif cmd == 'c':
            pts = [pdf_lib.Point(item[i]) for i in range(1, 5)]
            samp = []
            for k in range(bezier_steps + 1):
                t = k / bezier_steps; mt = 1 - t
                bx = mt**3*pts[0].x + 3*mt*mt*t*pts[1].x + 3*mt*t*t*pts[2].x + t**3*pts[3].x
                by = mt**3*pts[0].y + 3*mt*mt*t*pts[1].y + 3*mt*t*t*pts[2].y + t**3*pts[3].y
                samp.append(T(bx, by))
            out.append(samp)
        elif cmd == 're':
            r = pdf_lib.Rect(item[1])
            out.append([T(r.x0, r.y0), T(r.x1, r.y0), T(r.x1, r.y1), T(r.x0, r.y1), T(r.x0, r.y0)])
        elif cmd == 'qu':
            quad = item[1]
            qp = [pdf_lib.Point(quad.ul), pdf_lib.Point(quad.ur),
                  pdf_lib.Point(quad.lr), pdf_lib.Point(quad.ll)]
            out.append([T(p.x, p.y) for p in qp] + [T(qp[0].x, qp[0].y)])

    # ── [DIE-GEO] Log hình học đường bế PREVIEW (toạ độ cuối) để so với file bế xuất.
    try:
        from app.workers.rot_audit_log import get_logger as _rg
        _pts = [pt for pl in out for pt in pl]
        if _pts:
            _xs = [p[0] for p in _pts]; _ys = [p[1] for p in _pts]
            _rg().warning(
                "[DIE-GEO][PREVIEW] abs=(%.1f,%.1f) die_rect=(%.1f,%.1f,%.1f,%.1f) rot90=%d rot180=%d "
                "n_pl=%d bbox=(%.1f,%.1f,%.1f,%.1f)",
                abs_x, abs_y, die_rect.x0, die_rect.y0, die_rect.x1, die_rect.y1,
                int(is_rotated), int(is_rotated_180), len(out),
                min(_xs), min(_ys), max(_xs), max(_ys),
            )
    except Exception:
        pass
    return out


def draw_die_lines_for_placement(
    cut_shape,
    die_items,
    die_rect,
    abs_x,
    abs_y,
    is_rotated=False,
    is_rotated_180=False,
):
    """Vẽ đường bế của MỘT ô lên `cut_shape`, transform theo vị trí + xoay.

    Dùng CHUNG transform_die_point với preview (/preview-layout) → một nguồn chân lý.
    Caller tự gọi cut_shape.finish/commit.
    """
    def _T(px, py):
        x, y = transform_die_point(px, py, die_rect, abs_x, abs_y, is_rotated, is_rotated_180)
        return pdf_lib.Point(x, y)

    # ── [DIE-GEO] Log hình học đường bế RENDER (file bế xuất) — CÙNG toạ độ với PREVIEW?
    try:
        from app.workers.rot_audit_log import get_logger as _rg
        _pls = die_polylines_for_placement(die_items, die_rect, abs_x, abs_y, is_rotated, is_rotated_180)
        _pts = [pt for pl in _pls for pt in pl]
        if _pts:
            _xs = [p[0] for p in _pts]; _ys = [p[1] for p in _pts]
            _rg().warning(
                "[DIE-GEO][RENDER] abs=(%.1f,%.1f) die_rect=(%.1f,%.1f,%.1f,%.1f) rot90=%d rot180=%d "
                "n_pl=%d bbox=(%.1f,%.1f,%.1f,%.1f)",
                abs_x, abs_y, die_rect.x0, die_rect.y0, die_rect.x1, die_rect.y1,
                int(is_rotated), int(is_rotated_180), len(_pls),
                min(_xs), min(_ys), max(_xs), max(_ys),
            )
    except Exception:
        pass

    for item in die_items:
        cmd = item[0]

        if cmd == 'l':  # line: (cmd, p1, p2)
            p1 = pdf_lib.Point(item[1])
            p2 = pdf_lib.Point(item[2])
            cut_shape.draw_line(_T(p1.x, p1.y), _T(p2.x, p2.y))

        elif cmd == 'c':  # cubic bezier: (cmd, p1, p2, p3, p4)
            pts = [pdf_lib.Point(item[i]) for i in range(1, 5)]
            transformed = [_T(pt.x, pt.y) for pt in pts]
            cut_shape.draw_bezier(transformed[0], transformed[1], transformed[2], transformed[3])

        elif cmd == 're':  # rect: (cmd, rect) — dựng lại từ 4 góc đã transform (bằng KQ cũ)
            r = pdf_lib.Rect(item[1])
            corners = [_T(r.x0, r.y0), _T(r.x1, r.y0), _T(r.x1, r.y1), _T(r.x0, r.y1)]
            xs = [c.x for c in corners]; ys = [c.y for c in corners]
            cut_shape.draw_rect(pdf_lib.Rect(min(xs), min(ys), max(xs), max(ys)))

        elif cmd == 'qu':  # quad: (cmd, Quad(ul, ur, ll, lr))
            quad = item[1]
            quad_pts = [pdf_lib.Point(quad.ul), pdf_lib.Point(quad.ur),
                        pdf_lib.Point(quad.lr), pdf_lib.Point(quad.ll)]
            transformed = [_T(pt.x, pt.y) for pt in quad_pts]
            for qi in range(4):
                cut_shape.draw_line(transformed[qi], transformed[(qi + 1) % 4])

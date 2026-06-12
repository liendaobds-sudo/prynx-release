"""
one_dao_cut.py — Tạo đường cắt "1 Dao LETA" cho bế tem.

Logic port từ hàm drawOneDaoCutLines() trong Illustrator JSX script.
Nguyên lý:
  - Với mỗi hàng tem cùng Y → tạo đường cắt ngang (H segment)
  - Với mỗi cột tem cùng X → tạo đường cắt dọc (V segment)
  - Gom các tem kề nhau thành 1 segment liên tục
  - Kéo dài ra ngoài (bleed_pt) tại cạnh ngoài cùng
  - Kéo dài thêm OVERLAP_PT tại giao điểm nội (giữa các tem) nếu an toàn
"""

from app.workers import pdf_wrapper as pdf_lib

# Hằng số
CUT_LINE_TOLERANCE = 0.5  # pt — dung sai khi so sánh tọa độ
OVERLAP_PT = 2.0          # pt (~0.7mm) — lùi ra tại giao điểm nội


def _bbox_overlap_item(seg_type, fixed_coord, end_coord, direction, overlap_amt, all_rects):
    """Kiểm tra nếu lùi dầu segment sẽ xuyên vào bên trong 1 tem."""
    if seg_type == 'H':
        test_x = end_coord + direction * overlap_amt
        test_y = fixed_coord
        for r in all_rects:
            if r['minX'] + 1 < test_x < r['maxX'] - 1 and r['minY'] + 1 < test_y < r['maxY'] - 1:
                return True
    else:  # 'V'
        test_x = fixed_coord
        test_y = end_coord + direction * overlap_amt
        for r in all_rects:
            if r['minX'] + 1 < test_x < r['maxX'] - 1 and r['minY'] + 1 < test_y < r['maxY'] - 1:
                return True
    return False


def generate_one_dao_cut_segments(placements, gap_x, gap_y, bleed_pt):
    """
    Tính toán các đoạn đường cắt 1 Dao từ danh sách placements.

    Args:
        placements: list of dict với keys: abs_x, abs_y, width, height
                    (tọa độ PDF: abs_x = left, abs_y = top trong hệ tọa độ PDF)
        gap_x: khoảng cách ngang giữa các tem (pt)
        gap_y: khoảng cách dọc giữa các tem (pt)
        bleed_pt: lùi bleed tại cạnh ngoài cùng (pt)

    Returns:
        List[dict] — mỗi dict là một đoạn cut:
            {type: 'H'|'V', fixed: float, start: float, end: float}
    """
    if not placements:
        return []

    # Chuyển placements → bounding rects (minX, maxX, minY, maxY)
    item_rects = []
    for p in placements:
        x = p['abs_x']
        y = p['abs_y']  # top-left trong PDF coords
        w = p['width']
        h = p['height']
        item_rects.append({
            'minX': x,
            'maxX': x + w,
            'minY': y,
            'maxY': y + h,
        })

    if not item_rects:
        return []

    # Overall bounding box
    overall_min_x = min(r['minX'] for r in item_rects)
    overall_max_x = max(r['maxX'] for r in item_rects)
    overall_min_y = min(r['minY'] for r in item_rects)
    overall_max_y = max(r['maxY'] for r in item_rects)

    # ── Bước 1: Thu thập tất cả Y tọa độ (top/bottom của mỗi tem) ──
    y_coords: dict[str, list] = {}
    for r in item_rects:
        for y_key in [f"{r['minY']:.3f}", f"{r['maxY']:.3f}"]:
            if y_key not in y_coords:
                y_coords[y_key] = []
            y_coords[y_key].append(r)

    # ── Bước 2: Thu thập tất cả X tọa độ (left/right) ──
    x_coords: dict[str, list] = {}
    for r in item_rects:
        for x_key in [f"{r['minX']:.3f}", f"{r['maxX']:.3f}"]:
            if x_key not in x_coords:
                x_coords[x_key] = []
            x_coords[x_key].append(r)

    raw_segments = []

    # ── Bước 3: Tạo H-segments (đường ngang) ──
    for y_key, rects in y_coords.items():
        y_val = float(y_key)
        rects_sorted = sorted(rects, key=lambda r: r['minX'])
        block_start = rects_sorted[0]['minX']
        block_end = rects_sorted[0]['maxX']
        for i in range(1, len(rects_sorted)):
            prev = rects_sorted[i - 1]
            curr = rects_sorted[i]
            if curr['minX'] < prev['maxX'] + gap_x + CUT_LINE_TOLERANCE:
                block_end = max(block_end, curr['maxX'])
            else:
                raw_segments.append({'type': 'H', 'fixed': y_val, 'start': block_start, 'end': block_end})
                block_start = curr['minX']
                block_end = curr['maxX']
        raw_segments.append({'type': 'H', 'fixed': y_val, 'start': block_start, 'end': block_end})

    # ── Bước 4: Tạo V-segments (đường dọc) ──
    for x_key, rects in x_coords.items():
        x_val = float(x_key)
        rects_sorted = sorted(rects, key=lambda r: r['minY'])
        block_start = rects_sorted[0]['minY']
        block_end = rects_sorted[0]['maxY']
        for i in range(1, len(rects_sorted)):
            prev = rects_sorted[i - 1]
            curr = rects_sorted[i]
            if curr['minY'] < prev['maxY'] + gap_y + CUT_LINE_TOLERANCE:
                block_end = max(block_end, curr['maxY'])
            else:
                raw_segments.append({'type': 'V', 'fixed': x_val, 'start': block_start, 'end': block_end})
                block_start = curr['minY']
                block_end = curr['maxY']
        raw_segments.append({'type': 'V', 'fixed': x_val, 'start': block_start, 'end': block_end})

    # ── Bước 5: Dedup segments ──
    seen = set()
    unique_segs = []
    for s in raw_segments:
        s_start, s_end = min(s['start'], s['end']), max(s['start'], s['end'])
        key = f"{s['type']}_{s['fixed']:.3f}_{s_start:.3f}_{s_end:.3f}"
        if key not in seen:
            seen.add(key)
            unique_segs.append({'type': s['type'], 'fixed': s['fixed'],
                                 'start': s_start, 'end': s_end})

    # ── Bước 6: Tính bleed/overlap cho từng đầu segment ──
    final_segments = []
    for seg in unique_segs:
        t = seg['type']
        fixed = seg['fixed']
        start = seg['start']
        end = seg['end']

        bleed_start = 0.0
        bleed_end = 0.0

        if t == 'H':
            # Đầu start (trái)
            if abs(start - overall_min_x) <= CUT_LINE_TOLERANCE:
                bleed_start = bleed_pt
            elif not _bbox_overlap_item('H', fixed, start, -1, OVERLAP_PT, item_rects):
                bleed_start = OVERLAP_PT
            # Đầu end (phải)
            if abs(end - overall_max_x) <= CUT_LINE_TOLERANCE:
                bleed_end = bleed_pt
            elif not _bbox_overlap_item('H', fixed, end, +1, OVERLAP_PT, item_rects):
                bleed_end = OVERLAP_PT
        else:  # 'V'
            # Đầu start (trên trong PDF coords = minY)
            if abs(start - overall_min_y) <= CUT_LINE_TOLERANCE:
                bleed_start = bleed_pt
            elif not _bbox_overlap_item('V', fixed, start, -1, OVERLAP_PT, item_rects):
                bleed_start = OVERLAP_PT
            # Đầu end (dưới = maxY)
            if abs(end - overall_max_y) <= CUT_LINE_TOLERANCE:
                bleed_end = bleed_pt
            elif not _bbox_overlap_item('V', fixed, end, +1, OVERLAP_PT, item_rects):
                bleed_end = OVERLAP_PT

        final_segments.append({
            'type': t,
            'fixed': fixed,
            'start': start - bleed_start,
            'end': end + bleed_end,
        })

    return final_segments


def draw_one_dao_cuts(page, segments, color=(0, 0, 0), stroke_width=0.5, oc=None):
    """
    Vẽ tất cả đường cắt 1 Dao lên 1 trang PDF bằng pikepdf.

    Args:
        page: pdf_lib.Page đang được render
        segments: kết quả từ generate_one_dao_cut_segments()
        color: tuple (r, g, b) — mặc định K100 (0,0,0)
        stroke_width: độ dày nét cắt tính bằng pt
    """
    if not segments:
        return

    shape = page.new_shape()
    for seg in segments:
        if seg['type'] == 'H':
            shape.draw_line(
                pdf_lib.Point(seg['start'], seg['fixed']),
                pdf_lib.Point(seg['end'], seg['fixed'])
            )
        else:
            shape.draw_line(
                pdf_lib.Point(seg['fixed'], seg['start']),
                pdf_lib.Point(seg['fixed'], seg['end'])
            )
    shape.finish(color=color, width=stroke_width, oc=oc)
    shape.commit()

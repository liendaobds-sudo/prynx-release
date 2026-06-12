"""
PDF Object Manipulation Helpers.

Pure functions for manipulating PDF objects (text, images, vectors)
via pikepdf's content stream API. Extracted from preflight routes
for testability and reuse.
"""

import re
import logging
import pikepdf
from typing import List

logger = logging.getLogger(__name__)


def expand_bbox(bbox: list, pad: float = 1.0):
    """Expand bbox by `pad` points on each side to compensate for
    floating-point precision loss during JSON serialization round-trip.
    Returns a [x0, y0, x1, y1] list."""
    x0, y0, x1, y1 = bbox
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]


def merge_rects(rects, gap=2.0):
    """
    Merges strictly overlapping or identical bounding boxes to avoid creating
    a single giant blob when a background vector exists.
    """
    if not rects:
        return []
    # Filter out degenerate rects
    valid = [[x0, y0, x1, y1] for x0, y0, x1, y1 in rects if x1 > x0 and y1 > y0]
    if not valid:
        return []
        
    # If there are too many vector objects, limit to the 1000 largest to avoid O(N^2) timeout
    if len(valid) > 1000:
        valid.sort(key=lambda r: (r[2]-r[0])*(r[3]-r[1]), reverse=True)
        valid = valid[:1000]
    
    # Sort by area ASCENDING so we cluster small details first
    valid.sort(key=lambda r: (r[2]-r[0])*(r[3]-r[1]))
    
    merged = []
    used = [False] * len(valid)
    
    for i in range(len(valid)):
        if used[i]:
            continue
        cx0, cy0, cx1, cy1 = valid[i]
        c_area = (cx1 - cx0) * (cy1 - cy0)
        
        # We don't want to snowball backgrounds. 
        # Only merge things that are highly overlapping or completely contained.
        for j in range(i + 1, len(valid)):
            if used[j]:
                continue
            jx0, jy0, jx1, jy1 = valid[j]
            
            # Check overlap area
            ox0 = max(cx0, jx0)
            oy0 = max(cy0, jy0)
            ox1 = min(cx1, jx1)
            oy1 = min(cy1, jy1)
            
            if ox1 > ox0 and oy1 > oy0:
                o_area = (ox1 - ox0) * (oy1 - oy0)
                j_area = (jx1 - jx0) * (jy1 - jy0)
                
                # Merge if the overlap is > 50% of the smaller object
                # AND they are roughly the same size (e.g., one is not more than 3x larger than the other)
                # This prevents giant backgrounds from swallowing tiny icons!
                min_area = min(c_area, j_area)
                max_area = max(c_area, j_area)
                if o_area > 0.5 * min_area and max_area <= 3 * min_area:
                    cx0 = min(cx0, jx0)
                    cy0 = min(cy0, jy0)
                    cx1 = max(cx1, jx1)
                    cy1 = max(cy1, jy1)
                    c_area = (cx1 - cx0) * (cy1 - cy0)
                    used[j] = True

        merged.append([cx0, cy0, cx1, cy1])
    return merged


def remove_text_from_stream(doc, page, text_objs, pad=5.0):
    """
    Surgically removes text (Tj blocks) from the PDF content stream by calculating
    the absolute page coordinates of each text span via the CTM and Tlm matrices.
    Works with pikepdf document and page objects.
    """
    if not text_objs:
        return False

    logger.info(f"--- BẮT ĐẦU XÓA TEXT ({len(text_objs)} objects) ---")
    for idx, o in enumerate(text_objs):
        logger.info(f"Target {idx}: BBOX={o.bbox}")

    # Get content stream
    contents = page.get("/Contents")
    if contents is None:
        return False

    # Read content stream bytes
    if isinstance(contents, pikepdf.Array):
        # Merge multiple streams into one
        stream_bytes = b""
        for item in contents:
            stream_bytes += item.read_bytes()
    else:
        stream_bytes = contents.read_bytes()
    
    stream = stream_bytes.decode('latin-1')
    
    # Get page height for coordinate transformation
    mb = page.get("/MediaBox")
    if mb:
        page_height = float(mb[3]) - float(mb[1])
    else:
        page_height = 842  # A4 fallback

    bt_matches = list(re.finditer(r'\bBT\b(.*?)\bET\b', stream, re.DOTALL))
    ops = list(re.finditer(r'([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+cm|\bq\b|\bQ\b', stream))

    def mult_matrix(m1, m2):
        a = m1[0]*m2[0] + m1[1]*m2[2]
        b = m1[0]*m2[1] + m1[1]*m2[3]
        c = m1[2]*m2[0] + m1[3]*m2[2]
        d = m1[2]*m2[1] + m1[3]*m2[3]
        e = m1[4]*m2[0] + m1[5]*m2[2] + m2[4]
        f = m1[4]*m2[1] + m1[5]*m2[3] + m2[5]
        return [a, b, c, d, e, f]
        
    def apply_matrix(pt, m):
        x = pt[0]*m[0] + pt[1]*m[2] + m[4]
        y = pt[0]*m[1] + pt[1]*m[3] + m[5]
        return [x, y]

    stack = []
    ctm = [1, 0, 0, 1, 0, 0]
    bt_idx = 0
    op_idx = 0
    
    new_stream = stream
    offset_diff = 0
    removed_any = False

    while bt_idx < len(bt_matches):
        bt = bt_matches[bt_idx]
        while op_idx < len(ops) and ops[op_idx].start() < bt.start():
            op = ops[op_idx]
            match_str = op.group(0)
            if match_str == 'q':
                stack.append(list(ctm))
            elif match_str == 'Q':
                if stack:
                    ctm = stack.pop()
            else:
                m = [float(op.group(i)) for i in range(1, 7)]
                ctm = mult_matrix(m, ctm)
            op_idx += 1
            
        bt_content = bt.group(1)
        text_ops = re.finditer(r'([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+Tm|([\d.-]+)\s+([\d.-]+)\s+Td|(\(.*?\)|\\<.*?\\>)\s*Tj', bt_content)
        
        tm = [1, 0, 0, 1, 0, 0]
        tlm = [1, 0, 0, 1, 0, 0]
        
        tj_to_remove = []
        
        for op in text_ops:
            match_str = op.group(0)
            if match_str.endswith('Tm'):
                tm = [float(op.group(i)) for i in range(1, 7)]
                tlm = list(tm)
            elif match_str.endswith('Td'):
                tx, ty = float(op.group(7)), float(op.group(8))
                new_e = tlm[0]*tx + tlm[2]*ty + tlm[4]
                new_f = tlm[1]*tx + tlm[3]*ty + tlm[5]
                tlm[4] = new_e
                tlm[5] = new_f
                tm = list(tlm)
            elif match_str.endswith('Tj'):
                abs_pt = apply_matrix([tm[4], tm[5]], ctm)
                page_x = abs_pt[0]
                page_y = page_height - abs_pt[1]
                
                # Check if this Tj falls inside ANY target_bbox
                for obj in text_objs:
                    target = obj.bbox
                    if (target[0] - pad <= page_x <= target[2] + pad and 
                        target[1] - pad <= page_y <= target[3] + pad):
                        tj_to_remove.append(op)
                        logger.info(f"[ĐÃ XÓA] Text tại X={page_x:.2f}, Y={page_y:.2f} | Nội dung: {match_str.encode('unicode_escape').decode('utf-8')}")
                        break

        if tj_to_remove:
            removed_any = True
            new_bt_content = bt_content
            for op in reversed(tj_to_remove):
                new_bt_content = new_bt_content[:op.start()] + new_bt_content[op.end():]
                
            start_idx = bt.start(1) + offset_diff
            end_idx = bt.end(1) + offset_diff
            new_stream = new_stream[:start_idx] + new_bt_content + new_stream[end_idx:]
            offset_diff += len(new_bt_content) - len(bt_content)
            
        bt_idx += 1

    if removed_any:
        # Write back the modified content stream
        new_stream_bytes = new_stream.encode('latin-1')
        if isinstance(contents, pikepdf.Array):
            # Replace with a single stream
            new_stream_obj = doc.make_stream(new_stream_bytes)
            page[pikepdf.Name("/Contents")] = new_stream_obj
        else:
            # Update existing stream
            contents.write(new_stream_bytes)
        return True
    return False

"""
cutline_geometry.py
====================
Hàm hình học thuần cho đường cắt (CutContour) của tính năng Tạo viền bế.

Tách riêng khỏi sticker_engine.py để:
  - Không phụ thuộc cv2/pdfium/shapely → unit test nhanh, không cần deps nặng.
  - Tập trung logic dễ sai nhất (vẽ contour theo kiểu góc) vào một chỗ.

Quy ước toạ độ: đầu vào theo gốc top-left (y tăng xuống — như ảnh raster),
xuất ra chuỗi lệnh PDF theo gốc bottom-left (y tăng lên) bằng phép lật
y_pdf = page_h - y.
"""
import math


def _coords_to_bezier_stream(coords, page_h, tension=0.33):
    """Vẽ contour KÍN bằng đường cong bezier (Catmull-Rom) — cho góc tròn (round).

    Tham số tension co giãn vector tiếp tuyến theo độ dài cạnh để tránh tạo
    "thắt nút" khi các điểm thưa/không đều.
    """
    if len(coords) < 3:
        return []
    pts = coords[:-1]  # bỏ điểm trùng cuối (contour kín)
    n = len(pts)
    stream = []
    y0_pdf = page_h - pts[0][1]
    stream.append(f"{pts[0][0]:.4f} {y0_pdf:.4f} m")
    for i in range(n):
        p_prev = pts[(i - 1) % n]
        p_curr = pts[i]
        p_next = pts[(i + 1) % n]
        p_next2 = pts[(i + 2) % n]

        seg_len = math.hypot(p_next[0] - p_curr[0], p_next[1] - p_curr[1])

        dx1 = p_next[0] - p_prev[0]
        dy1 = p_next[1] - p_prev[1]
        len1 = math.hypot(dx1, dy1) or 1.0

        dx2 = p_next2[0] - p_curr[0]
        dy2 = p_next2[1] - p_curr[1]
        len2 = math.hypot(dx2, dy2) or 1.0

        cp1_x = p_curr[0] + (dx1 / len1) * (seg_len * tension)
        cp1_y = page_h - (p_curr[1] + (dy1 / len1) * (seg_len * tension))

        cp2_x = p_next[0] - (dx2 / len2) * (seg_len * tension)
        cp2_y = page_h - (p_next[1] - (dy2 / len2) * (seg_len * tension))

        end_y = page_h - p_next[1]
        stream.append(
            f"{cp1_x:.4f} {cp1_y:.4f} {cp2_x:.4f} {cp2_y:.4f} {p_next[0]:.4f} {end_y:.4f} c"
        )
    stream.append("h")
    return stream


def _coords_to_polyline_stream(coords, page_h):
    """Vẽ contour KÍN bằng các ĐOẠN THẲNG — cho góc vuông/vát (square/bevel).

    KHÔNG làm mượt: giữ đúng đỉnh polygon đã buffer để góc ra đúng như yêu cầu.
    """
    if len(coords) < 3:
        return []
    pts = coords[:-1]
    stream = [f"{pts[0][0]:.4f} {page_h - pts[0][1]:.4f} m"]
    for x, y in pts[1:]:
        stream.append(f"{x:.4f} {page_h - y:.4f} l")
    stream.append("h")
    return stream


def build_contour_path_stream(coords, page_h, corner_style="round", tension=0.33):
    """Chọn cách vẽ contour theo kiểu góc.

    - 'round' → bezier mượt.
    - 'preserve' và các kiểu khác (square/bevel/mitre…) → đường thẳng giữ đúng đỉnh.
    """
    if corner_style == "round":
        return _coords_to_bezier_stream(coords, page_h, tension=tension)
    return _coords_to_polyline_stream(coords, page_h)

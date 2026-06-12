"""
CNC geometry helpers — phép lật gương (mirror) layout mặt sau cho công cụ Bình Bế Rớt (CNC).

Module THUẦN (không phụ thuộc PDF/FPDF) để có thể unit-test trực tiếp.

Mỗi "cell"/"item" là một dict có tối thiểu các khóa: 'x', 'y', 'width', 'height'.
Toạ độ tính theo gốc (0,0) ở góc dưới-trái vùng dùng được (usable area) của tờ in,
trục y hướng lên (giống hệ toạ độ PDF). 'x','y' là góc dưới-trái của ô.

Quy ước lật (theo thuật ngữ in 2 mặt chuẩn):
- 'long'  (lật cạnh dài / long-edge binding): lật NGANG quanh trục dọc giữa tờ.
            x' = W - (x + w);  y' = y
- 'short' (lật cạnh ngắn / short-edge binding): lật DỌC quanh trục ngang giữa tờ.
            x' = x;  y' = H - (y + h)

Sau khi lật, nội dung của ô cũng phải được phản chiếu (mirror) tương ứng để in
lật giấy thì bế 2 mặt trùng khít — biểu diễn bằng cờ 'mirrorX' / 'mirrorY'.
"""

from typing import Dict, List, Any

FlipEdge = str  # 'long' | 'short'

_W_KEYS = ("width", "w")
_H_KEYS = ("height", "h")


def _get(cell: Dict[str, Any], keys, default: float = 0.0) -> float:
    for k in keys:
        if k in cell and cell[k] is not None:
            return float(cell[k])
    return float(default)


def mirror_cell(
    cell: Dict[str, Any],
    usable_w: float,
    usable_h: float,
    flip_edge: FlipEdge = "long",
) -> Dict[str, Any]:
    """
    Trả về một cell MỚI là ảnh gương của `cell` trên vùng dùng được (usable_w x usable_h).

    - flip_edge == 'long'  → lật ngang: x' = W - (x + w), y giữ nguyên, bật cờ mirrorX.
    - flip_edge == 'short' → lật dọc:  y' = H - (y + h), x giữ nguyên, bật cờ mirrorY.

    Giữ nguyên mọi khóa khác của cell (width/height/isRotated/...).
    Không thay đổi cell gốc (trả về bản sao).
    """
    w = _get(cell, _W_KEYS)
    h = _get(cell, _H_KEYS)
    x = float(cell.get("x", 0.0))
    y = float(cell.get("y", 0.0))

    out = dict(cell)  # shallow copy, giữ mọi khóa khác

    if flip_edge == "short":
        out["x"] = x
        out["y"] = usable_h - (y + h)
        out["mirrorY"] = not bool(cell.get("mirrorY", False))
    else:  # 'long' (mặc định) hoặc giá trị lạ → fallback long
        out["x"] = usable_w - (x + w)
        out["y"] = y
        out["mirrorX"] = not bool(cell.get("mirrorX", False))

    return out


def mirror_layout(
    items: List[Dict[str, Any]],
    usable_w: float,
    usable_h: float,
    flip_edge: FlipEdge = "long",
) -> List[Dict[str, Any]]:
    """
    Lật gương cả layout mặt sau. Mỗi ô mặt sau khớp (đối xứng) ô mặt trước
    tương ứng để bế 2 mặt trùng nhau.

    Layout rỗng → trả về list rỗng (an toàn).
    """
    if not items:
        return []
    return [mirror_cell(c, usable_w, usable_h, flip_edge) for c in items]

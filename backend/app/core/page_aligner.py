"""
page_aligner.py — Căn trang theo NỘI DUNG (global alignment kiểu Needleman–Wunsch).

Mục tiêu: khi 2 file PDF lệch số trang (chèn/xoá trang), ghép ĐÚNG cặp trang theo
độ tương đồng thay vì ghép cứng theo vị trí → tránh "khác biệt giả dây chuyền"
(audit so-sánh #4).

Module này THUẦN: chỉ phụ thuộc stdlib + numpy (tuỳ chọn). KHÔNG phụ thuộc cv2 /
PDF để dễ unit-test. Phần render/đo tương đồng ảnh do caller (pipeline) cung cấp
qua callback `similarity(i, j)`.
"""
from typing import Callable, List, Optional, Tuple

# Cặp căn trang theo thứ tự xuất:
#   (i, j)    → A[i] ghép B[j]
#   (i, None) → A[i] KHÔNG có cặp (đã bị XOÁ ở B)
#   (None, j) → B[j] KHÔNG có cặp (được THÊM ở B)
AlignPair = Tuple[Optional[int], Optional[int]]


def align_pages(
    n_a: int,
    n_b: int,
    similarity: Callable[[int, int], float],
    match_bias: float = 0.5,
    gap_penalty: float = 0.0,
) -> List[AlignPair]:
    """Căn 2 chuỗi trang [0..n_a) và [0..n_b) bằng quy hoạch động (Needleman–Wunsch).

    Args:
        n_a, n_b: số trang của A và B.
        similarity(i, j): độ tương đồng A[i] vs B[j], trong [0, 1] (1 = giống hệt).
        match_bias: ngưỡng "đáng để ghép". Điểm ghép = similarity - match_bias, nên
            cặp có sim > match_bias mới được khuyến khích ghép; sim thấp hơn → coi là
            chèn/xoá (hai khoảng trống) thay vì ép ghép nhầm.
        gap_penalty: điểm cho một khoảng trống (chèn/xoá). Mặc định 0.

    Returns:
        Danh sách AlignPair theo thứ tự trang tăng dần.
    """
    if n_a < 0 or n_b < 0:
        raise ValueError("n_a, n_b phải >= 0")
    if n_a == 0 and n_b == 0:
        return []
    if n_a == 0:
        return [(None, j) for j in range(n_b)]
    if n_b == 0:
        return [(i, None) for i in range(n_a)]

    # score[i][j] = điểm tối ưu khi căn A[0..i) với B[0..j)
    score = [[0.0] * (n_b + 1) for _ in range(n_a + 1)]
    # back[i][j] = hướng truy vết: 'd' (ghép A[i-1]~B[j-1]), 'u' (xoá A[i-1]), 'l' (thêm B[j-1])
    back: List[List[Optional[str]]] = [[None] * (n_b + 1) for _ in range(n_a + 1)]

    for i in range(1, n_a + 1):
        score[i][0] = score[i - 1][0] + gap_penalty
        back[i][0] = "u"
    for j in range(1, n_b + 1):
        score[0][j] = score[0][j - 1] + gap_penalty
        back[0][j] = "l"

    for i in range(1, n_a + 1):
        for j in range(1, n_b + 1):
            sim = similarity(i - 1, j - 1)
            diag = score[i - 1][j - 1] + (sim - match_bias)
            up = score[i - 1][j] + gap_penalty       # A[i-1] không cặp (xoá)
            left = score[i][j - 1] + gap_penalty      # B[j-1] không cặp (thêm)
            best = max(diag, up, left)
            score[i][j] = best
            # Ưu tiên 'd' khi hoà để giữ ghép cặp (ổn định cho trang giống hệt).
            if best == diag:
                back[i][j] = "d"
            elif best == up:
                back[i][j] = "u"
            else:
                back[i][j] = "l"

    # Truy vết từ (n_a, n_b) về (0, 0)
    i, j = n_a, n_b
    out: List[AlignPair] = []
    while i > 0 or j > 0:
        b = back[i][j]
        if b == "d":
            out.append((i - 1, j - 1)); i -= 1; j -= 1
        elif b == "u":
            out.append((i - 1, None)); i -= 1
        else:
            out.append((None, j - 1)); j -= 1
    out.reverse()
    return out


def thumbnail_similarity(thumb_a, thumb_b) -> float:
    """Độ tương đồng 2 thumbnail xám CÙNG kích thước, dựa trên sai khác trung bình.

    Trả về 1 - MAD/255 (MAD = mean absolute difference), kẹp trong [0, 1].
    Đủ để phân biệt "cùng trang" vs "trang khác" cho bước căn; KHÔNG dùng để chấm
    điểm khác biệt chi tiết (việc đó do ImageComparator làm sau khi đã ghép cặp).
    """
    import numpy as np

    a = np.asarray(thumb_a, dtype=np.float32)
    b = np.asarray(thumb_b, dtype=np.float32)
    if a.shape != b.shape or a.size == 0:
        return 0.0
    mad = float(np.mean(np.abs(a - b)))
    sim = 1.0 - (mad / 255.0)
    return max(0.0, min(1.0, sim))


def normalize_text(s: str) -> str:
    """Chuẩn hoá chuỗi text trang cho so khớp căn trang: thường hoá, gộp khoảng trắng."""
    import re
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip().lower()


def text_similarity(a: str, b: str) -> float:
    """Độ tương đồng 2 chuỗi text (đã normalize) trong [0, 1] bằng difflib ratio.

    Dùng để CỦNG CỐ bước căn trang cho tài liệu nhiều chữ (nơi hình thu nhỏ dễ trông
    na ná nhau). Cả 2 rỗng → 1.0; chỉ một bên rỗng → 0.0.
    """
    import difflib
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()

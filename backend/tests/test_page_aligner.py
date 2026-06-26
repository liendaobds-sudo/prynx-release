"""Unit test cho căn trang thuần (page_aligner.align_pages).

Dùng ma trận tương đồng giả lập (không cần PDF/cv2) để khoá các kịch bản:
chèn / xoá / đảo / giống hệt / hoàn toàn khác / rỗng.
"""
from app.core.page_aligner import align_pages, thumbnail_similarity


def _sim_from_labels(labels_a, labels_b):
    """similarity(i,j) = 1.0 nếu nhãn trang trùng, ngược lại 0.0."""
    def sim(i, j):
        return 1.0 if labels_a[i] == labels_b[j] else 0.0
    return sim


def test_identical_sequences_pair_one_to_one():
    a = ["P1", "P2", "P3", "P4"]
    b = ["P1", "P2", "P3", "P4"]
    pairs = align_pages(len(a), len(b), _sim_from_labels(a, b))
    assert pairs == [(0, 0), (1, 1), (2, 2), (3, 3)]


def test_inserted_page_in_b_middle():
    # B chèn thêm 1 trang "X" ở giữa → các trang khác vẫn ghép đúng, X là (None, j).
    a = ["P1", "P2", "P3", "P4"]
    b = ["P1", "P2", "X", "P3", "P4"]
    pairs = align_pages(len(a), len(b), _sim_from_labels(a, b))
    assert pairs == [(0, 0), (1, 1), (None, 2), (2, 3), (3, 4)]


def test_deleted_page_from_a_middle():
    # A có P3 nhưng B không → P3 là (i, None).
    a = ["P1", "P2", "P3", "P4"]
    b = ["P1", "P2", "P4"]
    pairs = align_pages(len(a), len(b), _sim_from_labels(a, b))
    assert pairs == [(0, 0), (1, 1), (2, None), (3, 2)]


def test_inserted_at_start_and_end():
    a = ["P1", "P2"]
    b = ["X", "P1", "P2", "Y"]
    pairs = align_pages(len(a), len(b), _sim_from_labels(a, b))
    assert pairs == [(None, 0), (0, 1), (1, 2), (None, 3)]


def test_completely_different_no_forced_match():
    # Không trang nào giống nhau → tất cả là chèn/xoá, KHÔNG ép ghép cặp sai.
    a = ["A1", "A2"]
    b = ["B1", "B2"]
    pairs = align_pages(len(a), len(b), _sim_from_labels(a, b))
    # Không có cặp (i, j) nào có cả 2 != None
    assert all(p[0] is None or p[1] is None for p in pairs)
    a_idxs = sorted(p[0] for p in pairs if p[0] is not None)
    b_idxs = sorted(p[1] for p in pairs if p[1] is not None)
    assert a_idxs == [0, 1] and b_idxs == [0, 1]


def test_near_match_below_bias_treated_as_insert_delete():
    # sim = 0.3 < match_bias 0.5 → coi là khác (chèn/xoá), không ghép.
    pairs = align_pages(1, 1, lambda i, j: 0.3, match_bias=0.5)
    assert pairs == [(0, None), (None, 0)] or pairs == [(None, 0), (0, None)]


def test_near_match_above_bias_paired():
    pairs = align_pages(1, 1, lambda i, j: 0.8, match_bias=0.5)
    assert pairs == [(0, 0)]


def test_empty_inputs():
    assert align_pages(0, 0, lambda i, j: 1.0) == []
    assert align_pages(0, 2, lambda i, j: 1.0) == [(None, 0), (None, 1)]
    assert align_pages(3, 0, lambda i, j: 1.0) == [(0, None), (1, None), (2, None)]


def test_thumbnail_similarity_bounds():
    import numpy as np
    z = np.zeros((8, 8), np.uint8)
    w = np.full((8, 8), 255, np.uint8)
    assert thumbnail_similarity(z, z) == 1.0
    assert thumbnail_similarity(z, w) == 0.0
    assert 0.0 <= thumbnail_similarity(z, w // 2) <= 1.0
    # Khác kích thước → 0 (an toàn)
    assert thumbnail_similarity(np.zeros((8, 8)), np.zeros((4, 4))) == 0.0


# ── Text-hash fingerprint (củng cố căn trang cho tài liệu nhiều chữ) ──
from app.core.page_aligner import normalize_text, text_similarity


def test_normalize_text_collapses_and_lowercases():
    assert normalize_text("  Hello   WORLD\n\t x ") == "hello world x"
    assert normalize_text("") == ""
    assert normalize_text(None) == ""


def test_text_similarity_bounds_and_sense():
    assert text_similarity("", "") == 1.0
    assert text_similarity("abc", "") == 0.0
    assert text_similarity("hợp đồng số 123", "hợp đồng số 123") == 1.0
    # Gần giống → cao; khác hẳn → thấp
    assert text_similarity("hợp đồng số 123", "hợp đồng số 124") > 0.7
    assert text_similarity("trang điều khoản a", "bảng giá sản phẩm") < 0.5


def test_text_drives_alignment_when_visuals_ambiguous():
    """Mô phỏng: hình thu nhỏ na ná nhau (vis cao đều) nhưng TEXT phân biệt rõ →
    sim kết hợp giúp ghép đúng trang theo nội dung chữ."""
    txt_a = ["dieu khoan thanh toan", "bang gia san pham", "phu luc hop dong"]
    txt_b = ["bang gia san pham", "phu luc hop dong"]  # B thiếu trang 1 (xoá)

    def sim(i, j):
        vis = 0.9  # hình na ná nhau
        return 0.5 * vis + 0.5 * text_similarity(txt_a[i], txt_b[j])

    pairs = align_pages(len(txt_a), len(txt_b), sim)
    # Trang 0 của A (điều khoản thanh toán) không có ở B → (0, None); 1,2 ghép 1:1
    assert pairs == [(0, None), (1, 0), (2, 1)]

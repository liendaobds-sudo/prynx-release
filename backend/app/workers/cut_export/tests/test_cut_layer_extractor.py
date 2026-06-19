"""Test bộ trích đường cắt mạnh (Pha 6, task 16-17). Requirements: 10.1-10.7.

Fixture: corel_cut_sample.pdf — file print-and-cut thật, lớp cắt 'PL_SR_Cutline_Combined_1'
ở cấp trang (stroke), 75 con tem + 1 khung full-trang (phải bị loại).
"""

import os

import pytest

from app.workers.cut_export.cut_layer_extractor import (
    extract_cut_contours,
    ExtractConfig,
    _mat_mul,
    _apply,
    _name_matches,
    IDENTITY,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "corel_cut_sample.pdf")


def test_matches_cut_layer_not_marks():
    res = extract_cut_contours(FIXTURE, 0)
    assert "PL_SR_Cutline_Combined_1" in res.matched_layers
    # Lớp dấu định vị KHÔNG được khớp.
    assert not any("mark" in m.lower() for m in res.matched_layers)


def test_extracts_sticker_count_excluding_frame():
    res = extract_cut_contours(FIXTURE, 0)
    # 75 tem (đã loại khung full-trang). Không còn ra số nhỏ kiểu 4 ốc.
    assert len(res.contours) == 75
    assert all(c.closed for c in res.contours)


def test_no_full_page_frame_contour():
    res = extract_cut_contours(FIXTURE, 0)
    # Không có contour nào rộng gần bằng khổ trang.
    for c in res.contours:
        xs = [p[0] for p in c.points]
        ys = [p[1] for p in c.points]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        assert not (bw > 800 and bh > 1000), "khung full-trang chưa bị loại"


def test_layers_seen_includes_others():
    res = extract_cut_contours(FIXTURE, 0)
    # Thấy nhiều lớp nhưng chỉ KHỚP lớp cắt.
    assert "PL_SR_Artwork_Model_1" in res.layers_seen
    assert "Marks_Model_1" in res.layers_seen


def test_deterministic():
    a = extract_cut_contours(FIXTURE, 0)
    b = extract_cut_contours(FIXTURE, 0)
    assert len(a.contours) == len(b.contours)
    assert a.contours[0].points == b.contours[0].points


def test_no_match_returns_empty_not_guess():
    # Pattern rỗng → không khớp lớp nào → KHÔNG đoán liều (Req 10.6).
    cfg = ExtractConfig(cut_patterns=("__nope__",))
    res = extract_cut_contours(FIXTURE, 0, cfg)
    assert len(res.contours) == 0
    assert len(res.matched_layers) == 0


# ── Toán ma trận ──

def test_mat_mul_identity():
    assert _apply(_mat_mul(IDENTITY, IDENTITY), 3, 4) == (3.0, 4.0)


def test_mat_mul_order():
    scale = (2.0, 0.0, 0.0, 2.0, 0.0, 0.0)
    trans = (1.0, 0.0, 0.0, 1.0, 10.0, 20.0)
    # scale TRƯỚC rồi translate: (3,4)→(6,8)→(16,28)
    m = _mat_mul(scale, trans)
    assert _apply(m, 3, 4) == (16.0, 28.0)


def test_name_matches():
    assert _name_matches("PL_SR_Cutline_Combined_1", ("cutline",))
    assert not _name_matches("Marks_Model_1", ("cutline",))


# ── Spot-color CutContour (task 17.2) ──
SPOT_FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "corel_cut_spot_sample.pdf")


def test_spot_file_extracts_via_ocg_or_spot():
    # File có CẢ OCG cutline LẪN spot CutContour → vẫn ra đúng số tem (không nhân đôi).
    res = extract_cut_contours(SPOT_FIXTURE, 0)
    assert len(res.contours) == 64
    assert all(c.closed for c in res.contours)


def test_spot_color_strategy_independent():
    # pattern CHỈ 'cutcontour' → KHÔNG khớp OCG 'PL_SR_Cutline_Combined' (chứa 'cutline'),
    # nhưng KHỚP spot colorant 'CutContour' → chứng minh chiến lược spot-color độc lập.
    cfg = ExtractConfig(cut_patterns=("cutcontour",))
    res = extract_cut_contours(SPOT_FIXTURE, 0, cfg)
    assert len(res.matched_layers) == 0      # OCG không khớp
    assert len(res.contours) == 64           # nhưng spot-color vẫn bắt được


def test_spot_no_double_count():
    # Đảm bảo không đếm 2 lần khi path vừa ở OCG cut vừa dùng spot cut.
    res = extract_cut_contours(SPOT_FIXTURE, 0)
    assert len(res.contours) == 64


# ── Chọn lớp thủ công + liệt kê (task 18.2) ──
from app.workers.cut_export.cut_layer_extractor import list_cut_candidates


def test_list_cut_candidates():
    cands = list_cut_candidates(FIXTURE, 0)
    assert "PL_SR_Cutline_Combined_1" in cands["layers"]
    assert "PL_SR_Artwork_Model_1" in cands["layers"]
    assert "PL_SR_Cutline_Combined_1" in cands["auto_matched"]


def test_list_candidates_spot_file():
    cands = list_cut_candidates(SPOT_FIXTURE, 0)
    assert "CutContour" in cands["spots"]


def test_force_layer_override():
    # Ép đúng lớp cắt → 75.
    cfg = ExtractConfig(force_layer="PL_SR_Cutline_Combined_1", cut_patterns=("__none__",))
    res = extract_cut_contours(FIXTURE, 0, cfg)
    assert len(res.contours) == 75


def test_force_layer_picks_different_layer():
    # Ép lớp KHÁC (artwork) → ra số khác 75 (chứng minh override hoạt động theo lựa chọn).
    cfg = ExtractConfig(force_layer="PL_SR_Artwork_Model_1", cut_patterns=("__none__",))
    res = extract_cut_contours(FIXTURE, 0, cfg)
    # Lớp artwork có nội dung khác → contour count khác lớp cắt.
    assert len(res.contours) != 75

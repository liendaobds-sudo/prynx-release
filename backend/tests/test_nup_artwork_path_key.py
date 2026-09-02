"""Khoá hình học path item của nup_artwork — Lô A1b (audit 2026-08-28 §A1.2).

Bối cảnh: đường bế được nhận diện bằng cách so khoá hình học giữa tập nét mà
die detection đã chọn (``target_items``) và nét đang được vẽ trong content
stream (``current_path``). Hai bên tới từ hai producer khác nhau và dùng HAI
dạng dữ liệu khác nhau:

- ``pdf_content_parser`` dựng item bằng object ``Point``/``Rect``;
- ``strip_color_from_stream`` và manifest production dựng item bằng mảng số.

Trước bản vá, hàm khoá chỉ đọc được dạng object và **ném AttributeError** khi
nhận mảng số. Caller bọc lỗi đó thành "Không thể tách đường khuôn bế khỏi trang
in N", nên một job bình hợp lệ sẽ hỏng với thông điệp chỉ sai chỗ ngay khi lô
A2/A3 truyền contour từ manifest xuống.
"""

from __future__ import annotations

import pytest

from app.workers.nup_artwork import (
    _numeric_path_item_key,
    _path_item_key,
    _path_matches_target_items,
)
from app.workers.pdf_types import Point, Rect


def _obj_line(x1, y1, x2, y2):
    return ('l', Point(x1, y1), Point(x2, y2))


def _num_line(x1, y1, x2, y2):
    return ('l', x1, y1, x2, y2)


def _obj_curve():
    return (
        'c',
        Point(0.0, 0.0),
        Point(1.0, 2.0),
        Point(3.0, 4.0),
        Point(5.0, 6.0),
    )


def _num_curve():
    return ('c', 0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0)


@pytest.mark.parametrize(
    "obj_item,num_item",
    [
        (_obj_line(0.0, 0.0, 10.0, 0.0), _num_line(0.0, 0.0, 10.0, 0.0)),
        (_obj_curve(), _num_curve()),
        (('re', Rect(0.0, 0.0, 10.0, 5.0)), ('re', 0.0, 0.0, 10.0, 5.0)),
    ],
)
def test_hai_dang_du_lieu_cho_cung_mot_khoa(obj_item, num_item) -> None:
    """Dạng object và dạng mảng số phải sinh KHOÁ GIỐNG NHAU."""

    key_obj = _path_item_key(obj_item)
    key_num = _path_item_key(num_item)
    assert key_obj is not None
    assert key_obj == key_num
    # Hàm tên cũ giờ dùng chung một cách khoá, không còn đường lệch.
    assert _numeric_path_item_key(num_item) == key_obj
    assert _numeric_path_item_key(obj_item) == key_obj


def test_mang_so_khong_con_nem_loi() -> None:
    """Hồi quy trực tiếp: trước bản vá dòng này ném AttributeError."""

    assert _path_item_key(_num_line(0.0, 0.0, 10.0, 0.0)) == ('l', 0, 0, 100, 0)
    assert _path_item_key(('re', 0.0, 0.0, 10.0, 5.0)) == ('re', 0, 0, 100, 50)


def test_match_hoat_dong_du_target_o_dang_nao() -> None:
    """Nét bế phải được nhận diện dù target tới ở dạng object hay dạng số."""

    candidate = [_num_line(0.0, 0.0, 10.0, 0.0)]
    assert _path_matches_target_items(candidate, [_obj_line(0.0, 0.0, 10.0, 0.0)])
    assert _path_matches_target_items(candidate, [_num_line(0.0, 0.0, 10.0, 0.0)])


def test_khong_match_khi_candidate_co_net_ngoai_target() -> None:
    """Bất biến an toàn: nét lạ trong candidate phải chặn việc xoá."""

    target = [_obj_line(0.0, 0.0, 10.0, 0.0)]
    candidate = [
        _num_line(0.0, 0.0, 10.0, 0.0),
        _num_line(50.0, 50.0, 60.0, 60.0),
    ]
    assert not _path_matches_target_items(candidate, target)


def test_re_chuan_hoa_goc_doi_nen_thu_tu_khong_anh_huong() -> None:
    """Hai nguồn dựng rect theo thứ tự góc khác nhau vẫn cho cùng khoá."""

    assert _path_item_key(('re', 10.0, 5.0, 0.0, 0.0)) == _path_item_key(
        ('re', 0.0, 0.0, 10.0, 5.0)
    )


@pytest.mark.parametrize(
    "item",
    [
        (),
        None,
        ('l', 0.0, 0.0),                       # thiếu toạ độ
        ('l', 0.0, 0.0, 10.0, 0.0, 5.0),       # thừa toạ độ
        ('c', 0.0, 0.0, 1.0, 2.0),             # bezier thiếu điểm
        ('re', 0.0, 0.0, 10.0),                # rect thiếu góc
        ('re', Rect(0.0, 0.0, 10.0, 5.0), 1.0),  # rect kèm rác
        ('l', True, 0.0, 10.0, 0.0),           # boolean không phải toạ độ
        ('l', 0.0, 0.0, 10.0, None),           # None không phải toạ độ
        ('l', 0.0, 0.0, 10.0, "0"),            # chuỗi không phải toạ độ
        ('l', 0.0, 0.0, 10.0, float("nan")),   # NaN
        ('l', 0.0, 0.0, 10.0, float("inf")),   # Inf
        ('l', 0.0, 0.0, 10.0, object()),       # object không trải được
    ],
)
def test_du_lieu_khong_dang_tin_tra_none_chu_khong_nem(item) -> None:
    """Hàm nằm trong vòng quét mọi job bình: sai dữ liệu thì bỏ qua, không nổ."""

    assert _path_item_key(item) is None


def test_lenh_ngoai_l_c_re_giu_hanh_vi_cu() -> None:
    """Lệnh khác vẫn sinh khoá để nét lạ không bị bỏ khỏi phép so an toàn.

    Nếu lệnh lạ bị bỏ qua, ``_path_matches_target_items`` sẽ coi candidate là
    tập con của target và xoá cả nét không thuộc đường bế.
    """

    key = _path_item_key(('m', 1.0, 2.0))
    assert key == ('m', 10, 20)
    assert not _path_matches_target_items(
        [('m', 1.0, 2.0)], [_obj_line(0.0, 0.0, 10.0, 0.0)]
    )


def test_net_khong_khoa_duoc_thi_khong_xoa() -> None:
    """Bất biến an toàn: không hiểu nét thì giữ lại, không được xoá.

    Nếu nét lạ bị bỏ qua thay vì chặn, candidate sẽ trông như tập con của
    target và toán tử vẽ bị đổi thành no-op — mất artwork của khách.
    """

    target = [_obj_line(0.0, 0.0, 10.0, 0.0)]
    candidate = [
        _num_line(0.0, 0.0, 10.0, 0.0),
        ('l', 0.0, 0.0, 10.0, float("nan")),
    ]
    assert not _path_matches_target_items(candidate, target)

    # Chỉ khi MỌI nét đều khoá được và đều thuộc target thì mới được xoá.
    assert _path_matches_target_items([_num_line(0.0, 0.0, 10.0, 0.0)], target)

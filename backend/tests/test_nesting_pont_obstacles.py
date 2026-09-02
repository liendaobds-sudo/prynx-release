"""Hồi quy §NEST-AUD-03: ốc bế phải là VẬT CẢN, không chỉ là hình writer vẽ.

## Lỗi gốc

`fixed_obstacles` của job **luôn rỗng**, kể cả khi `disable_collision=False`. Ốc được map
đúng và writer vẽ đúng, nhưng solver không biết chúng tồn tại. Vì lề ốc (thường 7mm) **lớn
hơn** lề tờ (thường 5mm), ốc nằm trong vùng dùng được ⇒ tem được xếp đè lên dấu canh. Thợ
mất dấu canh là mất cả tờ.

Lane lưới đã có việc này từ lâu (`pont_collision.calculate_forbidden_zones`); lane nesting
chưa có bản tương ứng.

## Bất biến quan trọng nhất

**Vật cản phải nằm ĐÚNG chỗ writer vẽ ốc.** Lệch nhau là lỗi tệ nhất có thể: solver tránh
một vùng trống trong khi tem vẫn đè lên dấu canh thật, và không ai phát hiện tới khi in.
Nên `test_vat_can_trung_cho_writer_ve_oc` so trực tiếp hai công thức — một ở mm (engine),
một ở point (writer).
"""

from __future__ import annotations

import pikepdf
import pytest

from app.core.nesting_imposition_bundle import (
    ImpositionPontConfigSpec,
    ImpositionPontGuideSpec,
    ImpositionPontSpec,
)
from app.workers.nup_nesting_finishing import (
    _pont_corner_centers_mm,
    build_pont_obstacles,
)

SHEET_W = 320.0
SHEET_H = 430.0

_ALLOWED_KINDS = frozenset({"gripper", "sheet_mark", "cnc_exclude_zone", "keep_out"})


def _config(**overrides) -> ImpositionPontConfigSpec:
    base = dict(
        shape="circle",
        size_mm=5.0,
        thickness_mm=0.5,
        is_graphtec=False,
        layer_info_name="",
        layer_name="Pont",
        group_name="G",
        item_name="MKLINE",
        disable_collision=False,
        margin_top_mm=7.0,
        margin_bottom_mm=7.0,
        margin_left_mm=7.0,
        margin_right_mm=7.0,
    )
    base.update(overrides)
    return ImpositionPontConfigSpec(**base)


def _pont(**overrides) -> ImpositionPontSpec:
    return ImpositionPontSpec(type="custom", config=_config(**overrides))


def _obstacles(**overrides):
    return build_pont_obstacles(
        _pont(**overrides), sheet_width_mm=SHEET_W, sheet_height_mm=SHEET_H
    )


# ─────────────────────────────────────────────────────────────────────────────
#  1. Bất biến sống còn: trùng chỗ writer vẽ
# ─────────────────────────────────────────────────────────────────────────────


def test_vat_can_trung_cho_writer_ve_oc():
    """Hai công thức, hai đơn vị, phải cho cùng một chỗ.

    Nếu ai sửa một bên mà quên bên kia, test này đỏ — thay vì im lặng giao tờ có tem đè
    lên dấu canh.
    """

    from app.workers.imposition_pdf_form import PT_PER_MM
    from app.workers.nesting_imposition_render import _pont_corner_centers_pt

    config = _config()
    size_pt = config.size_mm * PT_PER_MM

    tam_mm = _pont_corner_centers_mm(
        config, sheet_width_mm=SHEET_W, sheet_height_mm=SHEET_H
    )
    tam_pt = _pont_corner_centers_pt(
        {
            "marginsMm": {
                "top": config.margin_top_mm,
                "bottom": config.margin_bottom_mm,
                "left": config.margin_left_mm,
                "right": config.margin_right_mm,
            }
        },
        width_pt=SHEET_W * PT_PER_MM,
        height_pt=SHEET_H * PT_PER_MM,
        radius_pt=size_pt / 2.0,
    )

    assert [name for _x, _y, name in tam_mm] == [name for _x, _y, name in tam_pt]
    for (x_mm, y_mm, name), (x_pt, y_pt, _name) in zip(tam_mm, tam_pt):
        assert x_mm == pytest.approx(x_pt / PT_PER_MM, abs=1e-9), name
        assert y_mm == pytest.approx(y_pt / PT_PER_MM, abs=1e-9), name


# ─────────────────────────────────────────────────────────────────────────────
#  2. Hợp đồng vật cản
# ─────────────────────────────────────────────────────────────────────────────


def test_bon_oc_goc_thanh_bon_vat_can():
    obstacles = _obstacles()

    assert len(obstacles) == 4
    assert {item["obstacleId"] for item in obstacles} == {
        "pont-tl",
        "pont-tr",
        "pont-bl",
        "pont-br",
    }


def test_vat_can_dung_hop_dong_adapter():
    """Field lạ hoặc `kind` không hỗ trợ sẽ bị adapter chặn — kiểm ở đây cho rõ nguyên nhân."""

    for item in _obstacles():
        assert set(item) == {"obstacleId", "kind", "outer"}
        assert item["kind"] in _ALLOWED_KINDS
        assert len(item["outer"]) >= 3
        for point in item["outer"]:
            assert len(point) == 2
            assert 0.0 <= point[0] <= SHEET_W
            assert 0.0 <= point[1] <= SHEET_H


def test_vat_can_bao_TRUM_hinh_oc():
    """Ô vuông là bao trên an toàn cho cả ốc tròn và góc L — không được nhỏ hơn."""

    size = 5.0
    obstacles = _obstacles(size_mm=size)

    for item in obstacles:
        xs = [point[0] for point in item["outer"]]
        ys = [point[1] for point in item["outer"]]
        assert max(xs) - min(xs) == pytest.approx(size)
        assert max(ys) - min(ys) == pytest.approx(size)


def test_oc_nam_trong_vung_dung_duoc_nen_that_su_can_vat_can():
    """Chốt cho chính lý do bug này nghiêm trọng.

    Lề ốc 7mm > lề tờ 5mm ⇒ ốc nằm TRONG vùng dùng được. Nếu ốc luôn nằm ngoài lề thì
    solver không bao giờ đặt tem tới đó và vật cản là vô nghĩa.
    """

    le_to = 5.0
    obstacles = _obstacles(
        margin_top_mm=7.0, margin_bottom_mm=7.0, margin_left_mm=7.0, margin_right_mm=7.0
    )

    trong_vung = [
        item
        for item in obstacles
        if min(point[0] for point in item["outer"]) < SHEET_W - le_to
        and min(point[1] for point in item["outer"]) < SHEET_H - le_to
        and max(point[0] for point in item["outer"]) > le_to
        and max(point[1] for point in item["outer"]) > le_to
    ]
    assert len(trong_vung) == 4


# ─────────────────────────────────────────────────────────────────────────────
#  3. Tôn trọng lựa chọn của người dùng
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_collision_thi_khong_dung_vat_can():
    """Người dùng cố ý tắt — không được âm thầm bật lại."""

    assert _obstacles(disable_collision=True) == ()


def test_khong_khai_oc_thi_khong_co_vat_can():
    assert (
        build_pont_obstacles(
            ImpositionPontSpec(), sheet_width_mm=SHEET_W, sheet_height_mm=SHEET_H
        )
        == ()
    )


def test_thieu_config_thi_khong_no():
    assert (
        build_pont_obstacles(
            ImpositionPontSpec(type="custom", config=None),
            sheet_width_mm=SHEET_W,
            sheet_height_mm=SHEET_H,
        )
        == ()
    )


# ─────────────────────────────────────────────────────────────────────────────
#  4. Guide
# ─────────────────────────────────────────────────────────────────────────────


def test_guide_thanh_vat_can_mong():
    obstacles = _obstacles(
        guides=(
            ImpositionPontGuideSpec(
                position="BL", length_mm=20.0, thickness_mm=1.0, offset_x_mm=3.0, offset_y_mm=4.0
            ),
        )
    )

    guides = [item for item in obstacles if item["obstacleId"].startswith("pont-guide")]
    assert len(guides) == 1
    xs = [point[0] for point in guides[0]["outer"]]
    ys = [point[1] for point in guides[0]["outer"]]
    assert min(xs) == pytest.approx(3.0)
    assert max(xs) == pytest.approx(23.0)
    # BL đo offsetY từ mép DƯỚI.
    assert min(ys) == pytest.approx(3.5)
    assert max(ys) == pytest.approx(4.5)


def test_guide_tren_va_duoi_khong_bi_hoan_vi():
    """Cùng bẫy trục Y với writer: TL đo từ mép TRÊN, BL đo từ mép DƯỚI."""

    def y_center(position: str) -> float:
        obstacles = _obstacles(
            guides=(
                ImpositionPontGuideSpec(
                    position=position,
                    length_mm=20.0,
                    thickness_mm=1.0,
                    offset_x_mm=3.0,
                    offset_y_mm=4.0,
                ),
            )
        )
        guide = next(
            item for item in obstacles if item["obstacleId"].startswith("pont-guide")
        )
        ys = [point[1] for point in guide["outer"]]
        return (min(ys) + max(ys)) / 2.0

    assert y_center("TL") == pytest.approx(SHEET_H - 4.0)
    assert y_center("BL") == pytest.approx(4.0)


def test_guide_khong_hop_le_thi_bo_rieng_guide_do():
    obstacles = _obstacles(
        guides=(
            ImpositionPontGuideSpec(
                position="BL", length_mm=0.0, thickness_mm=1.0
            ),
            ImpositionPontGuideSpec(
                position="BR", length_mm=20.0, thickness_mm=1.0
            ),
        )
    )

    guides = [item for item in obstacles if item["obstacleId"].startswith("pont-guide")]
    assert len(guides) == 1
    assert guides[0]["obstacleId"].endswith("br")


# ─────────────────────────────────────────────────────────────────────────────
#  5. Nối vào job thật
# ─────────────────────────────────────────────────────────────────────────────


def test_job_mang_vat_can_oc(tmp_path):
    """Chốt đường dây: `build_true_shape_nesting_job` phải gắn vật cản vào job."""

    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    source = tmp_path / "nguon.pdf"
    # Fixture phải là PDF thật: production fail-closed khi thiếu xref/trailer,
    # nên chuỗi header/EOF giả không thể dùng để kiểm wiring vật cản.
    pdf = pikepdf.Pdf.new()
    try:
        pdf.add_blank_page(page_size=(100, 100))
        pdf.save(source)
    finally:
        pdf.close()
    settings = {
        "gridStrategy": "true_shape_nesting",
        "isDieCutMode": True,
        "sheetWidth": SHEET_W,
        "sheetHeight": SHEET_H,
        "gapX": 2.0,
        "gapY": 2.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "targetQuantitiesByPage": {"0": 4},
        "detectedShapesByPage": {"0": "CUSTOM"},
        "pontType": "custom",
        "pontConfig": {
            "shape": "circle",
            "size": 5.0,
            "thickness": 0.5,
            "disableCollision": False,
            "marginTop": 7.0,
            "marginBottom": 7.0,
            "marginLeft": 7.0,
            "marginRight": 7.0,
        },
    }

    job = build_true_shape_nesting_job(str(source), settings)

    assert len(job.fixed_obstacles) == 4
    assert all(item["kind"] == "sheet_mark" for item in job.fixed_obstacles)

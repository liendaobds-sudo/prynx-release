"""§B10 — định tuyến TỰ ĐỘNG nesting theo phân loại hình.

Chốt bất biến: CUSTOM (đặc biệt) + "Xếp tối ưu" trên die-cut/CNC → true-shape (kể cả S&R
và gang lẫn named+đặc biệt); hình có-tên / "Lưới đơn giản" / guillotine → engine cũ. Gói
sau cờ master true-shape (`true_shape_nesting_enabled`); test DEV_MODE=false ⇒ mặc định tắt.
"""

from __future__ import annotations

import pytest

from app.workers.nup_true_shape_nesting import (
    _guard_scope,
    _job_has_special_shape,
    _shape_is_special,
    build_true_shape_nesting_job,
    route_true_shape,
    wants_true_shape_nesting,
)


@pytest.fixture
def flag_on(monkeypatch):
    # §B10 gói sau cờ master true-shape. Test env DEV_MODE=false nên mặc định tắt; bật tường
    # minh để kiểm đường auto-route (parity với frontend TRUE_SHAPE_NESTING_ENABLED).
    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda **_: True
    )


def _settings(**over):
    base = {
        "imposerMode": "diecut",
        "isDieCutMode": True,
        "gridStrategy": "optimal_auto",
        # MAP-NEST-04: test mặc định giữ free gang; ca maximize_area nằm riêng bên dưới.
        "groupingStrategy": "free_gang",
        "detectedShapesByPage": {"0": "CUSTOM"},
    }
    base.update(over)
    return base


# ── _shape_is_special ──────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "value,expected",
    [
        (None, True),
        ("", True),
        ("   ", True),
        ("CUSTOM", True),
        ("Đặc biệt", True),  # nhãn tiếng Việt của CUSTOM
        ("rác_không_tồn_tại", True),  # giá trị lạ ⇒ đặc biệt
        ("TRIANGLE", False),
        ("Tam giác", False),
        ("RECTANGLE", False),
        ("HEXAGON", False),
    ],
)
def test_shape_is_special(value, expected):
    assert _shape_is_special(value) is expected


# ── _job_has_special_shape (mệnh đề "quy về đặc biệt hết") ───────────────────
def test_job_special_single_custom():
    assert _job_has_special_shape(_settings(detectedShapesByPage={"0": "CUSTOM"})) is True


def test_job_all_named_not_special():
    s = _settings(detectedShapesByPage={"0": "TRIANGLE", "1": "HEXAGON"})
    assert _job_has_special_shape(s) is False


def test_job_gang_mixed_named_and_custom_is_special():
    # Gang lẫn tam giác + đặc biệt ⇒ có CUSTOM ⇒ đặc biệt cả tờ.
    s = _settings(detectedShapesByPage={"0": "TRIANGLE", "1": "CUSTOM", "2": "RECTANGLE"})
    assert _job_has_special_shape(s) is True


def test_job_missing_classification_is_special():
    s = _settings(detectedShapesByPage={})
    assert _job_has_special_shape(s) is True


def test_job_respects_quantity_pages_only():
    # Chỉ trang có SL>0 mới vào job: trang CUSTOM có SL 0 KHÔNG kéo cả job thành đặc biệt.
    s = _settings(
        detectedShapesByPage={"0": "TRIANGLE", "1": "CUSTOM"},
        targetQuantitiesByPage={"0": 100, "1": 0},
    )
    assert _job_has_special_shape(s) is False


# ── route_true_shape ─────────────────────────────────────────────────────────
def test_route_off_by_default():
    # Không set cờ ⇒ giữ hành vi cũ (không auto-route).
    assert route_true_shape(_settings()) is False


def test_route_custom_optimal_diecut(flag_on):
    assert route_true_shape(_settings()) is True


def test_route_publication_grid_buoc_export_giu_engine_cu(flag_on):
    # B10-6: preview đã chốt provisional/legacy thì export không được solve nesting lại.
    assert route_true_shape(_settings(forceLegacyGrid=True)) is False


def test_route_custom_optimal_cnc(flag_on):
    s = _settings(imposerMode="cnc", isDieCutMode=True)
    assert route_true_shape(s) is True


def test_route_named_stays_old_engine(flag_on):
    s = _settings(detectedShapesByPage={"0": "TRIANGLE"})
    assert route_true_shape(s) is False


def test_route_simple_grid_not_true_shape(flag_on):
    assert route_true_shape(_settings(gridStrategy="simple_auto")) is False
    assert route_true_shape(_settings(gridStrategy="manual")) is False


def test_route_guillotine_never(flag_on):
    s = _settings(imposerMode="guillotine", isDieCutMode=False)
    assert route_true_shape(s) is False


def test_route_page_sheet_excluded(flag_on):
    assert route_true_shape(_settings(page_sheet_mode=True)) is False


def test_route_mixed_guillotine_excluded(flag_on):
    assert route_true_shape(_settings(layoutType="mixed_guillotine")) is False


def test_route_gang_mixed_promotes_to_true_shape(flag_on):
    s = _settings(detectedShapesByPage={"0": "TRIANGLE", "1": "CUSTOM"})
    assert route_true_shape(s) is True


def test_route_one_dao_excluded(flag_on):
    # 1 Dao = cắt chữ nhật: dù dò ra CUSTOM vẫn KHÔNG auto-route (giữ tiler chữ nhật cũ).
    assert route_true_shape(_settings(cutType="one_dao")) is False


def test_route_one_dao_excluded_cnc(flag_on):
    s = _settings(imposerMode="cnc", isDieCutMode=True, cutType="one_dao")
    assert route_true_shape(s) is False


def test_route_default_cut_still_true_shape(flag_on):
    # Chỉ 1 Dao bị loại; các cutType khác (default) + CUSTOM vẫn đi true-shape.
    assert route_true_shape(_settings(cutType="default")) is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"layoutType": "ratio_stack"},
        {"layoutType": "cut_stacks"},
        {"groupingStrategy": "strict_ratio"},
        {"groupingStrategy": "none"},
        {"groupingStrategy": "cluster_tile"},
        {"clusterMode": "rows"},
        {"alternateRotation": "row"},
        {"cutBorderEnabled": True},
        {"hiddenOcgLayerIds": ["ocg-1"]},
        {"saveByReport": True},
    ],
)
def test_route_va_guard_cung_chan_intent_chua_ho_tro(flag_on, overrides):
    """MAP-NEST-03: auto fallback và token thủ công dùng cùng compatibility matrix."""

    settings = _settings(**overrides)
    assert route_true_shape(settings) is False

    with pytest.raises(ValueError):
        _guard_scope({**settings, "gridStrategy": "true_shape_nesting"})


def test_route_va_guard_cho_dau_canh_cnc_duplex(flag_on):
    """MAP-NEST-08: preview và export cùng mở capability đã có semantics thật."""

    settings = _settings(
        imposerMode="cnc",
        isDieCutMode=False,
        cncTwoSided=True,
        cncDuplexMarks=True,
    )
    assert route_true_shape(settings) is True
    _guard_scope({**settings, "gridStrategy": "true_shape_nesting"})


def test_route_cho_hai_intent_nup_nhung_sr_khong_nhan_maximize_area(flag_on):
    assert route_true_shape(_settings(groupingStrategy="free_gang")) is True
    assert route_true_shape(_settings(groupingStrategy="maximize_area")) is True
    assert route_true_shape(
        _settings(taskMode="step_repeat", layoutType="repeat", groupingStrategy="none")
    ) is True

    sr_maximize = _settings(
        taskMode="step_repeat",
        layoutType="repeat",
        groupingStrategy="maximize_area",
    )
    assert route_true_shape(sr_maximize) is False
    with pytest.raises(ValueError):
        _guard_scope({**sr_maximize, "gridStrategy": "true_shape_nesting"})


def test_maximize_area_sinh_dai_bang_nhau_theo_thu_tu_trang_va_khong_an_gap(
    monkeypatch,
) -> None:
    # Test này chỉ khóa phép chia vùng, không kiểm IO/detector; source cố ý là path giả.
    monkeypatch.setattr(
        "app.workers.nup_true_shape_nesting._detect_shapes_for_nesting",
        lambda _source_path: {},
    )
    settings = _settings(
        groupingStrategy="maximize_area",
        sheetWidth=320.0,
        sheetHeight=430.0,
        marginLeft=11.0,
        marginRight=7.0,
        marginTop=5.0,
        marginBottom=13.0,
        gapX=17.0,
        gapY=29.0,
        targetQuantitiesByPage={"10": 1, "0": 1, "2": 1},
        detectedShapesByPage={"10": "CUSTOM", "0": "CUSTOM", "2": "CUSTOM"},
    )
    job = build_true_shape_nesting_job("D:/fixture.pdf", settings)

    assert job.grouping_intent == "maximize_area"
    assert [part.part_id for part in job.parts] == ["trang-1", "trang-3", "trang-11"]
    assert [zone.part_id for zone in job.placement_zones] == [
        "trang-1",
        "trang-3",
        "trang-11",
    ]
    assert [
        (
            zone.bounds.min_x_mm,
            zone.bounds.min_y_mm,
            zone.bounds.max_x_mm,
            zone.bounds.max_y_mm,
        )
        for zone in job.placement_zones
    ] == [
        (11.0, 287.666667, 313.0, 425.0),
        (11.0, 150.333333, 313.0, 287.666667),
        (11.0, 13.0, 313.0, 150.333333),
    ]

    other_gap = build_true_shape_nesting_job(
        "D:/fixture.pdf", {**settings, "gapX": 99.0, "gapY": 88.0}
    )
    assert other_gap.placement_zones == job.placement_zones
    free_gang = build_true_shape_nesting_job(
        "D:/fixture.pdf", {**settings, "groupingStrategy": "free_gang"}
    )
    assert free_gang.grouping_intent == "free_gang"
    assert free_gang.placement_zones == ()


# ── _guard_scope: Bình trang (S&R) ──────────────────────────────────────────
def test_guard_blocks_named_sr_even_with_flag(flag_on):
    # Named S&R không bao giờ nên tới true-shape ⇒ vẫn chặn.
    s = _settings(taskMode="step_repeat", detectedShapesByPage={"0": "TRIANGLE"})
    with pytest.raises(ValueError):
        _guard_scope(s)


def test_guard_allows_custom_sr_when_routed(flag_on):
    # Tem CUSTOM S&R + "Xếp tối ưu" ⇒ route_true_shape cho phép ⇒ không chặn.
    s = _settings(taskMode="step_repeat")
    _guard_scope(s)  # không ném


def test_guard_blocks_sr_when_flag_off():
    # Cờ tắt ⇒ giữ chặn S&R như cũ.
    s = _settings(taskMode="step_repeat")
    with pytest.raises(ValueError):
        _guard_scope(s)


def test_guard_still_blocks_page_sheet_and_mixed_guillotine(flag_on):
    with pytest.raises(ValueError):
        _guard_scope(_settings(page_sheet_mode=True))
    with pytest.raises(ValueError):
        _guard_scope(_settings(layoutType="mixed_guillotine"))


def test_guard_blocks_one_dao_sr(flag_on):
    # 1 Dao S&R = chữ nhật ⇒ route_true_shape False ⇒ guard vẫn chặn (về tiler cũ).
    s = _settings(taskMode="step_repeat", cutType="one_dao")
    with pytest.raises(ValueError):
        _guard_scope(s)


def test_guard_allows_token_sr_preview_path(flag_on):
    # Đường PREVIEW gửi TOKEN (gridStrategy='true_shape_nesting', KHÔNG optimal_auto).
    # _guard_scope phải cho qua S&R qua wants_true_shape_nesting — đây là ca lỗi thật
    # "Nesting … chưa mở cho Bình trang (S&R)" khi xem trước tem CUSTOM S&R.
    s = _settings(taskMode="step_repeat", gridStrategy="true_shape_nesting")
    _guard_scope(s)  # không ném


def test_guard_allows_token_sr_even_flag_off():
    # Token là yêu cầu thủ công/preview, độc lập cờ auto-route (is_true_shape_nesting_requested).
    s = _settings(taskMode="step_repeat", gridStrategy="true_shape_nesting")
    _guard_scope(s)  # không ném


# ── wants_true_shape_nesting: hợp hai tín hiệu, khớp dispatch ─────────────────
def test_wants_true_shape_token_or_route(flag_on):
    # Token (thủ công/preview) ⇒ True dù gridStrategy≠optimal_auto.
    assert wants_true_shape_nesting(_settings(gridStrategy="true_shape_nesting")) is True
    # Auto-route CUSTOM + optimal_auto ⇒ True.
    assert wants_true_shape_nesting(_settings()) is True
    # Hình có tên + optimal_auto ⇒ False (không tín hiệu nào bật).
    assert wants_true_shape_nesting(
        _settings(detectedShapesByPage={"0": "TRIANGLE"})
    ) is False
    # Lưới đơn giản ⇒ False.
    assert wants_true_shape_nesting(_settings(gridStrategy="simple_auto")) is False


def test_wants_token_independent_of_flag():
    # Cờ tắt: auto-route tắt, nhưng token vẫn được nhận (fail-closed thủ công ở dispatch).
    assert wants_true_shape_nesting(_settings(gridStrategy="true_shape_nesting")) is True
    assert wants_true_shape_nesting(_settings()) is False  # optimal_auto nhưng cờ tắt

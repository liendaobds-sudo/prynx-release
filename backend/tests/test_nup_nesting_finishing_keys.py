"""Hồi quy §NEST-FINISHING-KEYS: ánh xạ tên khoá settings → spec gia công của nesting.

Bốn lỗi được khoá ở đây, **tất cả đều im lặng** — không exception, không log, chỉ là thiết
lập của người dùng biến mất trên tờ in:

1. Guide ốc đọc `guide{i}Position`/`OffsetX`/`OffsetY`; tên thật là `Pos`/`OffX`/`OffY`.
   Hệ quả: `guides` **luôn rỗng**.
2. Bỏ qua `guide{i}Enabled`. Sửa (1) mà không sửa cái này thì vẽ cả guide đã tắt.
3. Vòng lặp guide dựa trên **số vị trí hợp lệ** (4) thay vì **số guide** UI có (2).
4. Report chỉ lọc theo `fieldOrder`, bỏ các cờ `showX`. Vì `fieldOrder` mặc định chứa cả 13
   field, field bị tắt vẫn được vẽ.
5. `reportLamination` chỉ nhận `int`, nên JSON `1.0` rơi về `"none"` — mất cán màng.

Lỗi (1) từng **xanh** trong `test_nesting_finishing_parity.py` vì fixture của test cũng
dùng tên khoá sai y như bản hiện thực. Đó là lý do bộ test này tồn tại: nó so với nguồn
chân lý (`desktop/src/components/imposition-tools/types.ts`,
`backend/app/schemas/pont.py`, `desktop/src/lib/reportPreview.ts`), không so với chính nó.
"""

from __future__ import annotations

import pytest

from app.workers.nup_nesting_finishing import (
    build_artifact_options,
    build_pont_spec,
)


def _pont_config(**overrides):
    base = {
        "shape": "circle",
        "size": 5.0,
        "thickness": 0.5,
        "isGraphtec": False,
        "disableCollision": False,
    }
    base.update(overrides)
    return base


def _settings(**overrides):
    base = {"pontType": "custom", "pontConfig": _pont_config()}
    base.update(overrides)
    return base


# ─────────────────────────────────────────────────────────────────────────────
#  Guide ốc: tên khoá thật
# ─────────────────────────────────────────────────────────────────────────────


def test_guide_doc_dung_ten_khoa_that():
    settings = _settings(
        pontConfig=_pont_config(
            guide1Enabled=True,
            guide1Pos="BL",
            guide1Length=18.0,
            guide1Thickness=0.4,
            guide1OffX=1.25,
            guide1OffY=-2.5,
        )
    )

    spec = build_pont_spec(settings)

    assert len(spec.config.guides) == 1
    guide = spec.config.guides[0]
    assert guide.position == "BL"
    assert guide.length_mm == 18.0
    assert guide.thickness_mm == 0.4
    assert guide.offset_x_mm == 1.25
    assert guide.offset_y_mm == -2.5


def test_ten_khoa_cu_khong_con_tao_ra_guide():
    """Chốt hồi quy cho chính lỗi đã giao ra người dùng.

    `guide1Position`/`OffsetX`/`OffsetY` là tên **sai**. Nếu ai đó thêm lại nhánh đọc chúng
    thì test này đỏ — vì chấp nhận cả hai tên nghĩa là không còn một nguồn chân lý nào.
    """

    settings = _settings(
        pontConfig=_pont_config(
            guide1Position="TL",
            guide1Length=20.0,
            guide1OffsetX=3.0,
            guide1OffsetY=4.0,
        )
    )

    spec = build_pont_spec(settings)

    assert spec.config.guides == ()


def test_guide_tat_thi_khong_ve():
    settings = _settings(
        pontConfig=_pont_config(
            guide1Enabled=False,
            guide1Pos="TL",
            guide2Enabled=True,
            guide2Pos="BR",
        )
    )

    spec = build_pont_spec(settings)

    assert [guide.position for guide in spec.config.guides] == ["BR"]


def test_thieu_co_enabled_thi_coi_nhu_tat():
    """`normalize_pont_settings` luôn điền cờ này, nên thiếu cờ là payload bất thường.

    Chọn fail-soft về phía **không vẽ**: vẽ một guide người dùng không yêu cầu thì thợ phải
    bỏ tờ, còn thiếu guide thì thấy ngay trên preview.
    """

    settings = _settings(pontConfig=_pont_config(guide1Pos="TL"))

    spec = build_pont_spec(settings)

    assert spec.config.guides == ()


def test_chi_quet_dung_hai_guide_ma_ui_co():
    settings = _settings(
        pontConfig=_pont_config(
            guide1Enabled=True,
            guide1Pos="TL",
            guide2Enabled=True,
            guide2Pos="TR",
            guide3Enabled=True,
            guide3Pos="BL",
            guide4Enabled=True,
            guide4Pos="BR",
        )
    )

    spec = build_pont_spec(settings)

    assert [guide.position for guide in spec.config.guides] == ["TL", "TR"]


@pytest.mark.parametrize("position", ["XX", "tl", "", None, 5])
def test_vi_tri_guide_khong_hop_le_thi_bo_guide_do(position):
    settings = _settings(
        pontConfig=_pont_config(guide1Enabled=True, guide1Pos=position)
    )

    spec = build_pont_spec(settings)

    assert spec.config.guides == ()


def test_guide_giu_dung_thu_tu_khai_bao():
    settings = _settings(
        pontConfig=_pont_config(
            guide1Enabled=True,
            guide1Pos="BR",
            guide2Enabled=True,
            guide2Pos="TL",
        )
    )

    spec = build_pont_spec(settings)

    assert [guide.position for guide in spec.config.guides] == ["BR", "TL"]


# ─────────────────────────────────────────────────────────────────────────────
#  Report: cờ showX và cán màng
# ─────────────────────────────────────────────────────────────────────────────


def _report_settings(**display_overrides):
    display = {
        "enabled": True,
        "fieldOrder": ["orderCode", "identifier", "gangCount", "material"],
    }
    display.update(display_overrides)
    return {"reportDisplay": display}


def test_co_show_tat_thi_bo_field_khoi_report():
    options = build_artifact_options(
        _report_settings(showIdentifier=False, showGangCount=False)
    )

    assert options.report.enabled is True
    assert options.report.fields == ("orderCode", "material")


def test_thieu_co_show_thi_coi_nhu_bat():
    """Cùng quy tắc với `reportPreview.ts` và `nup_report.build_report_string`."""

    options = build_artifact_options(_report_settings())

    assert options.report.fields == (
        "orderCode",
        "identifier",
        "gangCount",
        "material",
    )


def test_field_khong_co_co_show_thi_khong_the_bi_tat():
    """`orderCode` không nằm trong `SHOW_FLAG_KEY` nên không có cờ nào tắt được nó."""

    options = build_artifact_options(
        _report_settings(fieldOrder=["orderCode"], showOrderCode=False)
    )

    assert options.report.fields == ("orderCode",)


def test_tat_het_field_thi_report_tro_thanh_disabled():
    options = build_artifact_options(
        _report_settings(
            fieldOrder=["identifier", "material"],
            showIdentifier=False,
            showMaterial=False,
        )
    )

    assert options.report.enabled is False


def test_field_trung_chi_lay_mot_lan():
    options = build_artifact_options(
        _report_settings(fieldOrder=["material", "material", "identifier"])
    )

    assert options.report.fields == ("material", "identifier")


def test_report_giu_demand_sr_va_fallback_ten_trang_co_nguon():
    settings = _report_settings(fieldOrder=["labelName", "actualQty", "sheetCount"])
    options = build_artifact_options(
        settings,
        requested_qty=17,
        fallback_label_name="Trang 3",
    )

    assert options.report.requested_qty == 17
    assert options.report.label_name == "Trang 3"

    settings["reportDisplay"]["labelNameText"] = "  Mẫu khách  "
    explicit = build_artifact_options(
        settings,
        requested_qty=17,
        fallback_label_name="Trang 3",
    )
    assert explicit.report.label_name == "  Mẫu khách  "


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0, "none"),
        (1, "gloss"),
        (2, "matte"),
        # JSON hoàn toàn có thể gửi số nguyên dạng float — đây là lỗi đã sửa.
        (1.0, "gloss"),
        (2.0, "matte"),
        # Không phải chỉ số hợp lệ ⇒ không cán màng, không đoán.
        (1.5, "none"),
        ("1", "none"),
        (True, "none"),
        (None, "none"),
        (99, "none"),
    ],
)
def test_can_mang_nhan_ca_chi_so_dang_float(raw, expected):
    settings = _report_settings()
    settings["reportLamination"] = raw

    options = build_artifact_options(settings)

    assert options.report.lamination.type == expected


def test_report_tat_thi_khong_doc_them_gi():
    options = build_artifact_options({"reportDisplay": {"enabled": False}})

    assert options.report.enabled is False


# ─────────────────────────────────────────────────────────────────────────────
#  Dấu xén: ngoài phạm vi lane nesting — §NEST-TRIM-OUT-OF-SCOPE
# ─────────────────────────────────────────────────────────────────────────────
#
# Ba bằng chứng cho việc "không vẽ" là ĐÚNG, không phải thiếu tính năng:
#
# 1. `nup_process_chunk.py:1059` — lane lưới: `if not is_die_cut and (mark_type in ...)`.
# 2. `types.ts` `IMPOSER_CAPABILITIES`: `diecut` và `cnc` đều `supportsMarks: false`, nên
#    `processHandlers.ts:276` luôn gửi `markType: 'none'`.
# 3. Nghiệp vụ: tem bế và bế rớt CNC do **dao** cắt. Dấu xén ở đây là dấu vô nghĩa và thợ
#    dễ hiểu sai thành đường cắt.
#
# Test này tồn tại để chặn một "bản sửa" sai: ai thấy `renderBundle.marks.trim` không được
# writer đọc rồi đi viết code vẽ nó sẽ làm test đỏ, kèm lý do ở đây.


def test_dau_xen_luon_none_tren_lane_nesting():
    from app.workers.nup_nesting_finishing import build_trim_spec

    assert build_trim_spec({}).type == "none"


@pytest.mark.parametrize("mark_type", ["corners", "guillotine", "CORNERS", "lung tung"])
def test_payload_dung_tay_khai_dau_xen_van_bi_ep_ve_none(mark_type, caplog):
    """Không được âm thầm: ép về `none` thì phải có log để lần ra."""

    from app.workers.nup_nesting_finishing import build_trim_spec

    with caplog.at_level("INFO"):
        spec = build_trim_spec(
            {
                "markType": mark_type,
                "markLength": 8.0,
                "markOffset": 4.0,
                "markThickness": 0.5,
                "markStyle": "japanese",
            }
        )

    assert spec.type == "none"
    assert any("markType" in record.message for record in caplog.records)


def test_markType_none_thi_khong_log_gi():
    """Ca bình thường (UI luôn gửi 'none') không được sinh log nhiễu."""

    from app.workers.nup_nesting_finishing import build_trim_spec

    spec = build_trim_spec({"markType": "none"})

    assert spec.type == "none"

"""Contract của builder RenderBundle V2 cho Bình tem bế/CNC."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

import pytest

from app.core.mixed_nesting_service import (
    MIXED_NESTING_PROTOCOL_VERSION,
    PRODUCTION_ALGORITHM_VERSION_KEYS,
)
from app.core.nesting_imposition_bundle import (
    CNC_IMPOSER_RENDERER_VERSION,
    STICKER_IMPOSER_RENDERER_VERSION,
    BuiltImpositionRenderBundle,
    ImpositionArtifactOptions,
    ImpositionCutSourceFilterSpec,
    ImpositionCutSpec,
    ImpositionCutStrokeSpec,
    ImpositionCutStyleSpec,
    ImpositionReportEnabled,
    ImpositionReportLamination,
    ImpositionReportPlacement,
    ImpositionRenderBundleError,
    ImpositionRenderContext,
    ImpositionRenderPartSpec,
    ImpositionTrimSpec,
    build_imposition_render_bundle_v2,
)
from app.core.nesting_production_adapter import (
    RenderPolygonV1,
    build_production_request,
    canonical_json_bytes,
)
from app.core.nesting_source_pin import PinnedNestingSource, PinnedPageMetadata


JOB_ID = "0123456789abcdef0123456789abcdef"
BUILD_IDENTITY = "1" * 64


def _versions() -> dict[str, int | str]:
    versions: dict[str, int | str] = {
        key: 1 for key in PRODUCTION_ALGORITHM_VERSION_KEYS
    }
    versions["protocolVersion"] = MIXED_NESTING_PROTOCOL_VERSION
    versions["engineVersion"] = "mixed-nesting-core-test"
    return versions


def _page(page_index: int) -> PinnedPageMetadata:
    return PinnedPageMetadata(
        page_index=page_index,
        page_boxes_mm={
            "mediaBox": [10.0, 20.0, 220.0, 317.0],
            "cropBox": [11.0, 21.0, 219.0, 316.0],
            "trimBox": [15.0, 25.0, 215.0, 312.0],
        },
        user_unit=1.0,
        rotate_deg=0,
        source_page_to_canonical=(1.0, 0.0, 0.0, 1.0, -10.0, -20.0),
    )


def _pin(letter: str) -> PinnedNestingSource:
    locator = f"{letter * 8}-{letter * 4}-4{letter * 3}-8{letter * 3}-{letter * 12}"
    content_hash = "sha256:" + letter * 64
    return PinnedNestingSource(
        locator_id=locator,
        content_hash=content_hash,
        byte_size=1000 + ord(letter),
        page_count=4,
        revision=content_hash,
        pages=tuple(_page(index) for index in range(4)),
        snapshot_path=Path(f"D:/snapshot/{letter}.pdf"),
        lease_token=letter * 64,
    )


def _polygon(x: float = 0.0) -> RenderPolygonV1:
    return RenderPolygonV1(
        outer=((x, 0.0), (x + 40.0, 0.0), (x + 40.0, 20.0), (x, 20.0)),
        holes=(),
    )


def _part(part_id: str, pin: PinnedNestingSource, *, duplex: bool, x: float) -> ImpositionRenderPartSpec:
    polygon = _polygon(x)
    return ImpositionRenderPartSpec(
        part_id=part_id,
        source_pin=pin,
        packing_footprint=polygon,
        cut_contour=polygon,
        artwork_clip_path=polygon,
        die_dimensions_mm=(40.0, 20.0),
        front_page_index=0,
        back_page_index=1 if duplex else None,
        cut_page_index=0,
    )


def _request(parts: tuple[ImpositionRenderPartSpec, ...], intent: str) -> dict:
    public_parts = []
    for part in parts:
        item = {
            "partId": part.part_id,
            "outer": [list(point) for point in part.packing_footprint.outer],
            "holes": [],
        }
        if intent == "quantity_fulfillment":
            item["quantity"] = 3
        public_parts.append(item)
    return {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 42,
        "profile": "balanced",
        "sheet": {
            "widthMm": 320.0,
            "heightMm": 450.0,
            "marginMm": {"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0},
            "maxSheets": 1 if intent == "autofill_single_sheet" else 12,
        },
        "gapMm": 0.0,
        "layoutIntent": intent,
        "orientationPolicy": {
            "defaultRotation": {"mode": "fixed", "angleDeg": 90.0},
            "reflection": "forbidden",
        },
        "parts": public_parts,
    }


@pytest.mark.parametrize("layout_intent", ["autofill_single_sheet", "quantity_fulfillment"])
@pytest.mark.parametrize(
    "tool,task_mode,duplex_mode,flip_edge,part_count,expected_sides,renderer_version",
    [
        ("sticker_imposer", "step_repeat", "simplex", "none", 1, ["front", "cut"], STICKER_IMPOSER_RENDERER_VERSION),
        ("sticker_imposer", "nup", "simplex", "none", 2, ["front", "cut"], STICKER_IMPOSER_RENDERER_VERSION),
        ("cnc_imposer", "step_repeat", "simplex", "none", 1, ["front", "cut"], CNC_IMPOSER_RENDERER_VERSION),
        ("cnc_imposer", "step_repeat", "duplex", "long", 1, ["front", "back", "cut"], CNC_IMPOSER_RENDERER_VERSION),
        ("cnc_imposer", "nup", "simplex", "none", 2, ["front", "cut"], CNC_IMPOSER_RENDERER_VERSION),
        ("cnc_imposer", "nup", "duplex", "long", 2, ["front", "back", "cut"], CNC_IMPOSER_RENDERER_VERSION),
    ],
)
def test_builder_matrix_qua_adapter_validation_that(
    layout_intent,
    tool,
    task_mode,
    duplex_mode,
    flip_edge,
    part_count,
    expected_sides,
    renderer_version,
) -> None:
    pins = (_pin("b"), _pin("a"))
    parts = tuple(
        _part(
            f"part-{index}",
            pins[index],
            duplex=duplex_mode == "duplex",
            x=float(index * 50),
        )
        for index in range(part_count)
    )
    context = ImpositionRenderContext(
        tool=tool,
        task_mode=task_mode,
        layout_intent=layout_intent,
        sheet_width_mm=320.0,
        sheet_height_mm=450.0,
        duplex_mode=duplex_mode,
        flip_edge=flip_edge,
        duplex_registration=duplex_mode == "duplex",
    )

    built = build_imposition_render_bundle_v2(context, parts)
    production = build_production_request(
        _request(parts, layout_intent),
        job_id=JOB_ID,
        request_revision=1,
        render_bundle=built.render_bundle,
        clearance={
            "partToPart": {"xMm": 2.0, "yMm": 2.0},
            "partToSheetEdge": {"xMm": 1.0, "yMm": 1.0},
            "partToObstacle": {"xMm": 1.0, "yMm": 1.0},
        },
        algorithm_versions=_versions(),
        native_build_identity=BUILD_IDENTITY,
    )

    bundle = production.render_bundle
    assert bundle["flow"] == {
        "tool": tool,
        "taskMode": task_mode,
        "layoutIntent": layout_intent,
    }
    assert bundle["outputSides"] == expected_sides
    assert bundle["renderer"]["version"] == renderer_version
    assert [part["partId"] for part in bundle["parts"]] == sorted(
        part.part_id for part in parts
    )
    assert all(
        part["dieDimensionsMm"] == {"width": 40.0, "height": 20.0}
        for part in bundle["parts"]
    )
    assert built.source_pins == tuple(
        sorted((part.source_pin for part in parts), key=lambda pin: pin.locator_id)
    )


@pytest.mark.parametrize(
    "dimensions",
    [(0.0, 20.0), (float("nan"), 20.0), (40.0, float("inf"))],
)
def test_builder_tu_choi_kich_thuoc_khuon_khong_duong_huu_han(dimensions) -> None:
    """Kích thước report là contract server-owned, không nhận số rỗng/NaN/vô cực."""

    pin = _pin("a")
    part = replace(
        _part("tem", pin, duplex=False, x=0.0),
        die_dimensions_mm=dimensions,
    )
    context = ImpositionRenderContext(
        tool="sticker_imposer",
        task_mode="step_repeat",
        layout_intent="autofill_single_sheet",
        sheet_width_mm=320.0,
        sheet_height_mm=450.0,
    )
    with pytest.raises(ImpositionRenderBundleError, match="hữu hạn dương"):
        build_imposition_render_bundle_v2(context, (part,))


def test_snapshot_canonical_fresh_copy_va_khong_lo_path_token_manual_angle() -> None:
    pin = _pin("a")
    part = _part("tem-a", pin, duplex=False, x=0.0)
    built = build_imposition_render_bundle_v2(
        ImpositionRenderContext(
            tool="sticker_imposer",
            task_mode="step_repeat",
            layout_intent="autofill_single_sheet",
            sheet_width_mm=320.0,
            sheet_height_mm=450.0,
        ),
        (part,),
    )

    first = built.render_bundle
    first["flow"]["tool"] = "tampered"
    second = built.render_bundle
    assert second["flow"]["tool"] == "sticker_imposer"
    assert canonical_json_bytes(second) == built.canonical_bytes

    serialized = json.dumps(second, sort_keys=True)
    assert "snapshot_path" not in serialized
    assert "snapshotPath" not in serialized
    assert "lease_token" not in serialized
    assert "leaseToken" not in serialized
    assert "rotationConstraint" not in serialized
    assert "angleDeg" not in serialized
    assert second["parts"][0]["source"] == {
        "locatorId": pin.locator_id,
        "contentHash": pin.content_hash,
        "byteSize": pin.byte_size,
        "pageCount": pin.page_count,
        "revision": pin.revision,
    }
    assert second["parts"][0]["pages"]["front"] == pin.pages[0].to_binding_metadata()


def test_cnc_force_trim_cut_hien_huu_va_dedup_source_pin() -> None:
    pin = _pin("a")
    parts = (
        _part("b", pin, duplex=False, x=50.0),
        _part("a", pin, duplex=False, x=0.0),
    )
    built = build_imposition_render_bundle_v2(
        ImpositionRenderContext(
            tool="cnc_imposer",
            task_mode="nup",
            layout_intent="quantity_fulfillment",
            sheet_width_mm=320.0,
            sheet_height_mm=450.0,
            trim=ImpositionTrimSpec(type="corners", length_mm=99.0),
            cut=ImpositionCutSpec(
                type="one_dao",
                separate_page=False,
                ponts_on_cut_file=False,
                fill_block_gap_mm=7.0,
                die_size_mode="page",
                die_offset_mm=3.0,
            ),
        ),
        parts,
    )

    bundle = built.render_bundle
    assert bundle["marks"]["trim"] == ImpositionTrimSpec().to_bundle_dict()
    assert bundle["marks"]["cut"] == ImpositionCutSpec().to_bundle_dict()
    assert [part["partId"] for part in bundle["parts"]] == ["a", "b"]
    assert built.source_pins == (pin,)


def test_trung_locator_chi_dedup_khi_pin_exact() -> None:
    pin = _pin("a")
    conflicting = replace(pin, lease_token="f" * 64)
    parts = (
        _part("a", pin, duplex=False, x=0.0),
        _part("b", conflicting, duplex=False, x=50.0),
    )
    with pytest.raises(ImpositionRenderBundleError, match="khác snapshot/lease/metadata"):
        build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="cnc_imposer",
                task_mode="nup",
                layout_intent="quantity_fulfillment",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
            ),
            parts,
        )


def test_duplex_short_mirror_va_page_binding_exact() -> None:
    pin = _pin("a")
    built = build_imposition_render_bundle_v2(
        ImpositionRenderContext(
            tool="cnc_imposer",
            task_mode="step_repeat",
            layout_intent="quantity_fulfillment",
            sheet_width_mm=320.0,
            sheet_height_mm=450.0,
            duplex_mode="duplex",
            flip_edge="short",
            duplex_registration=True,
        ),
        (_part("cnc", pin, duplex=True, x=0.0),),
    )
    bundle = built.render_bundle
    assert bundle["duplex"]["physicalAxis"] == "y"
    assert bundle["sheetFrames"]["back"] == [1.0, 0.0, 0.0, -1.0, 0.0, 450.0]
    assert bundle["parts"][0]["pages"]["back"] == pin.pages[1].to_binding_metadata()
    assert bundle["parts"][0]["pages"]["cut"] == pin.pages[0].to_binding_metadata()


def test_artifact_options_canonical_nfc_trim_filter_hidden_fields() -> None:
    pin = _pin("a")
    context = ImpositionRenderContext(
        tool="sticker_imposer",
        task_mode="step_repeat",
        layout_intent="quantity_fulfillment",
        sheet_width_mm=320.0,
        sheet_height_mm=450.0,
        artifact_options=ImpositionArtifactOptions(
            export_unique_sheets=False,
            report=ImpositionReportEnabled(
                fields=("labelName", "lamination", "sheetCount"),
                label_name="  Te\u0302n tem  ",
                material="payload ẩn không được persist",
                lamination=ImpositionReportLamination(type="matte", sides=2),
                order_code="payload ẩn",
                custom_text="  Ghi chu\u0301  ",
                remove_diacritics=True,
                placement=ImpositionReportPlacement(
                    position="bottom",
                    centered=False,
                    offset_x_mm=1.2345678,
                    offset_y_mm=2.0,
                    font_size_pt=12.0000004,
                ),
            ),
        ),
    )
    bundle = build_imposition_render_bundle_v2(
        context, (_part("tem", pin, duplex=False, x=0.0),)
    ).render_bundle

    assert bundle["artifactOptions"] == {
        "exportUniqueSheets": False,
        "report": {
            "enabled": True,
            "fields": ["labelName", "lamination", "sheetCount"],
            "requestedQty": None,
            "labelName": "Tên tem",
            "material": "",
            "lamination": {"type": "matte", "sides": 2},
            "orderCode": "",
            "customText": "Ghi chú",
            "removeDiacritics": True,
            "placement": {
                "position": "bottom",
                "centered": False,
                "offsetXmm": 1.234568,
                "offsetYmm": 2.0,
                "fontSizePt": 12.0,
            },
        },
    }
    serialized = json.dumps(bundle["artifactOptions"], ensure_ascii=False)
    assert "showLabelName" not in serialized
    assert "license" not in serialized.lower()
    assert "hwid" not in serialized.lower()


def test_artifact_report_disabled_strip_payload_va_export_unique_guards() -> None:
    pin = _pin("a")
    part = _part("tem", pin, duplex=False, x=0.0)
    base = dict(
        task_mode="step_repeat",
        sheet_width_mm=320.0,
        sheet_height_mm=450.0,
    )
    disabled = build_imposition_render_bundle_v2(
        ImpositionRenderContext(
            tool="sticker_imposer",
            layout_intent="quantity_fulfillment",
            artifact_options=ImpositionArtifactOptions(export_unique_sheets=True),
            **base,
        ),
        (part,),
    ).render_bundle["artifactOptions"]
    assert disabled == {
        "exportUniqueSheets": True,
        "report": {"enabled": False},
    }

    for tool, intent in (
        ("sticker_imposer", "autofill_single_sheet"),
        ("cnc_imposer", "quantity_fulfillment"),
    ):
        with pytest.raises(ImpositionRenderBundleError, match="yêu cầu"):
            build_imposition_render_bundle_v2(
                ImpositionRenderContext(
                    tool=tool,
                    layout_intent=intent,
                    artifact_options=ImpositionArtifactOptions(
                        export_unique_sheets=False
                    ),
                    **base,
                ),
                (part,),
            )


def test_artifact_report_reject_strict_fields_string_number_enum() -> None:
    pin = _pin("a")
    part = _part("tem", pin, duplex=False, x=0.0)

    def build(report: ImpositionReportEnabled) -> None:
        build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="sticker_imposer",
                task_mode="step_repeat",
                layout_intent="quantity_fulfillment",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
                artifact_options=ImpositionArtifactOptions(report=report),
            ),
            (part,),
        )

    with pytest.raises(ImpositionRenderBundleError, match="không được trùng"):
        build(ImpositionReportEnabled(fields=("labelName", "labelName")))
    with pytest.raises(ImpositionRenderBundleError, match="điều khiển"):
        build(ImpositionReportEnabled(fields=("labelName",), label_name="x\ny"))
    build(ImpositionReportEnabled(fields=(), custom_text="x" * 2048))
    with pytest.raises(ImpositionRenderBundleError, match="2048"):
        build(ImpositionReportEnabled(fields=(), custom_text="x" * 2049))
    with pytest.raises(ImpositionRenderBundleError, match="4..40"):
        build(
            ImpositionReportEnabled(
                fields=(),
                placement=ImpositionReportPlacement(font_size_pt=41.0),
            )
        )
    with pytest.raises(ImpositionRenderBundleError, match="sides=1"):
        build(
            ImpositionReportEnabled(
                fields=("lamination",),
                lamination=ImpositionReportLamination(type="none", sides=2),
            )
        )


def test_cnc_reject_mapping_front_back_cut_khong_dung_cap_trang() -> None:
    pin = _pin("a")
    context_simplex = ImpositionRenderContext(
        tool="cnc_imposer",
        task_mode="step_repeat",
        layout_intent="quantity_fulfillment",
        sheet_width_mm=320.0,
        sheet_height_mm=450.0,
    )
    base = _part("cnc", pin, duplex=False, x=0.0)
    with pytest.raises(ImpositionRenderBundleError, match="Front"):
        build_imposition_render_bundle_v2(
            context_simplex, (replace(base, cut_page_index=2),)
        )
    with pytest.raises(ImpositionRenderBundleError, match="chẵn"):
        build_imposition_render_bundle_v2(
            context_simplex,
            (
                replace(
                    base,
                    front_page_index=1,
                    cut_page_index=1,
                ),
            ),
        )

    context_duplex = replace(
        context_simplex,
        duplex_mode="duplex",
        flip_edge="long",
        duplex_registration=True,
    )
    with pytest.raises(ImpositionRenderBundleError, match="liền sau Front"):
        build_imposition_render_bundle_v2(
            context_duplex,
            (
                replace(
                    base,
                    back_page_index=3,
                ),
            ),
        )


def test_sticker_cut_phai_dung_cung_trang_front() -> None:
    pin = _pin("a")
    part = _part("tem", pin, duplex=False, x=0.0)
    with pytest.raises(ImpositionRenderBundleError, match="trùng Front"):
        build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="sticker_imposer",
                task_mode="step_repeat",
                layout_intent="quantity_fulfillment",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
            ),
            (replace(part, cut_page_index=2),),
        )


def test_context_part_frozen_va_fail_closed_mapping() -> None:
    pin = _pin("a")
    context = ImpositionRenderContext(
        tool="sticker_imposer",
        task_mode="step_repeat",
        layout_intent="quantity_fulfillment",
        sheet_width_mm=320.0,
        sheet_height_mm=450.0,
    )
    part = _part("tem", pin, duplex=False, x=0.0)
    with pytest.raises(FrozenInstanceError):
        context.tool = "cnc_imposer"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        part.front_page_index = 3  # type: ignore[misc]

    with pytest.raises(ImpositionRenderBundleError, match="đúng một part"):
        build_imposition_render_bundle_v2(context, (part, _part("tem-2", pin, duplex=False, x=50.0)))
    with pytest.raises(ImpositionRenderBundleError, match="không có trang"):
        build_imposition_render_bundle_v2(
            context,
            (
                ImpositionRenderPartSpec(
                    part_id="bad-page",
                    source_pin=pin,
                    packing_footprint=_polygon(),
                    cut_contour=_polygon(),
                    artwork_clip_path=_polygon(),
                    die_dimensions_mm=(40.0, 20.0),
                    front_page_index=99,
                    cut_page_index=99,
                ),
            ),
        )
    with pytest.raises(ImpositionRenderBundleError, match="back_page_index"):
        build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="cnc_imposer",
                task_mode="step_repeat",
                layout_intent="quantity_fulfillment",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
                duplex_mode="duplex",
                flip_edge="long",
            ),
            (part,),
        )


# ─────────────────────────────────────────────────────────────────────────────
#  cutStyle — hợp đồng nét bế (Lô A1, audit 2026-08-28 §A1.1)
# ─────────────────────────────────────────────────────────────────────────────


def _cut_context(**overrides) -> ImpositionRenderContext:
    """Context tem bế simplex tối thiểu để soi riêng cutStyle."""

    base = {
        "tool": "sticker_imposer",
        "task_mode": "nup",
        "layout_intent": "quantity_fulfillment",
        "sheet_width_mm": 320.0,
        "sheet_height_mm": 450.0,
    }
    base.update(overrides)
    return ImpositionRenderContext(**base)


def _built_cut_style(**overrides) -> dict:
    parts = (_part("part-0", _pin("a"), duplex=False, x=0.0),)
    built = build_imposition_render_bundle_v2(_cut_context(**overrides), parts)
    return built.render_bundle["cutStyle"]


def _cut_style_through_adapter(cut_style: dict) -> dict:
    """Đẩy một cutStyle thô qua adapter và trả bản canonical đã kiểm."""

    parts = (_part("part-0", _pin("a"), duplex=False, x=0.0),)
    bundle = build_imposition_render_bundle_v2(_cut_context(), parts).render_bundle
    bundle["cutStyle"] = cut_style
    production = build_production_request(
        _request(parts, "quantity_fulfillment"),
        job_id=JOB_ID,
        request_revision=1,
        render_bundle=bundle,
        clearance={
            "partToPart": {"xMm": 2.0, "yMm": 2.0},
            "partToSheetEdge": {"xMm": 1.0, "yMm": 1.0},
            "partToObstacle": {"xMm": 1.0, "yMm": 1.0},
        },
        algorithm_versions=_versions(),
        native_build_identity=BUILD_IDENTITY,
    )
    return production.render_bundle["cutStyle"]


def test_cut_style_mac_dinh_canonical_va_di_qua_adapter() -> None:
    """Mặc định là spot ``cutcontour`` + nét Magenta 0,25mm, giữ nguyên qua adapter."""

    expected = {
        "sourceFilter": {
            "mode": "spot",
            "spotNames": ["cutcontour"],
            "processColor": None,
            "colorTolerance": 0.01,
            "dieLayerNames": [],
            "geometryToleranceMm": 0.1,
        },
        "stroke": {
            "widthMm": 0.25,
            "colorSpace": "cmyk",
            "components": [0.0, 1.0, 0.0, 0.0],
            "separationName": None,
            "alternate": None,
            "overprint": False,
        },
    }
    assert _built_cut_style() == expected
    assert _cut_style_through_adapter(expected) == expected


def test_cut_style_mot_bundle_chi_co_mot_cutstyle_cho_moi_side() -> None:
    """CNC duplex vẫn chỉ có MỘT cutStyle: Front/Back/Cut không thể lệch nét bế."""

    parts = (_part("part-0", _pin("a"), duplex=True, x=0.0),)
    built = build_imposition_render_bundle_v2(
        _cut_context(
            tool="cnc_imposer",
            duplex_mode="duplex",
            flip_edge="long",
            duplex_registration=True,
        ),
        parts,
    )
    bundle = built.render_bundle
    assert bundle["outputSides"] == ["front", "back", "cut"]
    # cutStyle nằm ở gốc bundle, không nằm trong từng side hay từng part.
    assert isinstance(bundle["cutStyle"], dict)
    assert all("cutStyle" not in part for part in bundle["parts"])

    simplex = build_imposition_render_bundle_v2(
        _cut_context(tool="cnc_imposer"),
        (_part("part-0", _pin("a"), duplex=False, x=0.0),),
    ).render_bundle
    # Simplex và duplex độc lập nhau nhưng dùng chung contract nét bế.
    assert simplex["cutStyle"] == bundle["cutStyle"]


def test_cut_style_chuan_hoa_ten_va_lam_tron_sau_chu_so() -> None:
    """Tên spot/layer hạ chữ thường, sắp theo byte; số lượng tử đúng 6 chữ số."""

    style = _built_cut_style(
        cut_style=ImpositionCutStyleSpec(
            source_filter=ImpositionCutSourceFilterSpec(
                spot_names=("  CutContour  ", "DIE-Line"),
                die_layer_names=("Khuôn Bế", "aaa"),
                color_tolerance=0.0123456789,
                geometry_tolerance_mm=0.1000000049,
            ),
            stroke=ImpositionCutStrokeSpec(width_mm=0.2500004),
        )
    )
    source = style["sourceFilter"]
    assert source["spotNames"] == ["cutcontour", "die-line"]
    assert source["dieLayerNames"] == ["aaa", "khuôn bế"]
    assert source["colorTolerance"] == 0.012346
    assert source["geometryToleranceMm"] == 0.1
    assert style["stroke"]["widthMm"] == 0.25


def test_cut_style_process_mode_va_separation_di_qua_duoc() -> None:
    """Nhận nét bế theo màu process, vẽ ra bằng kênh separation riêng."""

    style = _built_cut_style(
        cut_style=ImpositionCutStyleSpec(
            source_filter=ImpositionCutSourceFilterSpec(
                mode="process",
                spot_names=(),
                process_space="cmyk",
                process_components=(0.0, 1.0, 1.0, 0.0),
            ),
            stroke=ImpositionCutStrokeSpec(
                color_space="separation",
                components=(1.0,),
                separation_name="CutContour",
                alternate_space="cmyk",
                alternate_components=(0.0, 1.0, 0.0, 0.0),
            ),
        )
    )
    assert style["sourceFilter"]["mode"] == "process"
    assert style["sourceFilter"]["spotNames"] == []
    assert style["sourceFilter"]["processColor"] == {
        "space": "cmyk",
        "components": [0.0, 1.0, 1.0, 0.0],
    }
    assert style["stroke"]["colorSpace"] == "separation"
    assert style["stroke"]["separationName"] == "cutcontour"
    assert style["stroke"]["alternate"] == {
        "space": "cmyk",
        "components": [0.0, 1.0, 0.0, 0.0],
    }
    assert _cut_style_through_adapter(style) == style


@pytest.mark.parametrize(
    "spec,match",
    [
        (
            ImpositionCutSourceFilterSpec(mode="spot", spot_names=()),
            "không được rỗng khi mode=spot",
        ),
        (
            ImpositionCutSourceFilterSpec(
                mode="spot", process_space="cmyk", process_components=(0.0, 0.0, 0.0, 1.0)
            ),
            "không được khai màu process khi mode=spot",
        ),
        (
            ImpositionCutSourceFilterSpec(mode="process", spot_names=("cutcontour",)),
            "phải rỗng khi mode=process",
        ),
        (
            ImpositionCutSourceFilterSpec(mode="process", spot_names=(), process_space=None),
            "process_space không được hỗ trợ",
        ),
        (
            ImpositionCutSourceFilterSpec(
                mode="process", spot_names=(), process_space="cmyk", process_components=(0.0, 1.0)
            ),
            "đúng 4 thành phần màu",
        ),
        (
            ImpositionCutSourceFilterSpec(
                mode="process", spot_names=(), process_space="rgb", process_components=(0.0, 1.5, 0.0)
            ),
            "khoảng 0..1",
        ),
        (
            ImpositionCutSourceFilterSpec(spot_names=("cutcontour", "CUTCONTOUR")),
            "không được trùng",
        ),
        (
            ImpositionCutSourceFilterSpec(spot_names=("cut\ncontour",)),
            "điều khiển",
        ),
        (ImpositionCutSourceFilterSpec(spot_names=("x" * 129,)), "129|128"),
        (ImpositionCutSourceFilterSpec(color_tolerance=0.6), "color_tolerance vượt"),
        (
            ImpositionCutSourceFilterSpec(geometry_tolerance_mm=0.0),
            "geometry_tolerance_mm phải lớn hơn 0",
        ),
        (
            ImpositionCutSourceFilterSpec(geometry_tolerance_mm=1.5),
            "geometry_tolerance_mm phải lớn hơn 0",
        ),
        (ImpositionCutSourceFilterSpec(spot_names="cutcontour"), "phải là tuple chuỗi"),
        (ImpositionCutSourceFilterSpec(color_tolerance=True), "phải là số hữu hạn"),
        (
            ImpositionCutSourceFilterSpec(color_tolerance=float("nan")),
            "phải là số hữu hạn|chuẩn hoá",
        ),
        (
            ImpositionCutSourceFilterSpec(color_tolerance=float("inf")),
            "phải là số hữu hạn|chuẩn hoá",
        ),
        (ImpositionCutSourceFilterSpec(color_tolerance=-0.1), "không được âm"),
    ],
)
def test_cut_style_builder_chan_source_filter_sai(spec, match) -> None:
    with pytest.raises(ImpositionRenderBundleError, match=match):
        _built_cut_style(cut_style=ImpositionCutStyleSpec(source_filter=spec))


@pytest.mark.parametrize(
    "spec,match",
    [
        (ImpositionCutStrokeSpec(width_mm=0.0), "width_mm phải lớn hơn 0"),
        (ImpositionCutStrokeSpec(width_mm=10.5), "width_mm phải lớn hơn 0"),
        (ImpositionCutStrokeSpec(width_mm=-0.25), "không được âm"),
        (ImpositionCutStrokeSpec(width_mm=True), "phải là số hữu hạn"),
        (ImpositionCutStrokeSpec(width_mm=float("nan")), "phải là số hữu hạn|chuẩn hoá"),
        (ImpositionCutStrokeSpec(width_mm=float("inf")), "phải là số hữu hạn|chuẩn hoá"),
        (ImpositionCutStrokeSpec(color_space="lab"), "color_space không được hỗ trợ"),
        (
            ImpositionCutStrokeSpec(color_space="rgb", components=(0.0, 1.0, 0.0, 0.0)),
            "đúng 3 thành phần màu",
        ),
        (
            ImpositionCutStrokeSpec(color_space="gray", components=()),
            "đúng 1 thành phần màu",
        ),
        (
            ImpositionCutStrokeSpec(components=(0.0, 1.0, 0.0, 2.0)),
            "khoảng 0..1",
        ),
        (
            ImpositionCutStrokeSpec(color_space="separation", components=(1.0,)),
            "separation_name",
        ),
        (
            ImpositionCutStrokeSpec(separation_name="CutContour"),
            "chỉ dùng cho colorSpace=separation",
        ),
        # NEST §A3.1: separation thiếu alternate ⇒ writer không dựng nổi
        # /Separation, nên phải chặn ngay ở builder.
        (
            ImpositionCutStrokeSpec(
                color_space="separation",
                components=(1.0,),
                separation_name="CutContour",
            ),
            "alternate_space bắt buộc",
        ),
        (
            ImpositionCutStrokeSpec(
                color_space="separation",
                components=(1.0,),
                separation_name="CutContour",
                alternate_space="cmyk",
                alternate_components=(0.0, 0.0, 0.0, 0.0),
            ),
            "alternate_components phải có kênh lớn hơn 0",
        ),
        (
            ImpositionCutStrokeSpec(alternate_space="cmyk"),
            r"alternate_\* chỉ dùng cho colorSpace=separation",
        ),
        (ImpositionCutStrokeSpec(overprint=1), "overprint phải là boolean"),
        (ImpositionCutStrokeSpec(components=0.5), "phải là tuple số"),
    ],
)
def test_cut_style_builder_chan_stroke_sai(spec, match) -> None:
    with pytest.raises(ImpositionRenderBundleError, match=match):
        _built_cut_style(cut_style=ImpositionCutStyleSpec(stroke=spec))


@pytest.mark.parametrize(
    "spec,match",
    [
        ({"sourceFilter": {}}, "thiếu stroke"),
        ("khong-phai-object", "phải là object"),
    ],
)
def test_cut_style_builder_chan_style_khong_dung_kieu(spec, match) -> None:
    """Builder chỉ nhận spec typed; dict thô hoặc chuỗi phải bị chặn ngay."""

    with pytest.raises(ImpositionRenderBundleError, match="ImpositionCutStyleSpec"):
        _built_cut_style(cut_style=spec)
    # Nhưng adapter vẫn phải tự chặn được khi nhận cùng payload thô đó.
    with pytest.raises(Exception, match=match):
        _cut_style_through_adapter(spec)


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda style: style.pop("stroke"), "thiếu stroke"),
        (lambda style: style.update(extra=1), "field lạ extra"),
        (
            lambda style: style["sourceFilter"].update(extra=1),
            "field lạ extra",
        ),
        (
            lambda style: style["sourceFilter"].pop("geometryToleranceMm"),
            "thiếu geometryToleranceMm",
        ),
        (
            lambda style: style["stroke"].__setitem__("overprint", 1),
            "overprint phải là boolean",
        ),
        (
            lambda style: style["stroke"].__setitem__("widthMm", True),
            "phải là số hữu hạn",
        ),
        (
            lambda style: style["stroke"].__setitem__("widthMm", float("nan")),
            "phải là số hữu hạn|chuẩn hoá",
        ),
        (
            lambda style: style["stroke"].__setitem__("widthMm", float("inf")),
            "phải là số hữu hạn|chuẩn hoá",
        ),
        (
            lambda style: style["stroke"].__setitem__("components", [0.0, 1.0, 0.0]),
            "đúng 4 thành phần màu",
        ),
        (
            lambda style: style["stroke"].__setitem__("components", [0.0, True, 0.0, 0.0]),
            "phải là số hữu hạn",
        ),
        (
            lambda style: style["sourceFilter"].__setitem__("mode", "layer"),
            "mode không được hỗ trợ",
        ),
        (
            lambda style: style["sourceFilter"].__setitem__("spotNames", []),
            "không được rỗng khi mode=spot",
        ),
        (
            lambda style: style["sourceFilter"].__setitem__(
                "processColor", {"space": "cmyk", "components": [0.0, 0.0, 0.0, 1.0]}
            ),
            "phải là null khi mode=spot",
        ),
        (
            lambda style: style["sourceFilter"].__setitem__("colorTolerance", 0.9),
            "colorTolerance phải trong khoảng",
        ),
        (
            lambda style: style["sourceFilter"].__setitem__("geometryToleranceMm", 0.0),
            "geometryToleranceMm phải lớn hơn 0",
        ),
        (
            lambda style: style["sourceFilter"].__setitem__("spotNames", ["a", "a"]),
            "không được trùng",
        ),
    ],
)
def test_adapter_chan_cut_style_sai_hop_dong(mutate, match) -> None:
    """Adapter là biên enforcement cuối: payload thô sai phải fail-closed."""

    style = _built_cut_style()
    mutate(style)
    with pytest.raises(Exception, match=match):
        _cut_style_through_adapter(style)


def test_cut_style_thieu_hoan_toan_thi_bundle_bi_tu_choi() -> None:
    parts = (_part("part-0", _pin("a"), duplex=False, x=0.0),)
    bundle = build_imposition_render_bundle_v2(_cut_context(), parts).render_bundle
    bundle.pop("cutStyle")
    with pytest.raises(Exception, match="thiếu cutStyle"):
        build_production_request(
            _request(parts, "quantity_fulfillment"),
            job_id=JOB_ID,
            request_revision=1,
            render_bundle=bundle,
            clearance={
                "partToPart": {"xMm": 2.0, "yMm": 2.0},
                "partToSheetEdge": {"xMm": 1.0, "yMm": 1.0},
                "partToObstacle": {"xMm": 1.0, "yMm": 1.0},
            },
            algorithm_versions=_versions(),
            native_build_identity=BUILD_IDENTITY,
        )


@pytest.mark.parametrize("requested_qty", [True, 0, -1, 1.5, "17"])
def test_artifact_report_reject_requested_quantity_khong_hop_le(requested_qty) -> None:
    """Demand report S&R chỉ nhận số nguyên dương; không nới contract solver."""

    pin = _pin("a")
    with pytest.raises(ImpositionRenderBundleError, match="số nguyên dương"):
        build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="sticker_imposer",
                task_mode="step_repeat",
                layout_intent="step_repeat_single_sheet",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
                artifact_options=ImpositionArtifactOptions(
                    report=ImpositionReportEnabled(
                        fields=("actualQty",), requested_qty=requested_qty
                    )
                ),
            ),
            (_part("tem", pin, duplex=False, x=0.0),),
        )


def test_artifact_report_requested_quantity_chi_persist_khi_co_anh_huong() -> None:
    """Demand S&R không được làm đổi artifact khi mọi field phụ thuộc đều ẩn."""

    pin = _pin("a")
    part = _part("tem", pin, duplex=False, x=0.0)

    def build(fields: tuple[str, ...], requested_qty: int) -> dict:
        return build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="sticker_imposer",
                task_mode="step_repeat",
                layout_intent="step_repeat_single_sheet",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
                artifact_options=ImpositionArtifactOptions(
                    report=ImpositionReportEnabled(
                        fields=fields, requested_qty=requested_qty
                    )
                ),
            ),
            (part,),
        ).render_bundle["artifactOptions"]["report"]

    assert build(("actualQty",), 17)["requestedQty"] == 17
    assert build(("sheetCount",), 18)["requestedQty"] == 18
    assert build(("labelName",), 19)["requestedQty"] is None

    with pytest.raises(ImpositionRenderBundleError, match="chỉ dùng"):
        build_imposition_render_bundle_v2(
            ImpositionRenderContext(
                tool="sticker_imposer",
                task_mode="nup",
                layout_intent="quantity_fulfillment",
                sheet_width_mm=320.0,
                sheet_height_mm=450.0,
                artifact_options=ImpositionArtifactOptions(
                    report=ImpositionReportEnabled(
                        fields=("actualQty",), requested_qty=17
                    )
                ),
            ),
            (part,),
        )

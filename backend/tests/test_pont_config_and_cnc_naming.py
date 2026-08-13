from __future__ import annotations

import io

import pikepdf
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routes import imposition as imposition_route
from app.api.routes.imposition import PreviewLayoutRequest
from app.schemas.pont import normalize_pont_settings, validate_pont_config
from app.workers import nup_engine, pdf_wrapper as pdf_lib
from app.workers.cnc_render import run_cnc_two_sided


PONT_CONFIG = {
    "shape": "circle",
    "size": 5.0,
    "thickness": 0.5,
    "marginTop": 7.0,
    "marginBottom": 7.0,
    "marginLeft": 7.0,
    "marginRight": 7.0,
    "disableCollision": True,
    "isGraphtec": True,
    "layerInfoName": "AUDIT_GRAPH_INFO",
    "layerName": "AUDIT_LAYER",
    "groupName": "AUDIT_GROUP",
    "itemName": "AUDIT_ITEM",
}


def _make_plain_pdf(path, pages):
    doc = pdf_lib.open()
    for _ in range(pages):
        doc.new_page(width=100 * 2.83465, height=70 * 2.83465)
    buffer = io.BytesIO()
    doc.save(buffer, garbage=0, deflate=True)
    doc.close()
    path.write_bytes(buffer.getvalue())


def _named_items(page):
    properties = page.Resources.get("/Properties", {})
    names = []
    for instruction in pikepdf.parse_content_stream(page):
        if (
            str(instruction.operator) == "BDC"
            and len(instruction.operands) == 2
            and str(instruction.operands[0]) == "/Span"
        ):
            resource_name = pikepdf.Name(str(instruction.operands[1]))
            names.append(str(properties[resource_name].get("/NM", "")))
    return names


def _order_names(value):
    names = []
    for item in value:
        if isinstance(item, pikepdf.Array):
            names.extend(_order_names(item))
        elif isinstance(item, pikepdf.Dictionary) and "/Name" in item:
            names.append(str(item["/Name"]))
    return names


def _preview_request(pont_config):
    return PreviewLayoutRequest(
        usable_w=500,
        usable_h=700,
        item_w=100,
        item_h=80,
        gap_x=0,
        gap_y=0,
        strategy="manual",
        pont_config=pont_config,
    )


def test_pont_config_fills_writer_defaults_without_mutating_input():
    source = {"shape": "circle", "size": 5, "thickness": 0.5}
    normalized = validate_pont_config(source)

    assert source == {"shape": "circle", "size": 5, "thickness": 0.5}
    assert normalized["layerName"] == "Marks_Model_"
    assert normalized["groupName"] == "MarkLine"
    assert normalized["itemName"] == "MKLINE"


def test_empty_config_and_invalid_pont_type_are_rejected():
    with pytest.raises(ValueError, match="thiếu dữ liệu"):
        validate_pont_config({})
    with pytest.raises(ValueError, match="pontType"):
        normalize_pont_settings({"pontType": 1, "pontConfig": dict(PONT_CONFIG)})


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"size": 0}, "size"),
        ({"size": -1}, "size"),
        ({"size": float("nan")}, "hữu hạn"),
        ({"thickness": 0}, "thickness"),
        ({"shape": "triangle"}, "shape"),
        ({"layerName": "   "}, "tên lớp"),
        ({"groupName": ""}, "tên nhóm"),
        ({"itemName": ""}, "tên đối tượng"),
        ({"isGraphtec": True, "layerInfoName": ""}, "Graphtec"),
    ],
)
def test_pont_config_rejects_silent_invalid_artifacts(override, message):
    with pytest.raises(ValueError, match=message):
        validate_pont_config({**PONT_CONFIG, **override})


def test_preview_schema_uses_the_same_pont_validation():
    with pytest.raises(ValidationError, match="size"):
        _preview_request({**PONT_CONFIG, "size": 0})


def test_nup_engine_rejects_invalid_pont_before_opening_source_pdf():
    with pytest.raises(ValueError, match="size"):
        nup_engine.run_nup_engine(
            "file-khong-ton-tai.pdf",
            "output-khong-duoc-tao.pdf",
            {
                "pontType": "custom",
                "pontConfig": {**PONT_CONFIG, "size": 0},
            },
        )


def test_impose_route_rejects_invalid_pont_before_creating_job(monkeypatch):
    monkeypatch.setattr(imposition_route, "_validate_file_path", lambda _path: "source.pdf")

    with pytest.raises(HTTPException) as error:
        imposition_route._launch_impose_job(
            {
                "source_path": "ignored.pdf",
                "settings": {
                    "pontType": "custom",
                    "pontConfig": {**PONT_CONFIG, "itemName": ""},
                },
            },
            "audit-pont",
        )

    assert error.value.status_code == 422
    assert "tên đối tượng" in str(error.value.detail)


@pytest.mark.parametrize(
    ("two_sided", "expected_names_per_page"),
    [(False, [4, 4]), (True, [4, 0, 4])],
)
@pytest.mark.parametrize("pont_shape", ["circle", "l_corner", "l_inverted"])
def test_cnc_keeps_pont_layers_items_and_front_cut_contract(
    tmp_path,
    two_sided,
    expected_names_per_page,
    pont_shape,
):
    source = tmp_path / f"cnc-pont-source-{pont_shape}-{two_sided}.pdf"
    output = tmp_path / f"cnc-pont-output-{pont_shape}-{two_sided}.pdf"
    _make_plain_pdf(source, 2 if two_sided else 1)

    run_cnc_two_sided(
        str(source),
        str(output),
        {
            "cncTwoSided": two_sided,
            "sheetWidth": 180,
            "sheetHeight": 240,
            "layoutType": "repeat",
            "gridStrategy": "manual",
            "marginTop": 10,
            "marginBottom": 10,
            "marginLeft": 10,
            "marginRight": 10,
            "targetQuantity": 1,
            "pontType": "custom",
            "pontConfig": {**PONT_CONFIG, "shape": pont_shape},
            # Hợp đồng CNC cố ý luôn Front + Cut, không dùng toggle của Sticker.
            "pontsOnCutFile": False,
        },
        job_id=f"cnc-pont-{two_sided}",
    )

    with pikepdf.open(output) as pdf:
        assert [_named_items(page) for page in pdf.pages] == [
            ["AUDIT_ITEM"] * count for count in expected_names_per_page
        ]
        ocg_names = [
            str(item.get("/Name", ""))
            for item in pdf.Root["/OCProperties"]["/OCGs"]
        ]
        assert ocg_names == ["AUDIT_GRAPH_INFO", "AUDIT_LAYER", "AUDIT_GROUP"]
        assert _order_names(pdf.Root["/OCProperties"]["/D"]["/Order"]) == ocg_names

    rendered = pdf_lib.open(str(output))
    try:
        for page_index, expected_count in enumerate(expected_names_per_page):
            paths = rendered[page_index].extract_vector_paths()
            # PAGE-DIE (audit 2026-08-13 §CNC.PAGE.1): file không có CutContour
            # dùng chính kích thước trang làm khuôn. Các clip/khuôn này là bốn
            # hình chữ nhật lớn; boong là bốn path nhỏ mang itemName riêng.
            die_paths = [
                path for path in paths
                if path.get("color") == (0.0, 1.0, 1.0, 0.0)
            ]
            pont_paths = [path for path in paths if path not in die_paths]
            assert len(die_paths) == (4 if page_index == len(expected_names_per_page) - 1 else 0)
            assert len(pont_paths) == expected_count
            if pont_shape == "circle":
                assert all(path.get("fill") is not None for path in pont_paths)
            else:
                assert all(path.get("fill") is None for path in pont_paths)
    finally:
        rendered.close()

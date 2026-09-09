"""Giữ cây layer boong qua bước ghép cuối S&R, trước khi tách mở Illustrator."""

from pathlib import Path

import pikepdf
import pytest

from app.workers.nesting_imposition_render import (
    _attach_pont_page_properties,
    _install_pont_layers,
)
from app.workers.nup_true_shape_nesting import _concat_pdf_pages_impl


def _write_sheet(path: Path, sides: tuple[bool, ...], *, graphtec=True, hidden=False):
    with pikepdf.Pdf.new() as pdf:
        context = _install_pont_layers(pdf, {
            "isGraphtec": graphtec,
            "layerInfoName": "SA info PROBE",
            "layerName": "Marks_Model_",
            "groupName": "MarkLine",
            "itemName": "MKLINE",
        })
        if hidden:
            # Nguồn thứ hai dùng BaseState khác, không được bật lại khi ghép.
            default = pdf.Root.OCProperties.D
            default.BaseState = pikepdf.Name.OFF
            default.ON = pikepdf.Array([])
            default.OFF = pikepdf.Array([])
        for has_marks in sides:
            page = pdf.add_blank_page(page_size=(100, 100))
            if has_marks:
                _attach_pont_page_properties(page, context)
                page.obj.Contents = pikepdf.Stream(pdf, (
                    b"/OC /MC_PONT_GROUP BDC /Span /NM_PONT_ITEM BDC "
                    b"0 0 m 10 10 l S EMC EMC"
                ))
        pdf.save(path)


@pytest.mark.parametrize("sides", [(False, True), (True, True), (True, False, True)])
@pytest.mark.parametrize("sheet_count,graphtec", [(1, True), (2, True), (2, False)])
def test_concat_giu_layer_va_item_tung_to(tmp_path, sides, sheet_count, graphtec):
    """Sticker/CNC 1-2 mặt: giữ OCG rỗng, cây cha-con và ref riêng dù tên trùng."""
    sources = []
    original_streams = []
    for index in range(sheet_count):
        path = tmp_path / f"sheet-{index}.pdf"
        _write_sheet(path, sides, graphtec=graphtec, hidden=index == 1)
        sources.append(str(path))
        with pikepdf.open(path) as pdf:
            original_streams.extend(page.obj.Contents.read_bytes() for page in pdf.pages)

    output = tmp_path / "merged.pdf"
    assert _concat_pdf_pages_impl(sources, output) == len(sides) * sheet_count
    with pikepdf.open(output) as pdf:
        assert "/OCProperties" in pdf.Root
        props = pdf.Root.OCProperties
        names = (["SA info PROBE"] if graphtec else []) + ["Marks_Model_", "MarkLine"]
        assert [str(ocg.Name) for ocg in props.OCGs] == names * sheet_count
        assert len({ocg.objgen for ocg in props.OCGs}) == len(names) * sheet_count
        default = props.D
        on_ids = {ocg.objgen for ocg in default.ON}
        off_ids = {ocg.objgen for ocg in default.OFF}
        assert str(default.BaseState) == "/ON"
        assert len(default.Order) == len(names) * sheet_count
        for index in range(sheet_count):
            offset = index * len(names)
            ocgs = list(props.OCGs)[offset:offset + len(names)]
            order = list(default.Order)[offset:offset + len(names)]
            assert [ref.objgen for ref in order[:-1]] == [ref.objgen for ref in ocgs[:-1]]
            assert order[-1][0].objgen == ocgs[-1].objgen
            assert {ref.objgen for ref in ocgs} <= (off_ids if index == 1 else on_ids)
            for side, has_marks in enumerate(sides):
                page_index = index * len(sides) + side
                page = pdf.pages[page_index]
                assert page.obj.Contents.read_bytes() == original_streams[page_index]
                properties = page.obj.Resources.get("/Properties", {})
                if has_marks:
                    assert properties["/MC_PONT_GROUP"].objgen == ocgs[-1].objgen
                    assert str(properties["/NM_PONT_ITEM"].NM) == "MKLINE"
                else:
                    assert not properties
        assert not on_ids & off_ids
        assert pdf.check_pdf_syntax() == []


@pytest.mark.parametrize("plain_first", [True, False])
def test_concat_nguon_khong_layer_khong_lam_mat_layer_nguon_khac(tmp_path, plain_first):
    plain = tmp_path / "plain.pdf"
    layered = tmp_path / "layered.pdf"
    with pikepdf.Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(plain)
    _write_sheet(layered, (True,))
    sources = [plain, layered] if plain_first else [layered, plain]
    output = tmp_path / "merged.pdf"
    _concat_pdf_pages_impl([str(path) for path in sources], output)
    with pikepdf.open(output) as pdf:
        assert len(pdf.Root.OCProperties.OCGs) == 3
        marked_page = pdf.pages[1 if plain_first else 0]
        assert marked_page.obj.Resources.Properties.MC_PONT_GROUP.objgen == (
            pdf.Root.OCProperties.OCGs[-1].objgen
        )


def test_concat_khong_them_layer_vao_pdf_thuong(tmp_path):
    source = tmp_path / "plain.pdf"
    with pikepdf.Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source)
    output = tmp_path / "merged.pdf"
    _concat_pdf_pages_impl([str(source)], output)
    with pikepdf.open(output) as pdf:
        assert "/OCProperties" not in pdf.Root


def test_concat_giu_ref_layer_trong_form_va_override_an_hien(tmp_path):
    sources = []
    for index in range(2):
        path = tmp_path / f"form-{index}.pdf"
        _write_sheet(path, (True,), hidden=index == 1)
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            page = pdf.pages[0]
            default = pdf.Root.OCProperties.D
            group = pdf.Root.OCProperties.OCGs[-1]
            default["/ON" if index == 1 else "/OFF"] = pikepdf.Array([group])
            # OCG không còn ở resource trang trực tiếp, chỉ nằm trong Form lồng.
            form = pdf.make_indirect(page.as_form_xobject())
            page.obj.Resources = pikepdf.Dictionary({
                "/XObject": pikepdf.Dictionary({"/Marks": form}),
            })
            page.obj.Contents = pikepdf.Stream(pdf, b"/Marks Do")
            pdf.save(path)
        sources.append(str(path))
    output = tmp_path / "merged.pdf"
    _concat_pdf_pages_impl(sources, output)
    with pikepdf.open(output) as pdf:
        props = pdf.Root.OCProperties
        on_ids = {ref.objgen for ref in props.D.ON}
        off_ids = {ref.objgen for ref in props.D.OFF}
        for index, page in enumerate(pdf.pages):
            group = page.obj.Resources.XObject.Marks.Resources.Properties.MC_PONT_GROUP
            assert group.objgen == props.OCGs[index * 3 + 2].objgen
            assert group.objgen in (on_ids if index == 1 else off_ids)
        assert not on_ids & off_ids


def test_concat_loi_layer_khong_publish_file_mat_metadata(tmp_path, monkeypatch):
    from app.workers import nup_true_shape_nesting as nts

    source = tmp_path / "source.pdf"
    _write_sheet(source, (True,))
    output = tmp_path / "merged.pdf"
    output.write_bytes(b"old-output")

    def fail_transfer(*_args):
        raise ValueError("Không thể chuyển cây layer")

    monkeypatch.setattr(nts, "_append_step_repeat_layers", fail_transfer)
    with pytest.raises(ValueError, match="Không thể chuyển cây layer"):
        nts._concat_pdf_pages_impl([str(source)], output)
    assert output.read_bytes() == b"old-output"
    assert not list(tmp_path.glob(".nup_sr_merge_*.pdf"))
    with pikepdf.open(source) as pdf:
        assert len(pdf.Root.OCProperties.OCGs) == 3

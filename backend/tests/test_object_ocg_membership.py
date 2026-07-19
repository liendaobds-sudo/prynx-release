from __future__ import annotations

from io import BytesIO

import pikepdf

from app.core import geometry_reader
from app.core.object_mapper import build_op_spans, enrich_object_ocg_memberships


def _layered_pdf_bytes() -> tuple[bytes, dict[str, int]]:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))

    layer_a = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/OCG'), Name=pikepdf.String('Layer A')
    ))
    layer_b = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/OCG'), Name=pikepdf.String('Layer B')
    ))
    ocmd = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/OCMD'),
        OCGs=pikepdf.Array([layer_a, layer_b]),
        P=pikepdf.Name('/AnyOn'),
    ))
    pdf.Root['/OCProperties'] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([layer_a, layer_b]),
        D=pikepdf.Dictionary(
            Order=pikepdf.Array([layer_a, layer_b]),
            ON=pikepdf.Array([layer_a, layer_b]),
            OFF=pikepdf.Array(),
        ),
    )
    properties = pikepdf.Dictionary()
    properties['/LayerA'] = layer_a
    properties['/LayerB'] = layer_b
    properties['/Both'] = ocmd
    page.obj['/Resources'] = pikepdf.Dictionary(Properties=properties)
    page.obj['/Contents'] = pdf.make_stream(b'''\
0 0 1 rg 10 10 20 20 re f
/OC /LayerA BDC
  1 0 0 rg 50 10 20 20 re f
  /OC /LayerB BDC
    0 1 0 rg 90 10 20 20 re f
  EMC
EMC
/OC /Both BDC
  0 0 0 rg 130 10 20 20 re f
EMC
''')
    ids = {'a': layer_a.objgen[0], 'b': layer_b.objgen[0]}
    out = BytesIO()
    pdf.save(out)
    data = out.getvalue()
    with pikepdf.Pdf.open(BytesIO(data)) as reopened:
        live_layers = list(reopened.Root['/OCProperties']['/OCGs'])
        ids = {'a': live_layers[0].objgen[0], 'b': live_layers[1].objgen[0]}
    return data, ids


def _by_left(objects):
    return {round(obj.bbox[0]): obj for obj in objects}


def test_content_spans_track_nested_ocg_and_ocmd_membership():
    data, ids = _layered_pdf_bytes()
    with pikepdf.Pdf.open(BytesIO(data)) as pdf:
        spans = build_op_spans(pdf.pages[0], pdf=pdf, coalesce=False)

    by_left = {round(span.bbox[0]): span for span in spans if span.kind == 'vector'}
    assert by_left[10].ocgIds == []
    assert by_left[50].ocgIds == [ids['a']]
    assert by_left[90].ocgIds == sorted([ids['a'], ids['b']])
    assert by_left[130].ocgIds == sorted([ids['a'], ids['b']])


def test_pdfium_objects_are_enriched_with_current_page_ocg_ids():
    data, ids = _layered_pdf_bytes()
    objects = geometry_reader.list_objects(data, 0, include_text_props=False)
    with pikepdf.Pdf.open(BytesIO(data)) as pdf:
        enrich_object_ocg_memberships(pdf.pages[0], objects, pdf)

    by_left = _by_left(objects)
    assert by_left[10].ocgIds == []
    assert by_left[50].ocgIds == [ids['a']]
    assert by_left[90].ocgIds == sorted([ids['a'], ids['b']])
    assert by_left[130].ocgIds == sorted([ids['a'], ids['b']])


def test_duplicate_catalog_names_use_unique_page_resource_not_global_guess():
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    unused = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/OCG'), Name=pikepdf.String('Same name')
    ))
    used = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/OCG'), Name=pikepdf.String('Same name')
    ))
    pdf.Root['/OCProperties'] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([unused, used]),
        D=pikepdf.Dictionary(Order=pikepdf.Array([unused, used])),
    )
    props = pikepdf.Dictionary()
    props['/OnlyHere'] = used
    page.obj['/Resources'] = pikepdf.Dictionary(Properties=props)

    obj = {
        'id': 'vector-0', 'drawIndex': 0, 'type': 'vector',
        'bbox': [0, 0, 10, 10], 'ocgIds': [], 'ocgNames': ['Same name'],
    }
    enrich_object_ocg_memberships(page, [obj], pdf)
    assert obj['ocgIds'] == [used.objgen[0]]


def test_prynx_internal_ocg_is_not_exposed_as_pdf_layer_membership():
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    internal = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/OCG'),
        Name=pikepdf.String('PrynX hidden object'),
        PrynXInternal=True,
    ))
    pdf.Root['/OCProperties'] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([internal]), D=pikepdf.Dictionary(Order=pikepdf.Array())
    )
    props = pikepdf.Dictionary()
    props['/Internal'] = internal
    page.obj['/Resources'] = pikepdf.Dictionary(Properties=props)
    obj = {
        'id': 'vector-0', 'drawIndex': 0, 'type': 'vector',
        'bbox': [0, 0, 10, 10], 'ocgIds': [],
        'ocgNames': ['PrynX hidden object'],
    }

    enrich_object_ocg_memberships(page, [obj], pdf)
    assert obj['ocgIds'] == []
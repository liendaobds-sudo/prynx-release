"""QUALITY (audit 2026-09-24 §CUT24.D01): cận mm và quỹ đạo sau CTM."""
from io import BytesIO
import math

import numpy as np
import pikepdf
import pytest
from shapely.geometry import LineString, Point

from app.workers.cut_export.cut_layer_extractor import extract_cut_contours_from_pdf
from app.workers.cut_export.geometry import FLATTEN_TOL_MM, flatten_cubic_bezier
from app.workers.cut_export.pdf_source import _build_cut_model_from_result

PT = 72 / 25.4
K = 4 * (math.sqrt(2) - 1) / 3


def source_pdf(*, normalized=False, unit=1, form=False, open_path=False):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(300*PT/unit, 300*PT/unit))
    page.UserUnit = unit
    resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(
        CutContour=pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name.CutContour,
            pikepdf.Name.DeviceCMYK, pikepdf.Dictionary(FunctionType=2,
                Domain=[0,1], C0=[0,0,0,0], C1=[0,1,0,0], N=1)])))
    radius = 1 if normalized else 100*PT/unit
    matrix = 100*PT/unit if normalized else 1
    stream = (f"/CutContour CS 1 SCN {radius} 0 m "
              f"{radius} {radius*K} {radius*K} {radius} 0 {radius} c "
              + ("S" if open_path else "0 0 l h S"))
    transform = f"{matrix} 0 0 {matrix} {150*PT/unit} {150*PT/unit} cm "
    if form:
        obj = pdf.make_stream(stream.encode())
        obj.Type = pikepdf.Name.XObject
        obj.Subtype = pikepdf.Name.Form
        obj.BBox = [-radius,-radius,radius,radius]
        obj.Resources = resources
        obj.Matrix = [matrix,0,0,matrix,150*PT/unit,150*PT/unit]
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm=obj))
        page.Contents = pdf.make_stream(b"/Fm Do")
    else:
        page.Resources = resources
        page.Contents = pdf.make_stream((transform+stream).encode())
    return pdf


def cubic_samples(points, count=1001):
    p = np.asarray(points)
    t = np.linspace(0,1,count)[:,None]
    return (1-t)**3*p[0]+3*(1-t)**2*t*p[1]+3*(1-t)*t**2*p[2]+t**3*p[3]


@pytest.mark.parametrize("normalized,unit,form", [(False,1,False),(True,1,False),
    (True,4,False),(True,3,True),(False,2,True)])
def test_ctm_userunit_form_keeps_physical_error_budget(normalized,unit,form):
    with source_pdf(normalized=normalized,unit=unit,form=form,open_path=True) as pdf:
        result = extract_cut_contours_from_pdf(pdf)
        model = _build_cut_model_from_result(pdf,0,result,None)
    assert model.sheet_w_mm == pytest.approx(300)
    assert model.sheet_h_mm == pytest.approx(300)
    assert len(model.paths) == 1 and not model.paths[0].closed
    poly = LineString(model.paths[0].points)
    samples = cubic_samples([(250,150),(250,150+100*K),(150+100*K,250),(150,250)])
    assert max(poly.distance(Point(p)) for p in samples) <= FLATTEN_TOL_MM


def test_equivalent_ctm_representations_have_equal_polyline():
    models = []
    for normalized in (False,True):
        with source_pdf(normalized=normalized) as pdf:
            models.append(_build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None))
    assert np.asarray(models[0].paths[0].points) == pytest.approx(np.asarray(models[1].paths[0].points), abs=1e-5)


@pytest.mark.parametrize("controls", [((0,0),(50,0),(-50,0),(1,0)),
    ((0,0),(10,20),(-10,20),(0,0)), ((0,0),(0,200),(200,0),(200,200))])
def test_adaptive_flatten_keeps_backtracking_loop_and_high_curvature(controls):
    points = flatten_cubic_bezier(*controls, max_seg_mm=.01)
    line = LineString(points)
    assert points[0] == controls[0] and points[-1] == controls[-1]
    assert max(line.distance(Point(p)) for p in cubic_samples(controls)) <= .01
    assert len(points) > 2


@pytest.mark.parametrize("tolerance", [0,-1,float('nan'),float('inf')])
def test_invalid_flatten_tolerance_rejected(tolerance):
    with pytest.raises(ValueError):
        flatten_cubic_bezier((0,0),(1,1),(2,1),(3,0), tolerance)


def test_primitive_survives_pdf_ctm_and_registration_with_physical_budget():
    from app.workers.cut_export.registration import apply_affine, Affine2x3
    with source_pdf(normalized=True,unit=2,form=True,open_path=True) as pdf:
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None)
    original = model.paths[0]
    assert len(original.vector_segments()) == 1
    assert len(original.vector_segments()[0]) == 4
    affine = Affine2x3(-4,1,30,0,2,15)
    warped = apply_affine(model,affine).paths[0]
    controls = tuple(affine.apply(*p) for p in original.segments[0])
    assert warped.segments == (controls,)
    assert not warped.closed
    line = LineString(warped.points)
    assert max(line.distance(Point(p)) for p in cubic_samples(controls)) <= FLATTEN_TOL_MM
    assert original.points != warped.points


def test_legacy_point_mutation_cannot_emit_stale_primitive():
    from app.workers.cut_export.cut_model import CutPath
    path = CutPath(points=[],closed=False,segments=(((0,0),(0,1),(1,1),(1,0)),))
    assert path.vector_segments()
    path.points[0] = (2,3)
    assert not path.vector_segments()
    path = CutPath(points=[],closed=False,segments=(((0,0),(0,1),(1,1),(1,0)),))
    path.segments = (((0,0),(1,0)),)
    assert not path.vector_segments()


def test_holes_winding_and_close_are_preserved_in_primitive_model():
    with source_pdf() as pdf:
        page = pdf.pages[0]
        page.Contents = pdf.make_stream(b'/CutContour CS 1 SCN '
            b'10 10 m 90 10 l 90 90 l 10 90 l h '
            b'30 30 m 30 70 l 70 70 l 70 30 l h S')
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None)
    assert len(model.paths) == 2 and all(p.closed for p in model.paths)
    areas = [sum(a[0]*b[1]-a[1]*b[0] for a,b in zip(p.points,p.points[1:])) for p in model.paths]
    assert areas[0] > 0 and areas[1] < 0
    assert all(len(p.segments) == 4 for p in model.paths)


def test_vector_emitters_preserve_cubic_after_registration():
    import re
    from app.workers.cut_export.registration import apply_affine, Affine2x3
    from app.workers.cut_export.emitters.pdf_spot import PdfSpotEmitter
    from app.workers.cut_export.emitters.svg import SvgEmitter
    with source_pdf(normalized=True,unit=4,form=True,open_path=True) as pdf:
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None)
    model = apply_affine(model,Affine2x3(1,.2,2,-.1,1,3))
    controls = model.paths[0].segments[0]
    output = PdfSpotEmitter().emit(model)
    with pikepdf.Pdf.open(BytesIO(output)) as pdf:
        operations = [(list(map(float,args)),str(op)) for args,op in pikepdf.parse_content_stream(pdf.pages[0])
                      if str(op) in {'m','c','l','h'}]
    assert [op for _,op in operations] == ['m','c']
    assert np.asarray(operations[1][0]).reshape(-1,2)/PT == pytest.approx(np.asarray(controls[1:]), abs=1e-4)
    svg = SvgEmitter().emit(model).decode()
    path = re.search(r'<path d="([^"]+)',svg).group(1)
    assert path.count('C') == 1 and 'L' not in path and 'Z' not in path
    numbers = np.array([float(v) for v in re.findall(r'-?\d+(?:\.\d+)?',path)]).reshape(-1,2)
    numbers[:,1] = model.sheet_h_mm-numbers[:,1]
    assert numbers == pytest.approx(np.asarray(controls),abs=1e-7)


def test_line_protocol_after_affine_stays_in_flatten_plus_quantization_budget():
    import re
    from app.workers.cut_export.registration import apply_affine, Affine2x3
    from app.workers.cut_export.profile import MachineProfile
    from app.workers.cut_export.emitters.command_stream import CommandStreamEmitter
    with source_pdf(normalized=True,open_path=True) as pdf:
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None)
    model = apply_affine(model,Affine2x3(2,.5,1,-.2,1,3))
    profile = MachineProfile(id='quality',vendor='test',model='test',emitter='command_stream',resolution_plu_per_mm=40,
        pen_up='PU{x},{y};',pen_down='PD{x},{y};')
    output = CommandStreamEmitter(profile).emit(model).decode()
    points = np.array([(float(x),float(y)) for x,y in re.findall(r'PD(-?\d+),(-?\d+);',output)])
    assert len(points) > 2
    points /= profile.resolution_plu_per_mm
    line = LineString(points)
    samples = cubic_samples(model.paths[0].segments[0])
    bound = FLATTEN_TOL_MM+math.sqrt(2)/(2*profile.resolution_plu_per_mm)
    assert max(line.distance(Point(p)) for p in samples) <= bound


def test_s_closes_only_last_subpath_and_near_endpoints_stay_open():
    with source_pdf() as pdf:
        page = pdf.pages[0]
        page.Contents = pdf.make_stream(b'/CutContour CS 1 SCN '
            b'10 10 m 20 20 l 10.01 10 l '
            b'30 30 m 40 30 l 40 40 l s')
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None)
    assert [p.closed for p in model.paths] == [False,True]


def test_uncertified_nested_form_fails_instead_of_dropping_curve():
    from app.workers.cut_export.cut_layer_extractor import ExtractConfig
    from app.workers.cut_export.geometry import CutGeometryError
    with source_pdf(normalized=True,form=True) as pdf:
        with pytest.raises(CutGeometryError):
            extract_cut_contours_from_pdf(pdf,config=ExtractConfig(flatten_tol_pt=float('nan')))


def test_v_after_ctm_change_preserves_current_physical_start():
    with source_pdf() as pdf:
        page = pdf.pages[0]
        page.Contents = pdf.make_stream(b'/CutContour CS 1 SCN '
            b'10 10 m 2 0 0 2 0 0 cm 20 20 30 10 v S')
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),None)
    controls = np.asarray(model.paths[0].segments[0])*PT
    assert controls == pytest.approx(np.array([(10,10),(10,10),(40,40),(60,20)]))


@pytest.mark.parametrize("direction", [1,-1])
def test_closed_cubic_smaller_than_tolerance_keeps_ring_and_winding(direction):
    from app.workers.cut_export.cut_model import CutPath
    segment = ((0,0),(.005,.01),(-.005,.01),(0,0))
    if direction < 0:
        segment = tuple(reversed(segment))
    path = CutPath(points=[],closed=True,segments=(segment,))
    area = sum(a[0]*b[1]-a[1]*b[0] for a,b in zip(path.points,path.points[1:]))
    assert area*direction > 0
    assert len(set(path.points)) >= 3
    assert path.vector_segments() == (segment,)


def test_pdf_source_preserves_legacy_block_defaults_names_and_affine_routing():
    from app.workers.cut_export.registration import apply_affine, Affine2x3
    config = {'groupName':'group','itemName':'item','layerName':'cut','layerInfoName':'info'}
    with source_pdf() as pdf:
        page = pdf.pages[0]
        page.Contents = pdf.make_stream(b'/CutContour CS 1 SCN 10 10 20 20 re 50 50 20 20 re S')
        model = _build_cut_model_from_result(pdf,0,extract_cut_contours_from_pdf(pdf),config)
    # Builder trước đây chỉ gán block từ block_ids tường minh, mặc định đều0.
    assert [p.block_id for p in model.paths] == [0,0]
    assert [p.tool_tag for p in model.paths] == [None,None]
    assert model.source_names == {'group':'group','item':'item','layer':'cut','layerInfo':'info'}
    model.paths[0].block_id, model.paths[0].tool_tag = 5,'left'
    model.paths[1].block_id, model.paths[1].tool_tag = 2,'right'
    warped = apply_affine(model,Affine2x3(1,0,10,0,1,20))
    assert [(p.block_id,p.tool_tag) for p in warped.paths] == [(5,'left'),(2,'right')]
    assert warped.source_names == model.source_names

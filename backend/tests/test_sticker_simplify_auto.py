"""AUTO mới opt-in theo từng trang, không thay CUT sẵn hoặc recipe cũ."""
from pathlib import Path
from io import BytesIO

import pikepdf
import pytest

from app.workers import sticker_engine as engine


def test_auto_eligibility_is_page_local_and_preserves_existing_cut(tmp_path):
    from test_sticker_classic_binder2 import _synthetic_pdf
    source=_synthetic_pdf(tmp_path/'mixed.pdf')
    with pikepdf.Pdf.open(source) as pdf:
        vector=pdf.add_blank_page(page_size=(100,100))
        vector.Contents=pdf.make_stream(b'0 0 0 rg 10 10 80 80 re f')
        cut=pdf.add_blank_page(page_size=(100,100))
        cut.Resources=pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(
            CutContour=pikepdf.Array([pikepdf.Name.Separation,pikepdf.Name.CutContour,pikepdf.Name.DeviceCMYK,
                pikepdf.Dictionary(FunctionType=2,Domain=[0,1],C0=[0,0,0,0],C1=[0,1,0,0],N=1)])))
        cut.Contents=pdf.make_stream(b'/CutContour CS 1 SCN 10 10 m 90 10 l 90 90 l h S')
        assert engine._automatic_simplify_mm(pdf.pages[0],pdf,1)==.1
        assert engine._automatic_simplify_mm(vector,pdf,3)==0
        assert engine._automatic_simplify_mm(cut,pdf,4,alpha_source=True)==0
        assert engine._automatic_simplify_mm(vector,pdf,3,approved={'boundary_source':'ai'})==.1


def test_auto_flag_reaches_parallel_workers_without_changing_legacy_default(tmp_path,monkeypatch):
    source=tmp_path/'six.pdf'
    with pikepdf.Pdf.new() as pdf:
        for _ in range(6): pdf.add_blank_page(page_size=(72,72))
        pdf.save(source)
    captured=[]
    monkeypatch.setattr(engine,'_n_pages_should_parallelize',lambda *args,**kw:True)
    def parallel(self,**kw):
        captured.append(kw)
        return True,{}
    monkeypatch.setattr(engine.StickerEngine,'_process_parallel',parallel)
    for auto in (False,True):
        success,_=engine.StickerEngine().process_pdf(str(source),str(tmp_path/'unused.pdf'),
            cutline_simplify_mm=0,cutline_simplify_auto=auto)
        assert success and captured[-1]['cutline_simplify_auto'] is auto
        assert captured[-1]['cutline_simplify_mm']==0


def test_mixed_document_auto_only_simplifies_raster_and_explicit_zero_stays_off(tmp_path,monkeypatch):
    from test_sticker_classic_binder2 import _synthetic_pdf
    from app.workers import cutline_cubic_simplify as simplifier
    source=_synthetic_pdf(tmp_path/'mixed.pdf')
    with pikepdf.Pdf.open(source,allow_overwriting_input=True) as pdf:
        page=pdf.pages[1]
        page.Resources=pikepdf.Dictionary()
        page.Contents=pdf.make_stream(b'0 0 0 rg 10 10 80 60 re f')
        pdf.save(source)
    calls=[]
    def observed(groups,**kw):
        calls.append(kw['tolerance_mm'])
        count=sum(len(ring) for g in groups for ring in [g['exterior'],*g.get('interiors',[])])
        return groups,{'before_segments':count,'after_segments':count,'maximum_error_bound_mm':0,'changed':False}
    monkeypatch.setattr(simplifier,'simplify_cubic_path_groups',observed)
    options=dict(input_path=str(source),output_path='',_page_subset=[0,1],cut_mode='original',
        offset_mm=2,corner_style='preserve',remove_white_bg=True,
        alpha_corner_policy='adaptive',cutline_denoise=30,cutline_simplify_mm=0)
    output=engine.StickerEngine().process_pdf(**options,cutline_simplify_auto=False)
    assert isinstance(output[0],bytes) and not calls
    output=engine.StickerEngine().process_pdf(**options,cutline_simplify_auto=True)
    assert isinstance(output[0],bytes) and calls==[.1]


def test_auto_inspection_error_fails_closed_to_legacy(monkeypatch):
    monkeypatch.setattr(
        "app.workers.sticker_source_inspector._inspect_pdf_page",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("bad metadata")),
    )
    assert engine._automatic_simplify_mm(object(), object(), 1) == 0.0

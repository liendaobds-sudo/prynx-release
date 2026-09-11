"""Memo trong session chỉ thay công việc lặp, không thay hợp đồng hình học."""
from copy import deepcopy
import math
from types import SimpleNamespace
from threading import RLock

import pytest

from app.workers.cutline_simplify_memo import memoized_simplify, simplify_memo_scope, with_simplify_memo


def groups(marker='current'):
    return [{"marker": marker, "exterior": [((0,0),(1,0),(1,1),(0,0))], "interiors": []}]


def make_solver(calls, changed):
    @memoized_simplify
    def solve(path_groups, *, tolerance_mm, mm_to_units=1, offset_x_points=0,
              offset_y_points=0, page_height=10, prefer_conservative=False):
        calls.append(tolerance_mm)
        if not math.isfinite(float(tolerance_mm)) or not 0 <= tolerance_mm <= .1:
            raise ValueError('Dung sai sai')
        return deepcopy(path_groups), {"before_segments": 1, "after_segments": 1,
            "maximum_error_bound_mm": .01 if changed else 0, "changed": changed}
    return solve


@pytest.mark.parametrize('changed', [True, False])
def test_reuse_exact_geometry_options_without_leaking_metadata_or_mutation(changed):
    calls=[]
    solve=make_solver(calls,changed)
    with simplify_memo_scope() as memo:
        first=solve(groups('first'),tolerance_mm=.1)
        first[1]['after_segments']=999
    source=groups('second')
    with simplify_memo_scope(memo):
        result,stats=solve(source,tolerance_mm=.1)
        assert result[0]['marker']=='second' and stats['after_segments']==1
        if not changed:
            assert result is source
        solve(source,tolerance_mm=.05)
        solve(source,tolerance_mm=.1,page_height=11)
        solve(source,tolerance_mm=.1,offset_x_points=.00001)
        solve(source,tolerance_mm=.1,prefer_conservative=True)
        different=groups()
        different[0]['exterior'][0]=((0,0),(1.000000001,0),(1,1),(0,0))
        solve(different,tolerance_mm=.1)
    assert len(calls)==6


def test_default_no_scope_and_invalid_options_keep_original_contract():
    calls=[]
    solve=make_solver(calls,False)
    solve(groups(),tolerance_mm=.1)
    solve(groups(),tolerance_mm=.1)
    assert len(calls)==2
    with simplify_memo_scope():
        solve(groups(),tolerance_mm=0)
        solve(groups(),tolerance_mm=0)
        with pytest.raises(ValueError):
            solve(groups(),tolerance_mm=math.nan)
    assert len(calls)==5


def test_engine_boundary_accepts_internal_memo_but_does_not_mutate_snapshot():
    calls=[]
    solve=make_solver(calls,False)
    with simplify_memo_scope() as records:
        solve(groups(),tolerance_mm=.1)
    original=deepcopy(records)
    @with_simplify_memo
    def engine():
        solve(groups(),tolerance_mm=.1)
        return solve(groups(),tolerance_mm=.02)
    engine(_simplify_memo=records)
    assert calls==[.1,.02] and records==original


def test_whole_preview_exact_repeat_skips_pool_and_source_change_invalidates(tmp_path,monkeypatch):
    from app.workers import sticker_classic_page_preview as preview
    source=tmp_path/'source.pdf'
    source.write_bytes(b'source-v1')
    page=SimpleNamespace(stage='mask-review',boundary_source='alpha',operation_lock=RLock(),
        manifest={'mask_revision':3},preview_width_px=600,preview_height_px=500,cutline_export_cache=None)
    session=SimpleNamespace(source_kind='pdf',source_path=source,pages={12:page})
    created=[]
    class Result:
        def result(self):
            return 'M 0 0 C 1 0 1 1 0 0 Z',1,{'segment_count':1},{}
    class Pool:
        def __init__(self,**kwargs):
            created.append(kwargs)
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def submit(self,*args): return Result()
    monkeypatch.setattr(preview,'ProcessPoolExecutor',Pool)
    options=dict(page_number=12,base_revision=3,edits=[],offset_mm=0,bleed_mm=2,cut_mode='bleed',
        corner_style='round',fill_holes=True,cutline_smoothness=50,cutline_fidelity=50,
        curve_tension=100,min_detail_area_mm2=1,cutline_denoise=30,cutline_simplify_mm=.1)
    first=preview.build_classic_page_preview(session,**options)
    saved=deepcopy(first)
    first['paths'].clear()
    second=preview.build_classic_page_preview(session,**options)
    assert second==saved and len(created)==1
    source.write_bytes(b'source-v2')
    third=preview.build_classic_page_preview(session,**options)
    assert len(created)==2 and third['fingerprint']!=second['fingerprint']
    preview.build_classic_page_preview(session,**dict(options,cutline_simplify_mm=.05))
    assert len(created)==3


def test_classic_preview_pool_reuses_isolated_worker_between_pages(monkeypatch):
    from app.workers import sticker_classic_page_preview as preview

    created = []

    class Future:
        def result(self):
            return ("M 0 0 C 1 0 1 1 0 0 Z", 1, {"segment_count": 1}, {})

    class Pool:
        __module__ = "concurrent.futures.process"

        def __init__(self, **kwargs):
            created.append(kwargs)

        def submit(self, *args):
            return Future()

        def shutdown(self, **kwargs):
            return None

    monkeypatch.setattr(preview, "ProcessPoolExecutor", Pool)
    monkeypatch.setattr(preview, "_classic_preview_pool", None)
    monkeypatch.setattr(preview, "_render_classic_page", lambda *args: None)

    preview._submit_classic_page_render("source.pdf", 1, (600, 600), {})
    preview._submit_classic_page_render("source.pdf", 2, (600, 600), {})

    # PERF (audit 2026-09-11 §SIMPLIFY.FAIR-POOL): đổi trang chỉ gửi thêm
    # job vào process đã warm, không spawn lại interpreter/PDFium.
    assert len(created) == 1
    preview.reset_classic_preview_pool()


def test_whole_page_snapshot_memo_validates_source_settings_revision_and_ownership(tmp_path,monkeypatch):
    from app.workers import sticker_classic_page_preview as preview
    from app.workers.sticker_sheet_export import snapshot_classic_cutline_preview, StickerCanonicalPreviewConflict
    source=tmp_path/'source.pdf'
    source.write_bytes(b'source-v1')
    geometry=dict(offset_mm=0.0,bleed_mm=2.0,cut_mode='bleed',corner_style='round',fill_holes=True,
        curve_tension=100.0,cutline_denoise=30.0,cutline_simplify_mm=.1,
        cutline_smoothness=50.0,cutline_fidelity=50.0,min_detail_area_mm2=1.0)
    digest=preview.source_digest(source)
    cache=dict(kind='whole-page-memo-v1',source_digest=digest,page_number=12,revision=3,
        key=preview.whole_page_key(digest,12,3,dict(geometry,shape_mode='auto_safe'),(600,500)),
        preview={'fingerprint':'a'*64},memo={'memo-id':{'stats':{'changed':False}}})
    page=SimpleNamespace(stage='mask-review',boundary_source='alpha',operation_lock=RLock(),
        manifest={'mask_revision':3},preview_width_px=600,preview_height_px=500,cutline_export_cache=cache)
    session=SimpleNamespace(source_kind='pdf',source_path=source,pages={12:page})
    options=dict(source_path=source,page_number=12,expected_revision=3,expected_fingerprint='a'*64,**geometry)
    result=snapshot_classic_cutline_preview(session,**options)
    assert result['kind']=='whole-page-memo-v1'
    result['simplify_memo'].clear()
    assert cache['memo']
    for changed in ({'cutline_simplify_mm':.05},{'offset_mm':1},{'expected_revision':4},
                    {'expected_fingerprint':'b'*64},{'classic_force_contour':True}):
        with pytest.raises(StickerCanonicalPreviewConflict):
            snapshot_classic_cutline_preview(session,**dict(options,**changed))
    source.write_bytes(b'source-v2')
    with pytest.raises(StickerCanonicalPreviewConflict):
        snapshot_classic_cutline_preview(session,**options)

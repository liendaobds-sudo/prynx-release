"""PERF (audit 2026-09-07 §TEMPERF.4): writer index theo tờ, không quét P×S."""

from __future__ import annotations

import copy
import hashlib
import json

import numpy as np
import pytest

from app.workers import nesting_imposition_render as writer
from app.workers import nup_report
from tests.test_manifest_part_context import _raster_pages
from tests.test_nesting_imposition_render import (
    LOCATOR, _bundle, _bundle_cnc_duplex_with_pont, _make_full_ink_source,
    _manifest, _pose, _production, _report_options,
)


class _CountingPlacements(list):
    """Đếm item thật qua iterable manifest, không đếm bằng công thức ước lượng."""

    visits = 0

    def __iter__(self):
        for item in super().__iter__():
            self.visits += 1
            yield item


def _scene(tmp_path, sheet_count=4, *, unique=True, report=False, duplex=False, tail=False):
    source = tmp_path / "source.pdf"
    _make_full_ink_source(source, page_count=2 if duplex else 1)
    bundle = _bundle_cnc_duplex_with_pont(source, flip_edge="long") if duplex else _bundle(source)
    if report:
        bundle["artifactOptions"] = _report_options(fields=["labelsPerSheet", "sheetCount", "actualQty"])
    bundle["artifactOptions"]["exportUniqueSheets"] = unique
    production = _production(source, bundle=bundle, quantity=sheet_count * 2)
    poses, sheets = [], []
    for sheet_index in range(sheet_count):
        poses.extend([_pose(35, 40), _pose(95, 75 + (2 if tail and sheet_index == sheet_count - 1 else 0))])
        sheets.extend([sheet_index, sheet_index])
    manifest = _manifest(production, poses=poses, sheet_indices=sheets)
    # ID/order cố ý khác thứ tự input; Unicode phải theo bytes UTF-8 như trước E.
    for index, item in enumerate(manifest["placements"]):
        item["instanceId"] = ("ố" if index % 2 == 0 else "A") + str(index)
    manifest["placements"].reverse()
    payload = dict(engineRequest=production.engine_request, renderBundle=production.render_bundle,
                   renderBundleHash=production.render_bundle_hash)
    return source, payload, manifest


def _render(source, payload, manifest, output):
    return writer.render_production_nesting(
        production_request=payload, manifest=manifest,
        source_paths={LOCATOR: source}, output_path=output,
    )


@pytest.mark.parametrize("sheet_count", [10, 20, 40])
@pytest.mark.parametrize("unique,report,duplex", [(True, False, False), (True, True, True), (False, True, False)])
def test_actual_public_writer_visits_placement_source_linearly(tmp_path, sheet_count, unique, report, duplex):
    source, payload, manifest = _scene(tmp_path, sheet_count, unique=unique, report=report, duplex=duplex)
    placements = _CountingPlacements(manifest["placements"])
    manifest["placements"] = placements
    result = _render(source, payload, manifest, tmp_path / "indexed.pdf")
    assert result.sheet_count == sheet_count
    assert result.page_count == (3 if duplex else 2) * (1 if unique else sheet_count)
    # Hai cổng hiện hữu (_assert_renderable/_sheet_count) + một lượt dựng index.
    # Render/report không được thêm lượt quét toàn manifest theo số tờ/số mặt.
    assert placements.visits == 3 * len(placements)


@pytest.mark.parametrize("unique,duplex", [(True, False), (False, False), (True, True)])
@pytest.mark.parametrize("report", [True, False])
def test_index_matches_pre_index_live_fallback_artifact(tmp_path, monkeypatch, unique, report, duplex):
    source, payload, manifest = _scene(tmp_path, unique=unique, report=report, duplex=duplex, tail=True)
    before = json.dumps((payload, manifest), sort_keys=True)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    factory = getattr(writer, "_build_sheet_placement_index", None)
    assert callable(factory)
    report_calls = []
    original_stamp = nup_report.stamp_reports_on_pdf
    def stamp(*args, **kwargs):
        report_calls.append(dict(args[2]))
        return original_stamp(*args, **kwargs)
    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", stamp)
    # Private standalone helpers giữ nhánh quét cũ; tắt index cho control rồi
    # chạy CÙNG public writer/report/PDF, không tự reimplement công thức E.
    with monkeypatch.context() as control:
        control.setattr(writer, "_build_sheet_placement_index", lambda *args, **kwargs: None)
        reference = _render(source, payload, manifest, tmp_path / "reference.pdf")
    actual = _render(source, payload, manifest, tmp_path / "indexed.pdf")
    assert actual.pages == reference.pages
    assert actual.artifact_render_fingerprint == reference.artifact_render_fingerprint
    for page in actual.pages:
        expected_ids = tuple(sorted(
            [item["instanceId"] for item in manifest["placements"] if item["sheetIndex"] == page.sheet_index],
            key=lambda value: value.encode("utf-8"),
        ))
        assert page.instance_ids == expected_ids
    if report:
        assert len(report_calls) == 2
        assert report_calls[0] == report_calls[1]
    for expected, observed in zip(_raster_pages(reference.output_path), _raster_pages(actual.output_path), strict=True):
        assert np.array_equal(expected, observed), "Index không được đổi pixel artwork/CUT/report/duplex"
    assert json.dumps((payload, manifest), sort_keys=True) == before
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash


@pytest.mark.parametrize("unique", [True, False])
@pytest.mark.parametrize("field,value", [
    ("instanceId", ""), ("partId", "missing"), ("sourceRevision", "wrong"),
    ("sheetIndex", True), ("unexpected", True),
    ("pose", {"rotationDeg": 0, "translateXmm": True, "translateYmm": 1}),
])
def test_index_cannot_hide_invalid_later_occurrences(tmp_path, unique, field, value):
    source, payload, manifest = _scene(tmp_path, unique=unique)
    # Tờ 2 trùng recipe tờ 0: không được dedup trước khi kiểm occurrence lỗi.
    invalid = next(item for item in manifest["placements"] if item["sheetIndex"] == 2)
    invalid[field] = copy.deepcopy(value)
    output = tmp_path / "must-not-exist.pdf"
    with pytest.raises(ValueError):
        _render(source, payload, manifest, output)
    assert not output.exists()


def test_exact_pose_and_duplicate_occurrence_recipe_semantics_keep_original_contract(tmp_path):
    source, payload, manifest = _scene(tmp_path, sheet_count=3)
    # Chênh nhỏ hơn 1e-6 vẫn khác recipe; index không được quantize pose.
    altered = next(item for item in manifest["placements"] if item["sheetIndex"] == 1)
    altered["pose"]["translateXmm"] += 0.00000001
    result = _render(source, payload, manifest, tmp_path / "exact.pdf")
    assert [page.sheet_index for page in result.pages] == [0, 0, 1, 1]


def test_index_preserves_recipe_multiset_not_just_distinct_poses(tmp_path):
    source, payload, _ = _scene(tmp_path, sheet_count=3)
    production = _production(source, quantity=5)
    payload = dict(engineRequest=production.engine_request, renderBundle=production.render_bundle,
                   renderBundleHash=production.render_bundle_hash)
    manifest = _manifest(
        production, poses=[_pose(35, 40) for _ in range(5)],
        sheet_indices=[0, 0, 1, 2, 2],
    )
    result = _render(source, payload, manifest, tmp_path / "multiset.pdf")
    assert [page.sheet_index for page in result.pages] == [0, 0, 1, 1]
    assert [len(page.instance_ids) for page in result.pages] == [2, 2, 1, 1]


def test_sparse_sheet_indices_remain_fail_closed(tmp_path):
    source, payload, manifest = _scene(tmp_path, sheet_count=3)
    for occurrence in manifest["placements"]:
        if occurrence["sheetIndex"] == 1:
            occurrence["sheetIndex"] = 3
    with pytest.raises(ValueError, match="liên tục"):
        _render(source, payload, manifest, tmp_path / "sparse.pdf")

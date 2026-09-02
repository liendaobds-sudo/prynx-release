"""End-to-end nesting theo đường bế — Lô A4b-1 (audit 2026-08-28).

Bộ test này là **bằng chứng Cổng Chặng A**: chạy trọn chuỗi trên native THẬT và
writer THẬT, rồi đo trên PDF đã ghi ra đĩa.

Bốn điều Cổng A đòi, và chỗ khoá tương ứng:

1. *không overlap/clearance/obstacle/boundary violation* → validator native trả
   ``validation.valid`` và test đọc lại giá trị đó;
2. *đủ quantity* → so ``stats.placedCount`` với tổng quantity đã yêu cầu;
3. *preview và export cùng manifestId/fingerprint* → chạy hai lượt trên cùng
   session và so identity;
4. *solver call count = 1* → đếm số lần native được gọi.

Test cần native đã build; ``skipif`` có lý do rõ thay vì đỏ.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import pikepdf
import pytest

from app.workers.imposition_pdf_form import PT_PER_MM


def _native_has_engine() -> bool:
    try:
        import pdfcompare_native
    except Exception:  # pragma: no cover - máy chưa build native
        return False
    return hasattr(pdfcompare_native, "MixedNestingRun")


requires_engine = pytest.mark.skipif(
    not _native_has_engine(),
    reason=(
        "pdfcompare_native chưa có MixedNestingRun. Chạy lại "
        "`maturin develop --release` trong native/ (cần tắt sidecar dev đang giữ DLL)."
    ),
)

SHEET_W_MM = 200.0
SHEET_H_MM = 150.0
DIE_MM = 30.0
HOLE_LO, HOLE_HI = 10.0, 20.0


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    return tmp_path


@contextmanager
def _count_solves():
    """Đếm số lần solver THẬT được gọi.

    Đếm ở ``MixedNestingRunHandle.solve_production_with_hardware`` chứ không ở ``create_run``:
    ``solve_production_nesting`` bind ``create_run`` làm **default argument** lúc
    import, nên patch attribute module không có tác dụng. Và lời gọi solve mới là
    đại lượng Cổng A nói tới ("solver call count = 1"), không phải số handle.
    """

    from app.core.mixed_nesting_service import MixedNestingRunHandle

    calls: list[dict[str, object]] = []
    real = MixedNestingRunHandle.solve_production_with_hardware

    def counting(self, *args, **kwargs):
        calls.append(dict(kwargs))
        return real(self, *args, **kwargs)

    MixedNestingRunHandle.solve_production_with_hardware = counting
    try:
        yield calls
    finally:
        MixedNestingRunHandle.solve_production_with_hardware = real


def _make_die_source(path: Path) -> None:
    """PDF nguồn: nền mực kín + một đường bế vuông có cửa sổ, vẽ bằng spot CutContour.

    Dùng nét vẽ thật để `extract_page_die_cut_polygon` có gì mà trích, thay vì
    nhồi contour bằng tay — đường chạy thật phải đi qua bộ dò.
    """

    size = DIE_MM * PT_PER_MM
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(size, size))
    outer = (
        f"0 0 m {size} 0 l {size} {size} l 0 {size} l h"
    )
    hole_lo = HOLE_LO * PT_PER_MM
    hole_hi = HOLE_HI * PT_PER_MM
    hole = (
        f"{hole_lo} {hole_lo} m {hole_lo} {hole_hi} l "
        f"{hole_hi} {hole_hi} l {hole_hi} {hole_lo} l h"
    )
    page.contents_add(
        pikepdf.Stream(
            pdf,
            (
                # Nền mực để đo được clip trên artifact.
                f"q 0 0 0 rg 0 0 {size} {size} re f Q\n"
                # Đường bế: MỘT path, hai subpath (biên ngoài + cửa sổ) — đúng cách
                # file khuôn thật được vẽ. Tách thành hai lệnh `S` riêng làm bộ dò
                # chọn subpath nhỏ làm biên khuôn; đã đo và mắc đúng lỗi đó.
                f"q 0 1 0 0 K 0.5 w {outer} {hole} S Q\n"
            ).encode("ascii"),
        )
    )
    pdf.save(str(path))
    pdf.close()


def _job(
    workdir: Path,
    *,
    manifest_id: str = "0123456789abcdef0123456789abcdef",
    tool: str = "sticker_imposer",
    intent: str = "quantity_fulfillment",
    quantity: int | None = 6,
    parts: int = 1,
    max_sheets: int = 4,
    gap=(2.0, 3.0),
    obstacles=(),
    grouping_intent: str = "free_gang",
    placement_zones=(),
):
    from app.core.nesting_production_pipeline import (
        AxisGapMm,
        JobPartInput,
        ProductionNestingJobInput,
    )

    job_parts = []
    for index in range(parts):
        source = workdir / f"nguon-{index}.pdf"
        _make_die_source(source)
        job_parts.append(
            JobPartInput(
                part_id=f"tem-{index}",
                source_path=source,
                page_index=0,
                quantity=quantity,
            )
        )
    return ProductionNestingJobInput(
        manifest_id=manifest_id,
        tool=tool,
        layout_intent=intent,
        sheet_width_mm=SHEET_W_MM,
        sheet_height_mm=SHEET_H_MM,
        parts=tuple(job_parts),
        margin_mm={"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0},
        max_sheets=max_sheets,
        seed=11,
        profile="fast",
        time_budget_ms=8000,
        grouping_intent=grouping_intent,
        placement_zones=tuple(placement_zones),
        part_gap=AxisGapMm(gap[0], gap[1]),
        fixed_obstacles=tuple(obstacles),
    )


def _equal_area_zones(part_count: int):
    from app.core.nesting_production_pipeline import (
        AxisAlignedBoundsSpec,
        PartPlacementZoneSpec,
    )

    top = SHEET_H_MM - 5.0
    bottom = 5.0
    height = (top - bottom) / part_count
    return tuple(
        PartPlacementZoneSpec(
            part_id=f"tem-{index}",
            bounds=AxisAlignedBoundsSpec(
                min_x_mm=5.0,
                min_y_mm=top - height * (index + 1),
                max_x_mm=SHEET_W_MM - 5.0,
                max_y_mm=top - height * index,
            ),
        )
        for index in range(part_count)
    )


def _run(job, workdir: Path, *, name: str = "ket_qua.pdf", **kwargs):
    from app.core.nesting_manifest_store import NestingManifestStore
    from app.core.nesting_production_pipeline import run_production_nesting_job

    store = kwargs.pop("store", None) or NestingManifestStore(
        root=workdir / "manifests"
    )
    return run_production_nesting_job(
        job, output_path=workdir / name, store=store, **kwargs
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Bốn điều kiện Cổng Chặng A
# ─────────────────────────────────────────────────────────────────────────────


@requires_engine
def test_cong_a_khong_violation_du_quantity_va_solve_mot_lan(workdir: Path) -> None:
    """Một lượt gang Tem bế: validator sạch, đủ quantity, solve đúng một lần."""

    job = _job(workdir, quantity=6)
    with _count_solves() as calls:
        result = _run(job, workdir)

    manifest = result.solved.manifest
    assert manifest["status"] == "completed"
    # (1) không violation: validator native tự phán, test chỉ đọc lại.
    assert manifest["validation"]["valid"] is True
    # (2) đủ quantity.
    assert manifest["stats"]["placedCount"] == 6
    assert manifest["unplaced"] == []
    # (4) solver được gọi đúng một lần cho cả solve + render.
    assert len(calls) == 1
    assert int(calls[0]["worker_grant"]) >= 1
    assert int(calls[0]["nfp_cache_max_bytes_per_trial"]) > 0
    runtime = result.solved.runtime_diagnostics["runtimeControl"]
    assert runtime["workerGrant"] == calls[0]["worker_grant"]
    assert runtime["maxConcurrentComputeWorkers"] == calls[0]["worker_grant"]
    assert runtime["nfpCacheMaxBytesPerTrial"] == calls[0][
        "nfp_cache_max_bytes_per_trial"
    ]
    assert runtime["portfolioParallelEnabled"] is True
    portfolio = runtime["portfolioExecution"]
    session_trial_count = manifest["search"]["budget"][
        "trialCount"
    ]
    assert portfolio["plannedTrials"] == session_trial_count
    assert portfolio["dispatchedTrials"] <= session_trial_count
    assert portfolio["completedTrials"] + portfolio["interruptedTrials"] == portfolio[
        "dispatchedTrials"
    ]
    assert portfolio["rejectedTrials"] == manifest["search"]["trialsRejected"]
    assert portfolio["concurrencyLimit"] == min(
        calls[0]["worker_grant"], session_trial_count
    )
    assert 1 <= portfolio["wavesDispatched"] <= session_trial_count
    assert 1 <= portfolio["maxDispatchedWaveWidth"] <= portfolio["concurrencyLimit"]
    assert runtime["nfpColdMissParallelEnabled"] is True
    assert runtime["nfpCacheByteBudgetEnforced"] is True

    # Artifact tồn tại và có đủ trang theo outputSides.
    assert result.render.output_path.is_file()
    assert result.render.page_count == result.render.sheet_count * len(
        result.render.sides
    )
    assert result.stored is not None
    assert result.stored is not None and result.manifest_id == job.manifest_id


@requires_engine
def test_cong_a_preview_va_export_cung_manifest(workdir: Path) -> None:
    """(3) Preview và export phải cùng manifestId/fingerprint, không solve lại."""

    from app.core.nesting_manifest_store import NestingManifestStore
    from app.core.nesting_production_pipeline import (
        commit_production_nesting_session,
        render_production_nesting_session,
        solve_production_nesting_job,
    )

    job = _job(workdir, quantity=4)
    store = NestingManifestStore(root=workdir / "manifests")

    with _count_solves() as calls:
        session = solve_production_nesting_job(job)
        preview = render_production_nesting_session(
            session, output_path=workdir / "preview.pdf"
        )
        export = render_production_nesting_session(
            session, output_path=workdir / "export.pdf"
        )

    # Solve ĐÚNG MỘT LẦN cho cả preview lẫn export — render không solve lại.
    assert len(calls) == 1

    stored = commit_production_nesting_session(session, store=store)

    # Cùng session ⇒ tất yếu cùng identity, không phải nhờ may mắn hash trùng.
    assert preview.manifest_id == export.manifest_id == session.manifest_id
    assert preview.layout_fingerprint == export.layout_fingerprint
    assert preview.layout_fingerprint == session.layout_fingerprint
    assert preview.render_bundle_hash == export.render_bundle_hash
    assert stored is not None

    # Và cùng content stream: renderer xác định, không phụ thuộc lượt chạy.
    assert preview.page_count == export.page_count
    for index in range(preview.page_count):
        assert _raw(preview.output_path, index) == _raw(export.output_path, index)


@requires_engine
def test_goi_pipeline_hai_lan_KHONG_cho_cung_manifest(workdir: Path) -> None:
    """Bằng chứng vì sao phải tách session — và vì sao callsite không được gọi 2 lần.

    Mỗi lượt ``pin_pdf_path`` sinh locator mới, locator nằm trong RenderBundle, nên
    hai lượt pipeline cho hai fingerprint khác nhau. Test này khoá sự thật đó để
    không ai "sửa" nó bằng cách cho preview gọi pipeline riêng.
    """

    from app.core.nesting_manifest_store import NestingManifestStore
    from app.core.nesting_production_pipeline import solve_production_nesting_job

    job = _job(workdir, quantity=4)
    NestingManifestStore(root=workdir / "manifests")
    first = solve_production_nesting_job(job)
    second = solve_production_nesting_job(job)

    assert first.manifest_id == second.manifest_id  # cùng job id do server cấp
    assert first.layout_fingerprint != second.layout_fingerprint


@requires_engine
def test_gang_nhieu_mau_va_ca_hai_cong_cu(workdir: Path) -> None:
    """Gang nhiều mẫu chạy được; Tem bế và CNC dùng chung một đường."""

    job = _job(workdir, parts=2, quantity=3)
    result = _run(job, workdir)
    assert result.solved.manifest["validation"]["valid"] is True
    assert result.solved.manifest["stats"]["placedCount"] == 6
    placed_parts = {
        placement["partId"] for placement in result.solved.manifest["placements"]
    }
    assert placed_parts == {"tem-0", "tem-1"}


@requires_engine
def test_nhieu_mau_cung_pdf_chi_pin_mot_snapshot(workdir: Path, monkeypatch) -> None:
    """Một PDF nhiều page binding không được copy/hash/inspect lặp theo part."""

    from dataclasses import replace

    from app.core import nesting_production_pipeline as pipeline

    job = _job(workdir, parts=2, quantity=2)
    shared_source = job.parts[0].source_path
    job = replace(
        job,
        parts=(job.parts[0], replace(job.parts[1], source_path=shared_source)),
    )

    calls: list[str] = []
    real_pin = pipeline.pin_pdf_path

    def counting_pin(source_path):
        calls.append(os.fspath(source_path))
        return real_pin(source_path)

    monkeypatch.setattr(pipeline, "pin_pdf_path", counting_pin)
    result = _run(job, workdir, name="dedup-pin.pdf")

    assert len(calls) == 1
    assert len(result.source_pins) == 1
    locator_ids = {
        part["source"]["locatorId"]
        for part in result.solved.production_request.render_bundle["parts"]
    }
    assert locator_ids == {result.source_pins[0].locator_id}


def test_fixture_cho_dung_contour_khuon_30x30(workdir: Path) -> None:
    """Chốt tự kiểm cho FIXTURE, không phải cho engine.

    Bản đầu của fixture vẽ biên ngoài và cửa sổ thành **hai** lệnh ``S`` riêng;
    ``extract_page_die_cut_polygon`` khi đó trả về cửa sổ 10×10 làm biên khuôn.
    Mọi assert khác vẫn xanh — autofill báo 140 con/tờ trên tờ chỉ chứa nổi ~20 —
    vì engine tính đúng trên một hình sai. Test này để lỗi đó không lặp lại im lặng.
    """

    from app.core.nesting_source_geometry import resolve_sticker_source_geometry
    from app.core.nesting_source_pin import pin_pdf_path

    source = workdir / "kiem-fixture.pdf"
    _make_die_source(source)
    resolved = resolve_sticker_source_geometry(pin_pdf_path(source), 0)
    outer = resolved.polygon.outer
    xs = [point[0] for point in outer]
    ys = [point[1] for point in outer]
    assert max(xs) - min(xs) == pytest.approx(DIE_MM, abs=0.01)
    assert max(ys) - min(ys) == pytest.approx(DIE_MM, abs=0.01)
    assert min(xs) == pytest.approx(0.0, abs=0.01)
    assert min(ys) == pytest.approx(0.0, abs=0.01)

    # NEST (audit 2026-08-28 §A4b-2): cửa sổ phải tới được lớp CUT dưới dạng LỖ
    # KHUÔN. Trước bản vá bộ dò hợp mọi subpath thành hình đặc nên `holes` rỗng,
    # và trang CUT không có nét dao cửa sổ — thợ bế không đục được cửa sổ.
    assert len(resolved.polygon.holes) == 1, "cửa sổ fixture phải thành lỗ khuôn"
    hole_xs = [point[0] for point in resolved.polygon.holes[0]]
    hole_ys = [point[1] for point in resolved.polygon.holes[0]]
    assert min(hole_xs) == pytest.approx(HOLE_LO, abs=0.01)
    assert max(hole_xs) == pytest.approx(HOLE_HI, abs=0.01)
    assert min(hole_ys) == pytest.approx(HOLE_LO, abs=0.01)
    assert max(hole_ys) == pytest.approx(HOLE_HI, abs=0.01)


@requires_engine
def test_autofill_lap_day_mot_to_khong_can_quantity(workdir: Path) -> None:
    """autofill_single_sheet: đúng một tờ, và placedCount phải hợp lý VỀ HÌNH HỌC."""

    job = _job(
        workdir,
        intent="autofill_single_sheet",
        quantity=None,
        max_sheets=1,
    )
    result = _run(job, workdir)
    manifest = result.solved.manifest
    assert manifest["validation"]["valid"] is True
    assert manifest["stats"]["sheetCount"] == 1
    assert result.render.sheet_count == 1

    placed = manifest["stats"]["placedCount"]
    # Trần hình học: diện tích vùng in chia diện tích một khuôn. Không có assert
    # này thì một contour sai (ví dụ bộ dò trả cửa sổ 10×10) vẫn cho test xanh.
    usable_w = SHEET_W_MM - 10.0
    usable_h = SHEET_H_MM - 10.0
    upper_bound = int((usable_w * usable_h) // (DIE_MM * DIE_MM))
    assert 1 < placed <= upper_bound, (
        f"placedCount={placed} vượt trần hình học {upper_bound} "
        f"cho khuôn {DIE_MM}x{DIE_MM}mm trên vùng in {usable_w}x{usable_h}mm"
    )


@requires_engine
def test_gap_di_hai_truc_khong_bi_nen(workdir: Path) -> None:
    """gapX ≠ gapY phải vào clearance theo đúng hai trục và đổi identity."""

    base = _run(_job(workdir, gap=(2.0, 3.0)), workdir, name="a.pdf")
    contract = base.solved.production_request.engine_request["productionContract"]
    assert contract["clearance"]["partToPart"] == {"xMm": 2.0, "yMm": 3.0}

    # manifestId khác: cùng ID với nội dung khác là ManifestConflictError đúng nghĩa.
    other = _run(
        _job(workdir, gap=(3.0, 3.0), manifest_id="f" * 32),
        workdir,
        name="b.pdf",
    )
    # Đổi riêng trục X phải đổi identity — không bị nén về max().
    assert (
        other.solved.production_request.input_hash
        != base.solved.production_request.input_hash
    )


@requires_engine
def test_obstacle_duoc_ton_trong_tren_layout_cuoi(workdir: Path) -> None:
    """Boong/nhíp thành fixedObstacles và validator kiểm trên layout cuối."""

    obstacle = {
        "obstacleId": "boong-1",
        "kind": "gripper",
        "outer": [[0.0, 0.0], [SHEET_W_MM, 0.0], [SHEET_W_MM, 12.0], [0.0, 12.0]],
    }
    job = _job(workdir, quantity=4, obstacles=(obstacle,))
    result = _run(job, workdir)
    manifest = result.solved.manifest
    assert manifest["validation"]["valid"] is True

    contract = result.solved.production_request.engine_request["productionContract"]
    assert [item["obstacleId"] for item in contract["fixedObstacles"]] == ["boong-1"]

    # Không chi tiết nào được đặt chồng dải boong: pose y phải nằm trên vùng cấm.
    for placement in manifest["placements"]:
        assert placement["pose"]["translateYmm"] >= 12.0


@requires_engine
def test_mien_xoay_chang_a_la_cardinal(workdir: Path) -> None:
    """Chặng A khoá cardinal; mọi pose phải nằm trong tập bốn góc."""

    result = _run(_job(workdir, quantity=6), workdir)
    policy = result.solved.production_request.engine_request["orientationPolicy"]
    assert policy["defaultRotation"] == {
        "mode": "discrete",
        "anglesDeg": [0.0, 90.0, 180.0, 270.0],
    }
    for placement in result.solved.manifest["placements"]:
        assert placement["pose"]["rotationDeg"] in (0.0, 90.0, 180.0, 270.0)


# ─────────────────────────────────────────────────────────────────────────────
#  Transport grouping/zone và fail-closed
# ─────────────────────────────────────────────────────────────────────────────


def test_grouping_zone_di_nguyen_ven_tu_pipeline_sang_orchestrator_input(
    workdir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.core import nesting_production_pipeline as pipeline

    captured = {}
    marker = object()

    def fake_solve(value, **_kwargs):
        captured["value"] = value
        return marker

    monkeypatch.setattr(pipeline, "solve_production_nesting", fake_solve)
    zones = _equal_area_zones(2)
    job = _job(
        workdir,
        parts=2,
        quantity=1,
        grouping_intent="maximize_area",
        placement_zones=zones,
    )
    session = pipeline.solve_production_nesting_job(job)
    try:
        transported = captured["value"]
        assert session.solved is marker
        assert transported.grouping_intent == "maximize_area"
        assert transported.placement_zones == tuple(
            zone.to_contract() for zone in zones
        )
    finally:
        for pin in session.source_pins:
            pipeline.discard_source_pin(pin)


def test_grouping_zone_sai_bi_chan_truoc_khi_pin_nguon(workdir: Path) -> None:
    from dataclasses import replace

    from app.core.nesting_production_pipeline import (
        NestingProductionPipelineError,
        solve_production_nesting_job,
    )

    missing = _job(
        workdir,
        parts=2,
        quantity=1,
        grouping_intent="maximize_area",
    )
    with pytest.raises(NestingProductionPipelineError, match="thiếu vùng"):
        solve_production_nesting_job(missing)

    zones = _equal_area_zones(2)
    forbidden = replace(missing, grouping_intent="free_gang", placement_zones=zones)
    with pytest.raises(NestingProductionPipelineError, match="không được mang"):
        solve_production_nesting_job(forbidden)

    unknown = replace(
        missing,
        placement_zones=(replace(zones[0], part_id="không-tồn-tại"), zones[1]),
    )
    with pytest.raises(NestingProductionPipelineError, match="không có trong parts"):
        solve_production_nesting_job(unknown)


# ─────────────────────────────────────────────────────────────────────────────
#  Fail-closed và dọn dẹp
# ─────────────────────────────────────────────────────────────────────────────


def test_quantity_thieu_bi_chan_truoc_khi_pin_nguon(workdir: Path) -> None:
    from app.core.nesting_production_pipeline import (
        NestingProductionPipelineError,
        run_production_nesting_job,
    )

    job = _job(workdir, quantity=None, intent="quantity_fulfillment")
    with pytest.raises(NestingProductionPipelineError, match="quantity nguyên dương"):
        run_production_nesting_job(job, output_path=workdir / "khong-tao.pdf")
    assert not (workdir / "khong-tao.pdf").exists()


def test_autofill_khong_nhan_quantity(workdir: Path) -> None:
    from app.core.nesting_production_pipeline import (
        NestingProductionPipelineError,
        run_production_nesting_job,
    )

    job = _job(workdir, intent="autofill_single_sheet", quantity=5, max_sheets=1)
    with pytest.raises(NestingProductionPipelineError, match="không nhận quantity"):
        run_production_nesting_job(job, output_path=workdir / "khong-tao.pdf")


def test_part_id_trung_bi_chan(workdir: Path) -> None:
    from dataclasses import replace

    from app.core.nesting_production_pipeline import (
        NestingProductionPipelineError,
        run_production_nesting_job,
    )

    job = _job(workdir, parts=2, quantity=2)
    trung = replace(job, parts=(job.parts[0], replace(job.parts[1], part_id="tem-0")))
    with pytest.raises(NestingProductionPipelineError, match="part_id bị trùng"):
        run_production_nesting_job(trung, output_path=workdir / "khong-tao.pdf")


def test_duplex_chi_cho_cnc(workdir: Path) -> None:
    from dataclasses import replace

    from app.core.nesting_production_pipeline import (
        NestingProductionPipelineError,
        run_production_nesting_job,
    )

    job = replace(
        _job(workdir, quantity=2), duplex_mode="duplex", flip_edge="long"
    )
    with pytest.raises(NestingProductionPipelineError, match="Chỉ Bình CNC"):
        run_production_nesting_job(job, output_path=workdir / "khong-tao.pdf")


def test_cnc_phai_truyen_detected_shape(workdir: Path) -> None:
    from dataclasses import replace

    from app.core.nesting_production_pipeline import (
        NestingProductionPipelineError,
        run_production_nesting_job,
    )

    job = replace(_job(workdir, quantity=2), tool="cnc_imposer")
    with pytest.raises(NestingProductionPipelineError, match="detected_shape"):
        run_production_nesting_job(job, output_path=workdir / "khong-tao.pdf")


def _raw(path: Path, index: int) -> str:
    data = b""
    with pikepdf.Pdf.open(str(path)) as pdf:
        contents = pdf.pages[index].obj.get("/Contents")
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        for stream in streams:
            data += stream.read_bytes()
    return data.decode("latin-1")


@requires_engine
def test_lo_khuon_di_tu_bo_do_den_lop_cut_cua_artifact(workdir: Path) -> None:
    """End-to-end: lỗ khuôn bộ dò trích ra phải thành nét dao trên trang CUT.

    NEST (audit 2026-08-28 §A4b-2). Trước bản vá `extract_page_die_cut_polygon`
    hợp mọi subpath thành hình ĐẶC, nên `cutContour.holes` rỗng và trang CUT chỉ
    có biên ngoài — thợ bế không đục được cửa sổ. Writer đã hỗ trợ lỗ từ §A1c;
    mắt xích thiếu là bộ dò. Test này khoá cả đoạn nối.

    Đo trên content stream nên không phụ thuộc pose solver chọn:

    - trang CUT: 2 vòng/con (biên ngoài + cửa sổ) ⇒ ``m`` = 2 × placedCount;
    - trang front: clip chỉ vòng NGOÀI ⇒ ``m`` = 1 × placedCount, vì §7.2 đã
      duyệt "vùng lỗ CÓ in mực" — kẹp lỗ vào clip sẽ chừa trắng cửa sổ, sai
      hành vi xưởng.
    """

    result = _run(_job(workdir, quantity=3, max_sheets=4), workdir)
    placed = result.solved.manifest["stats"]["placedCount"]
    assert placed > 0
    assert result.render.sides == ("front", "cut")

    front_stream = _raw(result.render.output_path, 0)
    cut_stream = _raw(result.render.output_path, 1)

    assert cut_stream.count(" m\n") == 2 * placed, (
        "trang CUT phải có biên ngoài VÀ cửa sổ cho từng con"
    )
    assert cut_stream.count("h\n") == 2 * placed
    assert front_stream.count(" m\n") == placed, (
        "clip artwork chỉ lấy vòng ngoài — lỗ vẫn phải được in mực"
    )

    # Trang CUT là vector thuần, không nhúng artwork; nét là stroke, không fill.
    assert " Do" not in cut_stream
    assert " f\n" not in cut_stream
    assert " f*" not in cut_stream

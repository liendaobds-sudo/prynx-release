"""Artifact test cho writer production Bình tem/CNC — Lô A3 (audit 2026-08-28).

Đây là bộ test đầu tiên của đợt nesting đạt mức **ARTIFACT** cho đường production:
mọi khẳng định đều đo trên **file PDF thật đã ghi ra đĩa** — parse content stream
và raster để đo pixel — chứ không đọc object trung gian trong bộ nhớ.

Ba nhóm bất biến được khoá:

1. **Cấu trúc artifact**: số trang, thứ tự trang, khổ trang, đủ side theo
   ``outputSides``.
2. **Hình học**: artwork nằm đúng chỗ pose đã khai; nét CUT có đủ cả vòng ngoài
   lẫn vòng lỗ (dao cắt cửa sổ) trong khi artwork vẫn in mực trong lỗ.
3. **Fail-closed**: manifest chưa hợp lệ, lệch bản mẫu, còn unplaced, thiếu
   snapshot nguồn — không được tạo file.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pikepdf
import pytest

from app.core import perf_sampler
from app.core.nesting_imposition_bundle import (
    CNC_IMPOSER_RENDERER_VERSION,
    DUPLEX_REGISTRATION_MARGIN_MM,
    ImpositionReportEnabled,
    canonicalize_imposition_report,
)
from app.core.nesting_production_adapter import (
    build_production_request,
    canonical_sha256,
)
from app.core.mixed_nesting_service import (
    MIXED_NESTING_PROTOCOL_VERSION,
    PRODUCTION_ALGORITHM_VERSION_KEYS,
)
from app.workers.imposition_pdf_form import PT_PER_MM
from app.workers.nesting_imposition_render import (
    ManifestRenderContractError,
    PRODUCTION_WRITER_VERSION,
    render_production_nesting,
)


JOB_ID = "0123456789abcdef0123456789abcdef"
BUILD_IDENTITY = "1" * 64
LOCATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

SHEET_W_MM = 200.0
SHEET_H_MM = 150.0
SRC_MM = 40.0
# Khuôn vuông 30x30mm có cửa sổ 10x10mm ở giữa.
OUTER = [[0.0, 0.0], [30.0, 0.0], [30.0, 30.0], [0.0, 30.0]]
HOLE = [[10.0, 10.0], [10.0, 20.0], [20.0, 20.0], [20.0, 10.0]]


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    return tmp_path


def _versions() -> dict[str, int | str]:
    versions: dict[str, int | str] = {
        key: 1 for key in PRODUCTION_ALGORITHM_VERSION_KEYS
    }
    versions["protocolVersion"] = MIXED_NESTING_PROTOCOL_VERSION
    versions["engineVersion"] = "mixed-nesting-core-test"
    return versions


def _make_full_ink_source(path: Path, *, page_count: int = 1) -> None:
    """Nguồn phủ kín mực; hỗ trợ nhiều trang để đo artifact CNC duplex."""

    pdf = pikepdf.Pdf.new()
    size = SRC_MM * PT_PER_MM
    for _ in range(page_count):
        page = pdf.add_blank_page(page_size=(size, size))
        page.contents_add(
            pikepdf.Stream(
                pdf, f"q 0 0 0 rg 0 0 {size} {size} re f Q".encode("ascii")
            )
        )
    pdf.save(str(path))
    pdf.close()


def _source_revision(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _page_binding(page_index: int = 0) -> dict:
    return {
        "pageIndex": page_index,
        "pageBoxesMm": {
            "mediaBox": [0.0, 0.0, SRC_MM, SRC_MM],
            "cropBox": [0.0, 0.0, SRC_MM, SRC_MM],
            "trimBox": [0.0, 0.0, SRC_MM, SRC_MM],
        },
        "userUnit": 1.0,
        "rotateDeg": 0,
        # `sourceReferencePointMm` là field server-owned: adapter tự suy từ
        # footprint, bundle thô không được khai.
        "sourcePageToCanonical": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    }


def _polygon(outer, holes) -> dict:
    return {
        "outer": copy.deepcopy(outer),
        "holes": [copy.deepcopy(hole) for hole in holes],
    }


def _cut_style() -> dict:
    return {
        "sourceFilter": {
            "mode": "spot",
            "spotNames": ["cutcontour"],
            "processColor": None,
            "colorTolerance": 0.01,
            "dieLayerNames": [],
            "geometryToleranceMm": 0.1,
        },
        "stroke": {
            "widthMm": 0.5,
            "colorSpace": "cmyk",
            "components": [0.0, 1.0, 0.0, 0.0],
            "separationName": None,
            "alternate": None,
            "overprint": False,
        },
    }


def _bundle(source_path: Path, *, cut_style: dict | None = None) -> dict:
    revision = _source_revision(source_path)
    return {
        "schemaVersion": 2,
        "flow": {
            "tool": "sticker_imposer",
            "taskMode": "nup",
            "layoutIntent": "quantity_fulfillment",
        },
        "outputSides": ["front", "cut"],
        "duplex": {"mode": "simplex", "flipEdge": "none", "physicalAxis": "none"},
        "marks": {
            "trim": {
                "type": "none",
                "lengthMm": 5.0,
                "offsetMm": 3.0,
                "thicknessMm": 0.25,
                "style": "default",
            },
            "pont": {"type": "none", "config": None},
            "cut": {
                "type": "default",
                "separatePage": True,
                "pontsOnCutFile": True,
                "fillBlockGapMm": 0.0,
                "dieSizeMode": "die",
                "dieOffsetMm": 0.0,
            },
            "duplexRegistration": False,
        },
        "artifactOptions": {"exportUniqueSheets": True, "report": {"enabled": False}},
        "sheetFrames": {
            "front": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            "back": None,
            "cut": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        },
        "renderer": {
            "identity": "sticker_imposer_pdf",
            "version": "sticker-manifest-affine-v1",
        },
        "cutStyle": _cut_style() if cut_style is None else cut_style,
        "parts": [
            {
                "partId": "tem",
                "packingFootprint": _polygon(OUTER, []),
                "cutContour": _polygon(OUTER, [HOLE]),
                "artworkClipPath": _polygon(OUTER, [HOLE]),
                "source": {
                    "locatorId": LOCATOR,
                    "contentHash": revision,
                    "byteSize": source_path.stat().st_size,
                    "pageCount": 1,
                    "revision": revision,
                },
                "pages": {
                    "front": _page_binding(),
                    "back": None,
                    "cut": _page_binding(),
                },
            }
        ],
    }


def _public_request(quantity: int = 2) -> dict:
    return {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 7,
        "profile": "balanced",
        "sheet": {
            "widthMm": SHEET_W_MM,
            "heightMm": SHEET_H_MM,
            "marginMm": {"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0},
            "maxSheets": 4,
        },
        "gapMm": 0.0,
        "layoutIntent": "quantity_fulfillment",
        "orientationPolicy": {
            "defaultRotation": {"mode": "fixed", "angleDeg": 0.0},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": "tem",
                "quantity": quantity,
                "outer": copy.deepcopy(OUTER),
                "holes": [],
            }
        ],
    }


def _production(source_path: Path, *, bundle: dict | None = None, quantity: int = 2):
    return build_production_request(
        _public_request(quantity),
        job_id=JOB_ID,
        request_revision=1,
        render_bundle=_bundle(source_path) if bundle is None else bundle,
        clearance={
            "partToPart": {"xMm": 2.0, "yMm": 2.0},
            "partToSheetEdge": {"xMm": 1.0, "yMm": 1.0},
            "partToObstacle": {"xMm": 1.0, "yMm": 1.0},
        },
        algorithm_versions=_versions(),
        native_build_identity=BUILD_IDENTITY,
    )


def _manifest(production, *, poses, sheet_indices=None) -> dict:
    """Manifest tối thiểu hợp lệ với pose do test chỉ định."""

    versions = _versions()
    contract = production.engine_request["productionContract"]
    sheet_indices = [0] * len(poses) if sheet_indices is None else sheet_indices
    placements = [
        {
            "instanceId": f"tem#{index + 1:04}",
            "partId": "tem",
            "sheetIndex": sheet_indices[index],
            "pose": pose,
            "sourceRevision": production.render_bundle_hash,
        }
        for index, pose in enumerate(poses)
    ]
    score = {
        "invalidCount": 0,
        "primaryPenalty": 0,
        "sheetCount": len(set(sheet_indices)),
        "lastSheetUsedAreaFixed": 1,
        "wastedWithinEnvelopeFixed": 1,
        "scoreVersion": versions["scoreVersion"],
    }
    return {
        "schemaVersion": 1,
        "manifestId": JOB_ID,
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "engineVersion": versions["engineVersion"],
        "jobId": JOB_ID,
        "requestRevision": contract["requestRevision"],
        "inputHash": contract["inputHash"],
        "layoutFingerprint": contract["layoutFingerprint"],
        "layoutIntent": "quantity_fulfillment",
        "seed": 7,
        "status": "completed",
        "validation": {"valid": True, "validatorVersion": versions["validatorVersion"]},
        "provenance": {
            "nativeBuildIdentity": BUILD_IDENTITY,
            **{
                key: value
                for key, value in versions.items()
                if key not in {"protocolVersion", "engineVersion", "validatorVersion"}
            },
        },
        "placements": placements,
        "unplaced": [],
        "stats": {
            "sheetCount": len(set(sheet_indices)),
            "placedCount": len(placements),
            "unplacedCount": 0,
            "materialUtilization": 0.1,
            "elapsedMs": 5,
            "attempts": len(placements),
            "orientationEvaluations": len(placements),
            "poseRefinements": 0,
            "terminationReason": "all_placed",
        },
        "search": {
            "budget": {
                "trialCount": 12,
                "orientationProposalsPerPart": 32,
                "beamWidth": 8,
                "refinementRounds": 6,
                "multiStartRestarts": 3,
                "evaluationBudget": 100000,
            },
            "trialsRun": 1,
            "trialsRejected": 0,
            "selectedCandidate": {"kind": "baseline"},
            "selectedScore": score,
        },
    }


def _pose(tx: float, ty: float, rotation: float = 0.0) -> dict:
    return {"rotationDeg": rotation, "translateXmm": tx, "translateYmm": ty}


def _render(workdir: Path, *, poses, sheet_indices=None, bundle=None, quantity=2):
    source = workdir / "nguon.pdf"
    # Bundle đã ghim byte hash của source; tuyệt đối không serialize đè cùng path
    # sau thời điểm pin vì pikepdf có thể sinh trailer khác giữa hai lượt ghi.
    if bundle is None:
        _make_full_ink_source(source)
    production = _production(source, bundle=bundle, quantity=quantity)
    manifest = _manifest(production, poses=poses, sheet_indices=sheet_indices)
    output = workdir / "ket_qua.pdf"
    result = render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )
    return result, production, manifest


def _raw(path: Path, index: int) -> str:
    data = b""
    with pikepdf.Pdf.open(str(path)) as pdf:
        contents = pdf.pages[index].obj.get("/Contents")
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        for stream in streams:
            data += stream.read_bytes()
    return data.decode("latin-1")


def _render_gray(path: Path, index: int, scale: float = 3.0):
    import numpy as np
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        array = np.asarray(doc[index].render(scale=scale).to_pil().convert("L"))
    finally:
        doc.close()
    return array, scale


def _probe_mm(array, scale, x_mm: float, y_mm: float) -> int:
    """Đo pixel tại toạ độ mm canonical (gốc trái-dưới, Y lên)."""

    x_pt = x_mm * PT_PER_MM
    y_pt = (SHEET_H_MM - y_mm) * PT_PER_MM
    return int(array[int(y_pt * scale), int(x_pt * scale)])


# ─────────────────────────────────────────────────────────────────────────────
#  1. Cấu trúc artifact
# ─────────────────────────────────────────────────────────────────────────────


def test_artifact_du_trang_dung_thu_tu_va_dung_kho(workdir: Path) -> None:
    """Hai tem trên một tờ, outputSides=[front, cut] ⇒ đúng 2 trang, đúng khổ."""

    result, _, _ = _render(workdir, poses=[_pose(10.0, 10.0), _pose(60.0, 10.0)])

    assert result.writer_version == PRODUCTION_WRITER_VERSION
    assert result.sheet_count == 1
    assert result.sides == ("front", "cut")
    assert result.page_count == 2
    assert [(page.sheet_index, page.side) for page in result.pages] == [
        (0, "front"),
        (0, "cut"),
    ]
    # Thứ tự vẽ theo instanceId để cùng manifest cho cùng artifact.
    assert result.pages[0].instance_ids == ("tem#0001", "tem#0002")

    with pikepdf.Pdf.open(str(result.output_path)) as pdf:
        assert len(pdf.pages) == 2
        for page in pdf.pages:
            media = [float(value) for value in page.obj["/MediaBox"]]
            assert media == pytest.approx(
                [0.0, 0.0, SHEET_W_MM * PT_PER_MM, SHEET_H_MM * PT_PER_MM]
            )


def test_artifact_nhieu_to_thu_tu_sheet_roi_den_side(workdir: Path) -> None:
    """Thứ tự trang là sheet trước, side sau — không đảo thành side trước."""

    result, _, _ = _render(
        workdir,
        poses=[_pose(10.0, 10.0), _pose(10.0, 10.0), _pose(60.0, 10.0)],
        sheet_indices=[0, 1, 1],
    )
    assert result.sheet_count == 2
    assert [(page.sheet_index, page.side) for page in result.pages] == [
        (0, "front"),
        (0, "cut"),
        (1, "front"),
        (1, "cut"),
    ]
    assert result.pages[2].instance_ids == ("tem#0002", "tem#0003")


# ─────────────────────────────────────────────────────────────────────────────
#  2. Hình học đo trên file thật
# ─────────────────────────────────────────────────────────────────────────────


def test_artwork_nam_dung_pose_va_vung_lo_van_in_muc(workdir: Path) -> None:
    """Artwork phải ở đúng chỗ pose khai, và cửa sổ khuôn vẫn có mực.

    Đây là kiểm ARTIFACT cho quyết định cổng Chặng 0 §7.2: vùng lỗ vẫn in, dao
    mới là thứ cắt.
    """

    result, _, _ = _render(workdir, poses=[_pose(20.0, 20.0)])
    array, scale = _render_gray(result.output_path, 0)

    # Pose (20,20) với referencePoint = centroid khuôn 30x30 = (15,15)
    # ⇒ G dịch mọi điểm thêm (+5,+5) ⇒ khuôn phủ [5..35] x [5..35],
    #   cửa sổ phủ [15..25] x [15..25], trang nguồn 40mm phủ [5..45].
    assert _probe_mm(array, scale, 8.0, 8.0) < 80
    assert _probe_mm(array, scale, 34.0, 34.0) < 80
    # Vùng lỗ VẪN CÓ MỰC — đây là quyết định §7.2 đo trên raster thật.
    assert _probe_mm(array, scale, 20.0, 20.0) < 80
    # Điểm quyết định của phép clip: (36,36) nằm NGOÀI khuôn nhưng vẫn TRONG
    # phạm vi trang nguồn kín mực. Trắng ở đây chứng minh clip thật sự chặn,
    # không phải nhờ nguồn hết mực.
    assert _probe_mm(array, scale, 36.0, 36.0) > 240
    assert _probe_mm(array, scale, 38.0, 38.0) > 240
    assert _probe_mm(array, scale, 2.0, 2.0) > 240


def test_trang_cut_co_du_vong_ngoai_va_vong_lo(workdir: Path) -> None:
    """Dao phải cắt cả cửa sổ: trang CUT có 2 subpath, không phải 1."""

    result, _, _ = _render(workdir, poses=[_pose(20.0, 20.0)])
    cut_stream = _raw(result.output_path, 1)

    # Hai subpath kín ⇒ hai lệnh `m` mở đường và hai `h` khép lại.
    assert cut_stream.count(" m\n") == 2
    assert cut_stream.count("h\n") == 2
    # Một lệnh S duy nhất cho cả hai subpath, rồi Q đóng khối q đã mở.
    assert cut_stream.count("\nS\n") == 1
    assert cut_stream.rstrip().endswith("Q")
    # Nét CUT là stroke, tuyệt đối không fill — fill sẽ bít mất artwork.
    assert " f\n" not in cut_stream
    assert " f*" not in cut_stream
    # Độ dày và màu theo cutStyle: 0.5mm và 100% Magenta CMYK.
    assert f"{0.5 * PT_PER_MM:.9f} w" in cut_stream
    assert "0.000000000 1.000000000 0.000000000 0.000000000 K" in cut_stream

    # Đo trên raster: nét phải nằm đúng trên BIÊN CỬA SỔ, không chỉ biên ngoài.
    array, scale = _render_gray(result.output_path, 1)
    for x_mm in (5.0, 35.0, 15.0, 25.0):
        assert _probe_mm(array, scale, x_mm, 20.0) < 250, f"thiếu nét tại x={x_mm}"
    # Chỉ stroke, không fill: giữa lỗ và giữa vật liệu đều phải trắng.
    assert _probe_mm(array, scale, 20.0, 20.0) > 250
    assert _probe_mm(array, scale, 10.0, 20.0) > 250


def test_trang_cut_khong_paint_artwork(workdir: Path) -> None:
    """Trang CUT chỉ có vector; không được nhúng Form artwork nào."""

    result, _, _ = _render(workdir, poses=[_pose(20.0, 20.0)])
    with pikepdf.Pdf.open(str(result.output_path)) as pdf:
        front_resources = pdf.pages[0].obj.get("/Resources")
        cut_resources = pdf.pages[1].obj.get("/Resources")
        assert "/XObject" in front_resources
        assert cut_resources is None or "/XObject" not in cut_resources
    assert " Do" not in _raw(result.output_path, 1)


def test_cut_theo_dung_pose_cua_tung_instance(workdir: Path) -> None:
    """Hai instance khác pose ⇒ nét CUT nằm ở hai chỗ khác nhau trên trang."""

    result, _, _ = _render(workdir, poses=[_pose(20.0, 20.0), _pose(80.0, 20.0)])
    cut_stream = _raw(result.output_path, 1)
    assert cut_stream.count(" m\n") == 4  # 2 instance x (outer + hole)

    array, scale = _render_gray(result.output_path, 1)
    # Nét CUT chạy trên biên khuôn của từng instance: x=5 và x=65.
    assert _probe_mm(array, scale, 5.0, 20.0) < 250
    assert _probe_mm(array, scale, 65.0, 20.0) < 250
    # Giữa hai khuôn không có nét.
    assert _probe_mm(array, scale, 50.0, 20.0) > 250


def test_overprint_di_qua_extgstate(workdir: Path) -> None:
    """overprint=true phải thành ExtGState thật, không phải comment."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    style = _cut_style()
    style["stroke"]["overprint"] = True
    bundle = _bundle(source, cut_style=style)

    result, _, _ = _render(workdir, poses=[_pose(20.0, 20.0)], bundle=bundle)
    with pikepdf.Pdf.open(str(result.output_path)) as pdf:
        states = pdf.pages[1].obj["/Resources"]["/ExtGState"]
        names = list(states.keys())
        assert len(names) == 1
        state = states[names[0]]
        assert bool(state["/OP"]) is True
        assert bool(state["/op"]) is True
        assert int(state["/OPM"]) == 1
    assert " gs" in _raw(result.output_path, 1)


# ─────────────────────────────────────────────────────────────────────────────
#  3. Writer không solve, và fail-closed
# ─────────────────────────────────────────────────────────────────────────────


def test_writer_khong_solve_lai_va_khong_sua_manifest(workdir: Path) -> None:
    """Manifest đưa vào phải nguyên vẹn sau render, và render hai lần cho cùng file."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    production = _production(source)
    manifest = _manifest(production, poses=[_pose(20.0, 20.0)])
    snapshot = json.dumps(manifest, sort_keys=True)

    first = workdir / "lan1.pdf"
    second = workdir / "lan2.pdf"
    payload = {
        "engineRequest": production.engine_request,
        "renderBundle": production.render_bundle,
        "renderBundleHash": production.render_bundle_hash,
    }
    for target in (first, second):
        render_production_nesting(
            production_request=payload,
            manifest=manifest,
            source_paths={LOCATOR: source},
            output_path=target,
        )

    # Writer không được mutate manifest của caller.
    assert json.dumps(manifest, sort_keys=True) == snapshot
    # Cùng manifest ⇒ cùng content stream trên mọi trang.
    for index in range(2):
        assert _raw(first, index) == _raw(second, index)


def test_render_bi_tu_choi_khi_source_revision_lech(workdir: Path) -> None:
    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    production = _production(source)
    manifest = _manifest(production, poses=[_pose(20.0, 20.0)])
    manifest["placements"][0]["sourceRevision"] = "sha256:" + "f" * 64
    output = workdir / "khong-duoc-tao.pdf"

    with pytest.raises(ManifestRenderContractError, match="renderBundleHash"):
        render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": production.render_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=manifest,
            source_paths={LOCATOR: source},
            output_path=output,
        )
    assert not output.exists()


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda m: m.update(status="failed"), "completed"),
        (lambda m: m.update(status="cancelled"), "completed"),
        (lambda m: m["validation"].update(valid=False), "validator"),
        (
            lambda m: m.update(
                unplaced=[
                    {
                        "partId": "tem",
                        "instanceId": "tem#0002",
                        "reason": "NO_FEASIBLE_POSE",
                    }
                ]
            ),
            "chưa xếp",
        ),
        (lambda m: m.update(placements=[]), "không có placement"),
        (lambda m: m["stats"].update(sheetCount=9), "sheetCount"),
        (lambda m: m["stats"].update(placedCount=9), "placedCount"),
        (
            lambda m: m["placements"][0].update(sheetIndex=3),
            "liên tục từ 0",
        ),
    ],
)
def test_fail_closed_khong_tao_file(workdir: Path, mutate, match) -> None:
    """Mọi ca chưa đủ điều kiện phải dừng TRƯỚC khi ghi byte đầu tiên."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    production = _production(source)
    manifest = _manifest(production, poses=[_pose(20.0, 20.0)])
    mutate(manifest)
    output = workdir / "khong-duoc-tao.pdf"

    with pytest.raises(ManifestRenderContractError, match=match):
        render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": production.render_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=manifest,
            source_paths={LOCATOR: source},
            output_path=output,
        )
    assert not output.exists()


def test_thieu_snapshot_nguon_thi_tu_choi(workdir: Path) -> None:
    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    production = _production(source)
    manifest = _manifest(production, poses=[_pose(20.0, 20.0)])
    output = workdir / "khong-duoc-tao.pdf"

    with pytest.raises(ManifestRenderContractError, match="Thiếu snapshot nguồn"):
        render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": production.render_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=manifest,
            source_paths={},
            output_path=output,
        )
    assert not output.exists()


def test_separation_dung_colorspace_that_tren_artifact(workdir: Path) -> None:
    """Nét CUT theo kênh spot dựng ``/Separation`` thật trong PDF đã ghi.

    NEST (audit 2026-08-28 §A3.1) — ĐỔI KỲ VỌNG CÓ CHỦ ĐÍCH. Bản trước khoá hành
    vi *fail-closed* vì hợp đồng thiếu alternate colorspace. Finding A3-1 đã được
    đóng: `RenderCutStrokeV2` giờ mang `alternate`, nên writer dựng được
    ``[/Separation /Name /DeviceCMYK <tint transform>]`` hợp lệ.
    """

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    style = _cut_style()
    style["stroke"].update(
        colorSpace="separation",
        components=[1.0],
        separationName="cutcontour",
        alternate={"space": "cmyk", "components": [0.0, 1.0, 0.0, 0.0]},
    )
    bundle = _bundle(source, cut_style=style)

    result, _, _ = _render(workdir, poses=[_pose(20.0, 20.0)], bundle=bundle)

    with pikepdf.Pdf.open(str(result.output_path)) as pdf:
        spaces = pdf.pages[1].obj["/Resources"]["/ColorSpace"]
        names = list(spaces.keys())
        assert len(names) == 1
        array = spaces[names[0]]
        assert str(array[0]) == "/Separation"
        assert str(array[1]) == "/cutcontour"
        assert str(array[2]) == "/DeviceCMYK"
        transform = array[3]
        # tint 0 → trắng, tint 1 → đúng màu alternate đã khai.
        assert int(transform["/FunctionType"]) == 2
        assert [float(v) for v in transform["/C0"]] == [0.0, 0.0, 0.0, 0.0]
        assert [float(v) for v in transform["/C1"]] == [0.0, 1.0, 0.0, 0.0]

    cut_stream = _raw(result.output_path, 1)
    assert " CS" in cut_stream
    assert "1.000000000 SCN" in cut_stream
    # Không được rơi về toán tử màu process khi đã khai separation.
    assert " K\n" not in cut_stream

    array_gray, scale = _render_gray(result.output_path, 1)
    # Nét vẫn phải thấy được trên raster qua alternate colorspace.
    assert _probe_mm(array_gray, scale, 5.0, 20.0) < 250
    assert _probe_mm(array_gray, scale, 15.0, 20.0) < 250


def test_separation_thieu_alternate_bi_tu_choi(workdir: Path) -> None:
    """Thiếu alternate thì chặn ở adapter, không tới được writer."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    style = _cut_style()
    style["stroke"].update(
        colorSpace="separation", components=[1.0], separationName="cutcontour"
    )
    with pytest.raises(Exception, match="alternate"):
        _production(source, bundle=_bundle(source, cut_style=style))


def test_layout_fingerprint_va_manifest_id_duoc_echo_lai(workdir: Path) -> None:
    """Kết quả render phải mang đúng identity để bước commit đối chiếu được."""

    result, production, manifest = _render(workdir, poses=[_pose(20.0, 20.0)])
    assert result.manifest_id == JOB_ID
    assert result.layout_fingerprint == manifest["layoutFingerprint"]
    assert result.render_bundle_hash == production.render_bundle_hash
    assert canonical_sha256(production.render_bundle) == production.render_bundle_hash


# ─────────────────────────────────────────────────────────────────────────────
#  8. Ốc bế — §NEST-WRITER-PONT
# ─────────────────────────────────────────────────────────────────────────────
#
# Lỗi gốc: writer chỉ đọc bốn khoá `outputSides`/`parts`/`sheetFrames`/`cutStyle`, KHÔNG
# đọc `renderBundle.marks`. Ốc bế được map đúng, validate đúng, vào `renderBundleHash`
# đúng, rồi không bao giờ tới tờ in. Tờ bình không có ốc là tờ thợ không canh được.
#
# Bốn nhóm bất biến ở đây, và nhóm quan trọng nhất là **vị trí**: sai hệ trục thì ốc vẫn
# xuất hiện nên đếm toán tử vẫn xanh, chỉ đo trên tờ mới thấy. Vì vậy các test vị trí đo
# **pixel thật**, không đọc toán tử.

#: Registration CMYK 100/100/100/100 như writer ghi ra.
_REG = "1.000000000 1.000000000 1.000000000 1.000000000"


def _pont_config(**overrides) -> dict:
    config = {
        "shape": "circle",
        "sizeMm": 6.0,
        "thicknessMm": 0.5,
        "isGraphtec": False,
        "layerInfoName": "",
        "layerName": "Pont",
        "groupName": "G",
        "itemName": "MKLINE",
        "disableCollision": False,
        "marginsMm": {"top": 7.0, "bottom": 7.0, "left": 7.0, "right": 7.0},
        "guides": [],
    }
    config.update(overrides)
    return config


def _bundle_with_pont(
    source_path: Path, *, pont: dict, ponts_on_cut: bool = True
) -> dict:
    bundle = _bundle(source_path)
    bundle["marks"]["pont"] = pont
    bundle["marks"]["cut"]["pontsOnCutFile"] = ponts_on_cut
    return bundle


def _render_with_pont(workdir: Path, *, pont: dict, ponts_on_cut: bool = True):
    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle_with_pont(source, pont=pont, ponts_on_cut=ponts_on_cut)
    return _render(workdir, poses=[_pose(60.0, 60.0)], bundle=bundle, quantity=1)


def _bundle_cnc_duplex_with_pont(
    source_path: Path,
    *,
    flip_edge: str,
    duplex_registration: bool = False,
) -> dict:
    """Bundle CNC hai mặt tối thiểu để đo policy boong trên PDF thật."""

    bundle = _bundle(source_path)
    bundle["flow"]["tool"] = "cnc_imposer"
    bundle["outputSides"] = ["front", "back", "cut"]
    if flip_edge == "long":
        back_frame = [-1.0, 0.0, 0.0, 1.0, SHEET_W_MM, 0.0]
        physical_axis = "x"
    else:
        back_frame = [1.0, 0.0, 0.0, -1.0, 0.0, SHEET_H_MM]
        physical_axis = "y"
    bundle["duplex"] = {
        "mode": "duplex",
        "flipEdge": flip_edge,
        "physicalAxis": physical_axis,
    }
    bundle["sheetFrames"]["back"] = back_frame
    bundle["renderer"] = {
        "identity": "cnc_imposer_pdf",
        "version": CNC_IMPOSER_RENDERER_VERSION,
    }
    bundle["marks"]["pont"] = {"type": "custom", "config": _pont_config()}
    bundle["marks"]["duplexRegistration"] = duplex_registration
    source = bundle["parts"][0]["source"]
    source["pageCount"] = 2
    bundle["parts"][0]["pages"]["back"] = _page_binding(1)
    return bundle


@pytest.mark.parametrize("flip_edge", ["long", "short"])
def test_cnc_duplex_boong_chi_o_front_va_cut_khong_o_back(
    workdir: Path, flip_edge: str
) -> None:
    """Boong định vị máy cắt không phải dấu canh chồng mặt của trang Back."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source, page_count=2)
    bundle = _bundle_cnc_duplex_with_pont(source, flip_edge=flip_edge)
    production = _production(source, bundle=bundle, quantity=1)
    manifest = _manifest(production, poses=[_pose(60.0, 60.0)])
    output = workdir / f"cnc-{flip_edge}.pdf"
    result = render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )

    assert [page.side for page in result.pages] == ["front", "back", "cut"]
    front_raw, back_raw, cut_raw = (_raw(output, index) for index in range(3))
    assert "% PRYNX_DUPLEX_REGISTRATION" not in front_raw + back_raw + cut_raw
    assert f"{_REG} k" in front_raw
    assert f"{_REG} k" not in back_raw
    assert f"{_REG} k" in cut_raw
    assert "\nS\n" in cut_raw, "trang CUT vẫn phải giữ vector dao"
    assert result.pages[1].instance_ids == ("tem#0001",)
    back_pixels, _ = _render_gray(output, 1)
    assert int(back_pixels.min()) < 128, "Back vẫn phải có artwork sau khi bỏ boong"


@pytest.mark.parametrize("flip_edge", ["long", "short"])
def test_dau_canh_duplex_dung_vi_tri_front_back_khong_o_cut_va_khong_bi_report_che(
    workdir: Path, flip_edge: str
) -> None:
    """Dấu canh là feature riêng: Front+Back, cùng vị trí vật lý, không CUT."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source, page_count=2)
    bundle = _bundle_cnc_duplex_with_pont(
        source,
        flip_edge=flip_edge,
        duplex_registration=True,
    )
    bundle["artifactOptions"] = _report_options(
        fields=["labelsPerSheet", "actualQty", "sheetCount"]
    )
    production = _production(source, bundle=bundle, quantity=1)
    manifest = _manifest(production, poses=[_pose(60.0, 60.0)])
    output = workdir / f"cnc-registration-{flip_edge}.pdf"
    result = render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )

    front_raw, back_raw, cut_raw = (_raw(output, index) for index in range(3))
    marker = "% PRYNX_DUPLEX_REGISTRATION"
    assert marker in front_raw
    assert marker in back_raw
    assert marker not in cut_raw
    # Cùng lúc: boong vẫn Front+CUT, tuyệt đối không lan sang Back.
    assert f"{_REG} k" in front_raw
    assert f"{_REG} k" not in back_raw
    assert f"{_REG} k" in cut_raw

    margin = DUPLEX_REGISTRATION_MARGIN_MM
    centers = (
        (SHEET_W_MM / 2.0, margin),
        (SHEET_W_MM / 2.0, SHEET_H_MM - margin),
        (margin, SHEET_H_MM / 2.0),
        (SHEET_W_MM - margin, SHEET_H_MM / 2.0),
    )
    for page_index in (0, 1):
        pixels, scale = _render_gray(output, page_index)
        for x_mm, y_mm in centers:
            assert _probe_mm(pixels, scale, x_mm, y_mm) < 128, (
                f"{flip_edge}: trang {page_index} thiếu dấu tại ({x_mm}, {y_mm})mm"
            )
    assert [page.side for page in result.pages] == ["front", "back", "cut"]


def test_telemetry_writer_true_shape_gom_phase_khong_doi_artifact(
    workdir: Path, monkeypatch
) -> None:
    """PERF-NEST-06: phase tổng inclusive và counter success có nghĩa nhất quán."""

    from app.config import settings as app_settings

    # SEC (audit 2026-09-05 §LOG.01): telemetry chỉ có authority trong dev.
    monkeypatch.setattr(app_settings, "DEV_MODE", True)
    monkeypatch.setenv("PRYNX_PERF", "1")
    source = workdir / "nguon-telemetry.pdf"
    _make_full_ink_source(source, page_count=2)
    bundle = _bundle_cnc_duplex_with_pont(
        source,
        flip_edge="long",
        duplex_registration=True,
    )
    bundle["artifactOptions"] = _report_options(fields=["labelsPerSheet"])
    production = _production(source, bundle=bundle, quantity=2)
    manifest = _manifest(
        production,
        poses=[_pose(20.0, 20.0), _pose(80.0, 60.0)],
    )
    output = workdir / "cnc-telemetry.pdf"

    stages = perf_sampler.PerfStages()
    result = render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )
    telemetry = stages.finish()

    assert result.output_path == output
    assert output.exists()
    for phase in (
        "writer_embed_s",
        "writer_form_paint_s",
        "writer_page_build_total_s",
        "writer_base_save_s",
        "writer_report_s",
        "writer_duplex_s",
    ):
        assert telemetry[phase] >= 0.0
    assert telemetry["writer_embed_calls"] == 4
    assert telemetry["writer_embed_cache_misses"] == 2
    assert telemetry["writer_embed_cache_hits"] == 2
    assert telemetry["writer_form_paint_calls"] == 4
    assert telemetry["writer_page_count"] == 3
    assert telemetry["writer_cut_page_count"] == 1
    assert telemetry["writer_render_successes"] == 1
    assert telemetry["writer_base_save_attempts"] == 1
    assert telemetry["writer_base_save_successes"] == 1
    assert telemetry["writer_report_attempts"] == 1
    assert telemetry["writer_report_successes"] == 1
    assert telemetry["writer_duplex_attempts"] == 1
    assert telemetry["writer_duplex_successes"] == 1
    assert telemetry["writer_save_successes"] == 3


def test_telemetry_report_loi_chi_dem_attempt_khong_dem_success(
    workdir: Path, monkeypatch
) -> None:
    """Counter attempt/success không được gọi lượt save lỗi là một pass thành công."""

    from app.config import settings as app_settings
    from app.workers import nup_report

    monkeypatch.setattr(app_settings, "DEV_MODE", True)
    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", lambda *_args, **_kwargs: False)
    source = workdir / "nguon-telemetry-report-loi.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = _report_options(fields=["labelsPerSheet"])
    production = _production(source, bundle=bundle)
    output = workdir / "telemetry-report-loi.pdf"

    stages = perf_sampler.PerfStages()
    with pytest.raises(ManifestRenderContractError, match="Không ghi được report"):
        render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": production.render_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=_manifest(production, poses=[_pose(20.0, 20.0)]),
            source_paths={LOCATOR: source},
            output_path=output,
        )
    telemetry = stages.finish()

    assert telemetry["writer_base_save_attempts"] == 1
    assert telemetry["writer_base_save_successes"] == 1
    assert telemetry["writer_report_attempts"] == 1
    assert "writer_report_successes" not in telemetry
    assert telemetry["writer_save_successes"] == 1
    assert not output.exists()


def test_oc_tron_ve_du_bon_goc_tren_ca_trang_in_va_trang_cut(workdir: Path) -> None:
    """Bốn ốc, hình đặc, màu registration — và có trên CẢ hai trang."""

    result, _, _ = _render_with_pont(
        workdir, pont={"type": "custom", "config": _pont_config()}
    )

    for index in range(result.page_count):
        raw = _raw(result.output_path, index)
        assert f"{_REG} k" in raw, f"trang {index} thiếu màu registration cho ốc"
        # Bốn ốc, mỗi ốc bốn cung Bézier và một lệnh fill.
        assert raw.count(" c\n") >= 16, f"trang {index} không đủ cung tròn"


def _ocg_name_list(path: Path) -> list[str]:
    with pikepdf.Pdf.open(str(path)) as pdf:
        oc_props = pdf.Root.get("/OCProperties")
        return [str(item.get("/Name", "")) for item in oc_props.get("/OCGs", [])]


def test_true_shape_sticker_giu_cay_graphtec_va_nm_tren_artifact(
    workdir: Path,
) -> None:
    """Tên boong Sticker phải tồn tại trên PDF production, không chỉ trong bundle."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle_with_pont(
        source,
        pont={
            "type": "custom",
            "config": _pont_config(
                isGraphtec=True,
                layerInfoName="AUDIT_GRAPH_INFO",
                layerName="AUDIT_LAYER",
                groupName="AUDIT_GROUP",
                itemName="AUDIT_ITEM",
            ),
        },
    )
    production = _production(source, bundle=bundle, quantity=1)
    manifest = _manifest(production, poses=[_pose(60.0, 60.0)])
    output = workdir / "sticker-true-shape-layered.pdf"
    render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )

    assert _ocg_name_list(output) == [
        "AUDIT_GRAPH_INFO", "AUDIT_LAYER", "AUDIT_GROUP",
    ]
    raw_cut = _raw(output, 1)
    assert "/OC /MC_PONT_GROUP BDC" in raw_cut
    assert raw_cut.count("/Span /NM_PONT_ITEM BDC") >= 4
    with pikepdf.Pdf.open(str(output)) as pdf:
        props = pdf.pages[1].Resources["/Properties"]
        group_ref = props["/MC_PONT_GROUP"]
        assert str(group_ref.get("/Name", "")) == "AUDIT_GROUP"
        assert str(props["/NM_PONT_ITEM"].get("/NM", "")) == "AUDIT_ITEM"


def test_true_shape_cnc_giu_ocg_tren_front_va_cut_khong_o_back(
    workdir: Path,
) -> None:
    """CNC true-shape giữ tên trên Front/CUT và không gắn boong lên Back."""

    source = workdir / "nguon-cnc.pdf"
    _make_full_ink_source(source, page_count=2)
    bundle = _bundle_cnc_duplex_with_pont(source, flip_edge="long")
    bundle["marks"]["pont"]["config"].update({
        "isGraphtec": True,
        "layerInfoName": "AUDIT_GRAPH_INFO",
        "layerName": "AUDIT_LAYER",
        "groupName": "AUDIT_GROUP",
        "itemName": "AUDIT_ITEM",
    })
    production = _production(source, bundle=bundle, quantity=1)
    manifest = _manifest(production, poses=[_pose(60.0, 60.0)])
    output = workdir / "cnc-true-shape-layered.pdf"
    render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )

    assert _ocg_name_list(output) == [
        "AUDIT_GRAPH_INFO", "AUDIT_LAYER", "AUDIT_GROUP",
    ]
    for page_index in (0, 2):
        raw = _raw(output, page_index)
        assert "/OC /MC_PONT_GROUP BDC" in raw
        assert raw.count("/Span /NM_PONT_ITEM BDC") >= 4
    raw_back = _raw(output, 1)
    assert "/OC /MC_PONT_GROUP BDC" not in raw_back
    assert "/Span /NM_PONT_ITEM BDC" not in raw_back


def test_oc_dung_vi_tri_bon_goc_do_bang_pixel(workdir: Path) -> None:
    """Chốt hình học thật: có mực ở đúng tâm bốn ốc, và không có ở giữa tờ.

    Đo pixel vì đếm toán tử không phân biệt được ốc đặt đúng chỗ với ốc đặt sai hệ trục.
    """

    size_mm = 6.0
    margin = 7.0
    result, _, _ = _render_with_pont(
        workdir,
        pont={
            "type": "custom",
            "config": _pont_config(
                sizeMm=size_mm,
                marginsMm={
                    "top": margin,
                    "bottom": margin,
                    "left": margin,
                    "right": margin,
                },
            ),
        },
    )

    array, scale = _render_gray(result.output_path, 1)  # trang CUT: nền trắng, dễ đo
    radius = size_mm / 2.0
    tam = [
        (margin + radius, SHEET_H_MM - margin - radius),
        (SHEET_W_MM - margin - radius, SHEET_H_MM - margin - radius),
        (margin + radius, margin + radius),
        (SHEET_W_MM - margin - radius, margin + radius),
    ]
    for x_mm, y_mm in tam:
        assert _probe_mm(array, scale, x_mm, y_mm) < 128, (
            f"thiếu mực ốc tại ({x_mm}, {y_mm})mm"
        )

    # Giữa tờ không được có ốc — chặn ca vẽ tràn hoặc sai toạ độ hoàn toàn.
    assert _probe_mm(array, scale, SHEET_W_MM / 2.0, SHEET_H_MM / 2.0) > 200


def test_le_tren_va_le_duoi_khong_bi_hoan_vi(workdir: Path) -> None:
    """Lane cũ tính y **top-down**, writer ghi **bottom-up** — đảo sai là hoán vị lề.

    Dùng lề bất đối xứng để phân biệt được: lề trên 5mm, lề dưới 25mm. Nếu writer đảo
    thiếu hoặc đảo hai lần thì ốc trên nằm ở chỗ của ốc dưới, mà tổng số ốc vẫn là 4 nên
    mọi test đếm toán tử vẫn xanh.
    """

    size_mm = 6.0
    radius = size_mm / 2.0
    result, _, _ = _render_with_pont(
        workdir,
        pont={
            "type": "custom",
            "config": _pont_config(
                sizeMm=size_mm,
                marginsMm={"top": 5.0, "bottom": 25.0, "left": 7.0, "right": 7.0},
            ),
        },
    )

    array, scale = _render_gray(result.output_path, 1)
    x_mm = 7.0 + radius
    y_tren = SHEET_H_MM - 5.0 - radius
    y_duoi = 25.0 + radius

    assert _probe_mm(array, scale, x_mm, y_tren) < 128, "ốc trên không theo lề top=5mm"
    assert _probe_mm(array, scale, x_mm, y_duoi) < 128, "ốc dưới không theo lề bottom=25mm"
    # Vị trí mà ốc sẽ nằm nếu lề bị hoán vị — phải TRỐNG.
    assert _probe_mm(array, scale, x_mm, SHEET_H_MM - 25.0 - radius) > 200
    assert _probe_mm(array, scale, x_mm, 5.0 + radius) > 200


def test_khong_khai_oc_thi_khong_co_toan_tu_nao(workdir: Path) -> None:
    """`type='none'` phải giữ nguyên hành vi cũ — không thêm byte nào."""

    result, _, _ = _render_with_pont(
        workdir, pont={"type": "none", "config": None}
    )

    for index in range(result.page_count):
        assert f"{_REG} k" not in _raw(result.output_path, index)


def test_ponts_on_cut_file_tat_thi_trang_cut_khong_co_oc(workdir: Path) -> None:
    """Ốc vẫn phải có trên trang in — chỉ trang CUT là không."""

    result, _, _ = _render_with_pont(
        workdir,
        pont={"type": "custom", "config": _pont_config()},
        ponts_on_cut=False,
    )

    assert f"{_REG} k" in _raw(result.output_path, 0)
    assert f"{_REG} k" not in _raw(result.output_path, 1)


@pytest.mark.parametrize("shape", ["l_corner", "l_inverted"])
def test_oc_goc_L_la_polyline_lien_co_miter(workdir: Path, shape: str) -> None:
    """Góc L phải là MỘT polyline ba điểm có miter join, không phải hai đoạn rời.

    Hai đoạn rời thì đầu but-cap chồng lên nhau, phóng to thấy hở và máy cắt chạy path
    không liền. Lane cũ dùng ``line_join=0``; writer phải phát ``0 j``.
    """

    result, _, _ = _render_with_pont(
        workdir,
        pont={"type": "custom", "config": _pont_config(shape=shape)},
    )

    raw = _raw(result.output_path, 0)
    assert f"{_REG} K" in raw, "góc L phải là nét stroke màu registration"
    assert "0 j" in raw, "thiếu miter join"
    assert " c\n" not in raw, "góc L không được là đường tròn"
    # Bốn ốc: mỗi ốc một `m` và hai `l`.
    assert raw.count(" l\n") >= 8


def test_guide_ve_dung_cho_va_ton_trong_do_lech(workdir: Path) -> None:
    """Guide BL: bắt đầu tại offsetX, cao offsetY tính từ mép DƯỚI."""

    result, _, _ = _render_with_pont(
        workdir,
        pont={
            "type": "custom",
            "config": _pont_config(
                guides=[
                    {
                        "position": "BL",
                        "lengthMm": 20.0,
                        "thicknessMm": 1.0,
                        "offsetXmm": 3.0,
                        "offsetYmm": 4.0,
                    }
                ]
            ),
        },
    )

    array, scale = _render_gray(result.output_path, 1)
    # Giữa vạch guide.
    assert _probe_mm(array, scale, 3.0 + 10.0, 4.0) < 128
    # Ngoài đầu vạch thì trống.
    assert _probe_mm(array, scale, 3.0 + 30.0, 4.0) > 200


def test_guide_tren_va_duoi_khong_bi_hoan_vi(workdir: Path) -> None:
    """TL đo offsetY từ mép TRÊN, BL đo từ mép DƯỚI — cùng bẫy đảo trục với ốc."""

    result, _, _ = _render_with_pont(
        workdir,
        pont={
            "type": "custom",
            "config": _pont_config(
                guides=[
                    {
                        "position": "TL",
                        "lengthMm": 20.0,
                        "thicknessMm": 1.0,
                        "offsetXmm": 3.0,
                        "offsetYmm": 4.0,
                    }
                ]
            ),
        },
    )

    array, scale = _render_gray(result.output_path, 1)
    assert _probe_mm(array, scale, 3.0 + 10.0, SHEET_H_MM - 4.0) < 128
    assert _probe_mm(array, scale, 3.0 + 10.0, 4.0) > 200


def test_oc_ve_sau_artwork_nen_khong_bi_de_len(workdir: Path) -> None:
    """Ốc là dấu canh của thợ; artwork đè lên là mất tác dụng.

    Đặt tem trùng chỗ ốc góc dưới-trái rồi kiểm ốc vẫn còn nét trên trang in.
    """

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle_with_pont(
        source,
        pont={"type": "custom", "config": _pont_config(shape="l_corner")},
    )
    result, _, _ = _render(
        workdir, poses=[_pose(0.0, 0.0)], bundle=bundle, quantity=1
    )

    raw = _raw(result.output_path, 0)
    assert f"{_REG} K" in raw
    # Toán tử ốc phải nằm SAU lệnh `Do` cuối cùng — tức sau khi mọi Form artwork đã vẽ.
    assert raw.rindex(" Do") < raw.index(f"{_REG} K")


def test_khai_oc_ma_thieu_config_thi_fail_closed(workdir: Path) -> None:
    """Không được âm thầm bỏ ốc: khai có ốc mà thiếu cấu hình là lỗi hợp đồng."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["marks"]["pont"] = {"type": "custom", "config": None}

    with pytest.raises(Exception) as excinfo:
        _render(workdir, poses=[_pose(60.0, 60.0)], bundle=bundle, quantity=1)

    assert "config" in str(excinfo.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
#  9. Report trên tờ — §NEST-WRITER-REPORT
# ─────────────────────────────────────────────────────────────────────────────
#
# Cùng gốc với ốc bế: writer không đọc `renderBundle.artifactOptions`, nên report được
# validate tới từng đơn vị (`fontSizePt` 4..40, `placement.position`, `lamination.sides`)
# rồi không bao giờ xuất hiện trên tờ.
#
# Report đi qua `nup_report.stamp_reports_on_pdf` — CHÍNH hàm lane lưới dùng — nên hai lane
# ra cùng font và cùng cách canh. Test ở đây khoá bốn điều: có chữ, đúng trang, đúng vị trí,
# và không âm thầm bỏ khi lỗi.


def _report_options(**overrides) -> dict:
    report = {
        "enabled": True,
        "fields": ["labelsPerSheet", "sheetCount"],
        "requestedQty": None,
        "labelName": "",
        "material": "",
        "lamination": {"type": "none", "sides": 1},
        "orderCode": "",
        "customText": "",
        "removeDiacritics": False,
        "placement": {
            "position": "top",
            "centered": True,
            "offsetXmm": 5.0,
            "offsetYmm": 5.0,
            "fontSizePt": 8.0,
        },
    }
    report.update(overrides)
    return {"exportUniqueSheets": True, "report": report}


def _render_with_report(workdir: Path, *, report_overrides=None, quantity: int = 2):
    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = _report_options(**(report_overrides or {}))
    poses = [_pose(60.0, 60.0)] if quantity == 1 else [_pose(10.0, 10.0), _pose(60.0, 60.0)]
    return _render(workdir, poses=poses, bundle=bundle, quantity=quantity)


def test_report_override_doi_artifact_nhung_khong_mutate_layout_bundle(
    workdir: Path,
) -> None:
    """Overlay B dùng layout/bundle A bất biến và có provenance artifact riêng."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = _report_options(
        fields=["orderCode", "labelName", "material"],
        orderCode="DH-A",
        labelName="Sản phẩm A",
        material="Decal A",
    )
    production = _production(source, bundle=bundle, quantity=1)
    manifest = _manifest(production, poses=[_pose(60.0, 60.0)])
    bundle_before = copy.deepcopy(production.render_bundle)
    manifest_before = copy.deepcopy(manifest)

    def render_to(name: str, report_override=None):
        return render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": production.render_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=manifest,
            source_paths={LOCATOR: source},
            output_path=workdir / name,
            report_override=report_override,
        )

    from_bundle = render_to("report-a.pdf")
    report_b = ImpositionReportEnabled(
        fields=("orderCode", "labelName", "material"),
        order_code="DH-B",
        label_name="Sản phẩm B",
        material="Decal B",
    )
    from_override = render_to("report-b.pdf", report_override=report_b)

    canonical_b = canonicalize_imposition_report(
        report_b,
        layout_intent="quantity_fulfillment",
    )
    assert from_bundle.report_hash == canonical_sha256(
        bundle_before["artifactOptions"]["report"]
    )
    assert from_override.report_hash == canonical_sha256(canonical_b)
    assert from_bundle.report_hash != from_override.report_hash
    assert (
        from_bundle.artifact_render_fingerprint
        != from_override.artifact_render_fingerprint
    )
    assert from_bundle.manifest_id == from_override.manifest_id
    assert from_bundle.layout_fingerprint == from_override.layout_fingerprint
    assert from_bundle.render_bundle_hash == from_override.render_bundle_hash
    assert production.render_bundle == bundle_before
    assert manifest == manifest_before
    assert from_bundle.output_path.read_bytes() != from_override.output_path.read_bytes()


def test_report_xuat_hien_tren_trang_in(workdir: Path) -> None:
    """Có chữ report trên trang in — đây là lỗ người dùng báo."""

    result, _, _ = _render_with_report(workdir)

    array, scale = _render_gray(result.output_path, 0)
    # Dải ngang ở đỉnh tờ, nơi report 'top' phải nằm.
    dai = array[: int(12.0 * PT_PER_MM * scale), :]
    assert int(dai.min()) < 128, "không có nét chữ nào ở dải report phía trên"


def test_report_khong_nam_tren_trang_cut(workdir: Path) -> None:
    """Trang CUT dành cho người làm dao; chữ report ở đó là rác cho máy cắt."""

    result, _, _ = _render_with_report(workdir)

    array, scale = _render_gray(result.output_path, 1)
    dai = array[: int(12.0 * PT_PER_MM * scale), :]
    assert int(dai.min()) > 200, "trang CUT không được có report"


@pytest.mark.parametrize("position", ["top", "bottom"])
def test_report_ton_trong_vi_tri_da_chon(workdir: Path, position: str) -> None:
    """Vị trí phải tới được tờ. Trước bản vá `placement` không được map nên luôn 'top'."""

    # `quantity=1` để tem nằm giữa tờ (pose 60,60 — cao 30mm): cả dải trên và dải dưới đều
    # sạch artwork, nên mực đo được ở đó chỉ có thể là report.
    result, _, _ = _render_with_report(
        workdir,
        quantity=1,
        report_overrides={
            "placement": {
                "position": position,
                "centered": True,
                "offsetXmm": 5.0,
                "offsetYmm": 5.0,
                "fontSizePt": 10.0,
            }
        },
    )

    array, scale = _render_gray(result.output_path, 0)
    cao = int(12.0 * PT_PER_MM * scale)
    dai_tren = array[:cao, :]
    dai_duoi = array[-cao:, :]
    if position == "top":
        assert int(dai_tren.min()) < 128
        assert int(dai_duoi.min()) > 200
    else:
        assert int(dai_duoi.min()) < 128
        assert int(dai_tren.min()) > 200


def test_report_tat_thi_khong_co_chu_nao(workdir: Path) -> None:
    """Giữ nguyên hành vi cũ khi report tắt."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = {"exportUniqueSheets": True, "report": {"enabled": False}}
    result, _, _ = _render(
        workdir, poses=[_pose(60.0, 60.0)], bundle=bundle, quantity=1
    )

    array, scale = _render_gray(result.output_path, 0)
    dai = array[: int(12.0 * PT_PER_MM * scale), :]
    assert int(dai.min()) > 200


def test_report_co_mat_tren_moi_to(workdir: Path) -> None:
    """Khi xuất đủ tờ vật lý, mọi trang in đều có report, không chỉ tờ đầu."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = _report_options()
    bundle["artifactOptions"]["exportUniqueSheets"] = False
    result, _, _ = _render(
        workdir,
        poses=[_pose(10.0, 10.0), _pose(10.0, 10.0)],
        sheet_indices=[0, 1],
        bundle=bundle,
        quantity=2,
    )

    assert result.sheet_count == 2
    for page in result.pages:
        if page.side == "cut":
            continue
        array, scale = _render_gray(result.output_path, page.page_index)
        dai = array[: int(12.0 * PT_PER_MM * scale), :]
        assert int(dai.min()) < 128, f"trang {page.page_index} thiếu report"


def test_export_unique_sheets_giu_recipe_cuoi_va_dem_run_rieng(
    workdir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hai tờ đầy cùng recipe gộp một template; tờ cuối khác layout vẫn phải xuất."""

    from app.workers import nup_report

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = _report_options(
        fields=["labelsPerSheet", "actualQty", "sheetCount"]
    )
    captured: dict[int, str] = {}

    def fake_stamp(_input, _output, reports_by_page, **_kwargs):
        captured.update(reports_by_page)
        return True

    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", fake_stamp)
    result, _, _ = _render(
        workdir,
        # Sheet 0 và 1 cùng multiset nhưng khác instanceId lẫn thứ tự; sheet 2
        # thiếu một cell nên là recipe riêng và không được mất.
        poses=[
            _pose(10.0, 10.0),
            _pose(60.0, 10.0),
            _pose(60.0, 10.0),
            _pose(10.0, 10.0),
            _pose(10.0, 10.0),
        ],
        sheet_indices=[0, 0, 1, 1, 2],
        bundle=bundle,
        quantity=5,
    )

    # FIX/PARITY (audit 2026-08-29 §MAP-NEST-09): giữ representative đầu
    # tiên của từng recipe vật lý và luôn xuất trọn bộ side của representative.
    assert result.sheet_count == 3
    assert result.page_count == 4
    assert [(page.sheet_index, page.side) for page in result.pages] == [
        (0, "front"),
        (0, "cut"),
        (2, "front"),
        (2, "cut"),
    ]
    assert result.pages[0].instance_ids == ("tem#0001", "tem#0002")
    assert result.pages[2].instance_ids == ("tem#0005",)
    assert captured == {
        0: "SL/tờ: 2 - SL thực: 5 - Số tờ: 2",
        2: "SL/tờ: 1 - SL thực: 5 - Số tờ: 1",
    }
    with pikepdf.Pdf.open(str(result.output_path)) as pdf:
        assert len(pdf.pages) == 4


def test_export_unique_sheets_false_xuat_du_moi_to_vat_ly(workdir: Path) -> None:
    """Tắt dedup phải giữ nguyên ba tờ vật lý dù hai tờ đầu cùng recipe."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"]["exportUniqueSheets"] = False
    result, _, _ = _render(
        workdir,
        poses=[
            _pose(10.0, 10.0),
            _pose(60.0, 10.0),
            _pose(10.0, 10.0),
            _pose(60.0, 10.0),
            _pose(10.0, 10.0),
        ],
        sheet_indices=[0, 0, 1, 1, 2],
        bundle=bundle,
        quantity=5,
    )

    assert result.sheet_count == 3
    assert result.page_count == 6
    assert [(page.sheet_index, page.side) for page in result.pages] == [
        (0, "front"),
        (0, "cut"),
        (1, "front"),
        (1, "cut"),
        (2, "front"),
        (2, "cut"),
    ]


def test_export_unique_sheets_cung_so_cell_nhung_khac_pose_van_xuat(
    workdir: Path,
) -> None:
    """Recipe không được suy chỉ từ số cell; đổi exact pose phải tạo template khác."""

    result, _, _ = _render(
        workdir,
        poses=[
            _pose(10.0, 10.0),
            _pose(60.0000001, 10.0),
            _pose(10.0, 10.0),
            _pose(60.0000002, 10.0),
        ],
        sheet_indices=[0, 0, 1, 1],
        quantity=4,
    )

    assert result.sheet_count == 2
    assert [(page.sheet_index, page.side) for page in result.pages] == [
        (0, "front"),
        (0, "cut"),
        (1, "front"),
        (1, "cut"),
    ]


def test_export_unique_sheets_duplicate_pose_malformed_fail_closed(
    workdir: Path,
) -> None:
    """Occurrence bị dedup vẫn phải qua exact pose parser và không được tạo file."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    production = _production(source, quantity=2)
    manifest = _manifest(
        production,
        poses=[_pose(60.0, 60.0), _pose(60.0, 60.0)],
        sheet_indices=[0, 1],
    )
    manifest["placements"][1]["pose"]["scale"] = 2.0
    output = workdir / "duplicate-pose-malformed.pdf"

    with pytest.raises(ManifestRenderContractError, match="pose"):
        render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": production.render_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=manifest,
            source_paths={LOCATOR: source},
            output_path=output,
        )
    assert not output.exists()


def test_export_unique_sheets_flag_sai_kieu_fail_closed(workdir: Path) -> None:
    """Writer không được truthy-coerce cờ artifact đã lệch contract."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    production = _production(source, quantity=1)
    manifest = _manifest(production, poses=[_pose(60.0, 60.0)])
    malformed_bundle = copy.deepcopy(production.render_bundle)
    malformed_bundle["artifactOptions"]["exportUniqueSheets"] = "true"
    output = workdir / "unique-flag-malformed.pdf"

    with pytest.raises(ManifestRenderContractError, match="exportUniqueSheets"):
        render_production_nesting(
            production_request={
                "engineRequest": production.engine_request,
                "renderBundle": malformed_bundle,
                "renderBundleHash": production.render_bundle_hash,
            },
            manifest=manifest,
            source_paths={LOCATOR: source},
            output_path=output,
        )
    assert not output.exists()


def test_export_unique_sheets_duplex_giu_nguyen_bo_side(workdir: Path) -> None:
    """Hai tờ CNC cùng recipe phải thành đúng một bộ Front/Back/CUT nguyên tử."""

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source, page_count=2)
    bundle = _bundle_cnc_duplex_with_pont(source, flip_edge="long")
    production = _production(source, bundle=bundle, quantity=2)
    manifest = _manifest(
        production,
        poses=[_pose(60.0, 60.0), _pose(60.0, 60.0)],
        sheet_indices=[0, 1],
    )
    output = workdir / "unique-duplex.pdf"

    result = render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=manifest,
        source_paths={LOCATOR: source},
        output_path=output,
    )

    assert result.sheet_count == 2
    assert [(page.sheet_index, page.side) for page in result.pages] == [
        (0, "front"),
        (0, "back"),
        (0, "cut"),
    ]
    assert all(page.instance_ids == ("tem#0001",) for page in result.pages)
    with pikepdf.Pdf.open(str(output)) as pdf:
        assert len(pdf.pages) == 3


def test_report_theo_physical_sheet_duplex_va_khong_stamp_cut(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tờ [3,1] có text riêng; Front/Back cùng tờ giống nhau, CUT không có report."""

    from app.workers import nup_report
    from app.workers.nesting_imposition_render import (
        RenderedProductionSheet,
        _stamp_report,
    )

    report = _report_options(
        fields=["labelsPerSheet", "actualQty", "sheetCount"]
    )["report"]
    placements = [
        {"partId": "tem", "sheetIndex": sheet_index}
        for sheet_index in (0, 0, 0, 1)
    ]
    manifest = {
        "placements": placements,
        "stats": {"placedCount": 4, "sheetCount": 2},
    }
    engine_request = {
        "layoutIntent": "quantity_fulfillment",
        "sheet": {"widthMm": SHEET_W_MM, "heightMm": SHEET_H_MM},
        "parts": [{"partId": "tem", "quantity": 4}],
    }
    rendered = tuple(
        RenderedProductionSheet(
            page_index=page_index,
            sheet_index=sheet_index,
            side=side,
            instance_ids=(),
        )
        for page_index, (sheet_index, side) in enumerate(
            (
                (0, "front"),
                (0, "back"),
                (0, "cut"),
                (1, "front"),
                (1, "back"),
                (1, "cut"),
            )
        )
    )
    captured: dict[int, str] = {}

    def fake_stamp(_input, _output, reports_by_page, **_kwargs):
        captured.update(reports_by_page)
        return True

    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", fake_stamp)
    _stamp_report(
        tmp_path / "physical-sheet.pdf",
        report=report,
        rendered_pages=rendered,
        manifest=manifest,
        engine_request=engine_request,
        parts={"tem": {}},
        sheet_count=2,
    )

    assert set(captured) == {0, 1, 3, 4}
    assert captured[0] == captured[1]
    assert captured[3] == captured[4]
    assert captured[0] == "SL/tờ: 3 - SL thực: 4 - Số tờ: 2"
    assert captured[3] == "SL/tờ: 1 - SL thực: 4 - Số tờ: 2"
    assert all("SL thực: 6" not in text for text in captured.values())


def test_report_sr_dung_demand_rieng_khong_dua_vao_solver() -> None:
    """S&R target 7, sức chứa 3 ⇒ chạy 3 tờ, thành phẩm thực 9."""

    from app.workers.nesting_imposition_render import _report_text

    report = _report_options(
        fields=["labelsPerSheet", "actualQty", "sheetCount"],
        requestedQty=7,
    )["report"]
    manifest = {
        "placements": [
            {"partId": "tem", "sheetIndex": 0},
            {"partId": "tem", "sheetIndex": 0},
            {"partId": "tem", "sheetIndex": 0},
        ],
        "stats": {"placedCount": 3, "sheetCount": 1},
    }
    engine_request = {
        "layoutIntent": "step_repeat_single_sheet",
        "sheet": {"widthMm": SHEET_W_MM, "heightMm": SHEET_H_MM},
        # Invariant solver S&R: part không có quantity.
        "parts": [{"partId": "tem"}],
    }

    text = _report_text(
        report,
        manifest=manifest,
        engine_request=engine_request,
        parts={"tem": {}},
        sheet_index=0,
        sheet_count=1,
    )
    assert text == "SL/tờ: 3 - SL thực: 9 - Số tờ: 3"

    report["requestedQty"] = None
    autofill_text = _report_text(
        report,
        manifest=manifest,
        engine_request=engine_request,
        parts={"tem": {}},
        sheet_index=0,
        sheet_count=1,
    )
    assert autofill_text == "SL/tờ: 3 - SL thực: 3 - Số tờ: 1"


def test_report_dung_builder_chuoi_cua_lane_luoi(workdir: Path) -> None:
    """Writer tự tính quantity nhưng vẫn dùng chung builder thứ tự/bỏ dấu với lane lưới."""

    from app.workers import nup_report
    from app.workers.nesting_imposition_render import _report_text

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    options = _report_options(fields=["labelsPerSheet", "sheetCount", "actualQty"])
    bundle["artifactOptions"] = options
    _, production, manifest = _render(
        workdir, poses=[_pose(10.0, 10.0), _pose(60.0, 60.0)], bundle=bundle, quantity=2
    )

    text = _report_text(
        options["report"],
        manifest=manifest,
        engine_request=production.engine_request,
        parts={"tem": {}},
        sheet_index=0,
        sheet_count=1,
    )

    ky_vong = nup_report.build_report_string(
        {"fieldOrder": ["labelsPerSheet", "sheetCount", "actualQty"]},
        {
            "labelsPerSheet": "SL/tờ: 2",
            "sheetCount": "Số tờ: 1",
            "actualQty": "SL thực: 2",
        },
    )
    assert text == ky_vong
    assert "SL/tờ: 2" in text


def test_stamp_that_bai_thi_bo_file_khong_giao_to_thieu_report(workdir: Path) -> None:
    """Không được lặp lại chính lỗi đang sửa dưới dạng "ghi được file nhưng thiếu chữ"."""

    import app.workers.nup_report as nup_report

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    bundle["artifactOptions"] = _report_options()

    goc = nup_report.stamp_reports_on_pdf
    nup_report.stamp_reports_on_pdf = lambda *a, **k: False
    try:
        with pytest.raises(ManifestRenderContractError, match="report"):
            _render(workdir, poses=[_pose(60.0, 60.0)], bundle=bundle, quantity=1)
    finally:
        nup_report.stamp_reports_on_pdf = goc

    assert not (workdir / "ket_qua.pdf").exists(), "phải xoá artifact khi report lỗi"


def test_report_bo_dau_khi_duoc_yeu_cau(workdir: Path) -> None:
    """`removeDiacritics` trước đây không được map nên luôn là False."""

    from app.workers.nesting_imposition_render import _report_text

    source = workdir / "nguon.pdf"
    _make_full_ink_source(source)
    bundle = _bundle(source)
    options = _report_options(removeDiacritics=True)
    bundle["artifactOptions"] = options
    _, production, manifest = _render(
        workdir, poses=[_pose(60.0, 60.0)], bundle=bundle, quantity=1
    )

    text = _report_text(
        options["report"],
        manifest=manifest,
        engine_request=production.engine_request,
        parts={"tem": {}},
        sheet_index=0,
        sheet_count=1,
    )

    assert "tờ" not in text and "to" in text.lower()


# ── MAP-NEST-06: metadata report per-sheet cho true-shape ──
def _single_mold_parts() -> dict:
    """Part V2: report phải dùng kích thước detector, không đo lại bbox contour.

    Regression số thật từ runtime: viewer/``DetectedShape.trim`` là 45,3×52,3mm,
    còn bbox ``cutContour`` là 45,4×52,9mm. ``trimBox`` 120×80mm tiếp tục khóa
    việc không được nhầm kích thước khuôn với khổ trang nguồn.
    """

    return {
        "trang-3": {
            "dieDimensionsMm": {"width": 45.3, "height": 52.3},
            "pages": {
                "front": {
                    "pageIndex": 2,
                    "pageBoxesMm": {"trimBox": [0.0, 0.0, 120.0, 80.0]},
                },
            },
            "cutContour": {
                "outer": [
                    [0.0, 0.0],
                    [45.4, 0.0],
                    [45.4, 52.9],
                    [0.0, 52.9],
                ],
                "holes": [],
            },
        },
    }


def test_report_to_mot_mau_co_kich_thuoc_so_trang_va_mode_label() -> None:
    """MAP-NEST-06: tờ một mẫu điền dimensions/identifier/modeLabel + labelName fallback."""

    from app.workers.nesting_imposition_render import _report_text

    report = _report_options(
        fields=["identifier", "labelName", "dimensions", "modeLabel"],
    )["report"]
    manifest = {
        "placements": [{"partId": "trang-3", "sheetIndex": 0}],
        "stats": {"placedCount": 1, "sheetCount": 1},
    }
    engine_request = {
        "layoutIntent": "autofill_single_sheet",
        "sheet": {"widthMm": SHEET_W_MM, "heightMm": SHEET_H_MM},
        "parts": [{"partId": "trang-3"}],
    }

    text = _report_text(
        report,
        manifest=manifest,
        engine_request=engine_request,
        parts=_single_mold_parts(),
        sheet_index=0,
        sheet_count=1,
        tool="sticker_imposer",
    )
    assert text == "3 - Trang 3 - 45.3 x 52.3 mm - Bế tem"


def test_report_label_name_tuong_minh_khong_bi_fallback_ghi_de() -> None:
    """labelName người dùng nhập luôn thắng fallback ``Trang N``."""

    from app.workers.nesting_imposition_render import _report_text

    report = _report_options(fields=["labelName"], labelName="Tem ABC")["report"]
    manifest = {
        "placements": [{"partId": "trang-3", "sheetIndex": 0}],
        "stats": {"placedCount": 1, "sheetCount": 1},
    }
    engine_request = {
        "layoutIntent": "autofill_single_sheet",
        "sheet": {"widthMm": SHEET_W_MM, "heightMm": SHEET_H_MM},
        "parts": [{"partId": "trang-3"}],
    }

    text = _report_text(
        report,
        manifest=manifest,
        engine_request=engine_request,
        parts=_single_mold_parts(),
        sheet_index=0,
        sheet_count=1,
        tool="sticker_imposer",
    )
    assert text == "Tem ABC"


def test_report_to_gang_nhieu_mau_de_trong_kich_thuoc_va_identifier() -> None:
    """MAP-NEST-06: tờ gang không suy kích thước/số trang đơn; số mẫu do gangCount."""

    from app.workers.nesting_imposition_render import _report_text

    report = _report_options(
        fields=["gangCount", "identifier", "dimensions", "modeLabel"],
    )["report"]
    manifest = {
        "placements": [
            {"partId": "trang-1", "sheetIndex": 0},
            {"partId": "trang-2", "sheetIndex": 0},
        ],
        "stats": {"placedCount": 2, "sheetCount": 1},
    }
    engine_request = {
        "layoutIntent": "autofill_single_sheet",
        "sheet": {"widthMm": SHEET_W_MM, "heightMm": SHEET_H_MM},
        "parts": [{"partId": "trang-1"}, {"partId": "trang-2"}],
    }
    parts = {
        "trang-1": {
            "pages": {
                "front": {
                    "pageIndex": 0,
                    "pageBoxesMm": {"trimBox": [0.0, 0.0, 90.0, 55.0]},
                }
            }
        },
        "trang-2": {
            "pages": {
                "front": {
                    "pageIndex": 1,
                    "pageBoxesMm": {"trimBox": [0.0, 0.0, 50.0, 50.0]},
                }
            }
        },
    }

    text = _report_text(
        report,
        manifest=manifest,
        engine_request=engine_request,
        parts=parts,
        sheet_index=0,
        sheet_count=1,
        tool="cnc_imposer",
    )
    assert text == "2 mẫu - Bình bế rớt CNC"

"""Contract regression cho adapter + manifest lifecycle nesting production."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import multiprocessing
import os
from dataclasses import replace
from pathlib import Path

import pytest

from app.core import mixed_nesting_service as mixed_nesting_service_module
from app.core import nesting_manifest_store as nesting_manifest_store_module
from app.core import (
    nesting_production_orchestrator as nesting_production_orchestrator_module,
)
from app.core.mixed_nesting_service import (
    EngineCapabilities,
    EngineUnavailableError,
    MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
    MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
    MIXED_NESTING_PROTOCOL_VERSION,
    PRODUCTION_ALGORITHM_VERSION_KEYS,
    MixedNestingError,
    MixedNestingRunHandle,
    validate_production_manifest,
)
from app.core.nesting_manifest_store import (
    ManifestConflictError,
    ManifestContractError,
    ManifestFingerprintMismatchError,
    ManifestIdentifierError,
    ManifestIntegrityError,
    NestingManifestStore,
    canonical_json_bytes as store_canonical_json_bytes,
)
from app.core.nesting_source_pin import (
    PinnedNestingSource,
    ResolvedPinnedSource,
    discard_source_pin,
    promote_source_pin,
)
from app.core.nesting_production_adapter import (
    ProductionAdapterError,
    ProductionNestingRequest,
    build_production_request,
    canonical_sha256,
    validate_production_request_identity,
)
from app.core.nesting_production_orchestrator import (
    ProductionNestingInput,
    create_production_commit_fence,
    persist_production_nesting,
    solve_production_nesting,
)


JOB_ID = "0123456789abcdef0123456789abcdef"
BUILD_IDENTITY = "1" * 64

_REAL_PROMOTE_SOURCE_PIN = nesting_manifest_store_module.promote_source_pin
_REAL_RESOLVE_FINAL_SOURCE = nesting_manifest_store_module.resolve_final_source
_REAL_VERIFY_SOURCE_PIN = nesting_manifest_store_module.verify_source_pin
_STRICT_MANIFEST_PERSIST = NestingManifestStore.persist


def _versions() -> dict[str, int | str]:
    return {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "engineVersion": "mixed-nesting-core-v2",
        "validatorVersion": 9,
        "toleranceVersion": 2,
        "canonicalizationVersion": 3,
        "productionSchemaVersion": MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        "normalizeRuleVersion": 4,
        "referencePointRuleVersion": 2,
        "kernelVersion": 6,
        "nfpRuleVersion": 3,
        "scoreVersion": 5,
        "solverVersion": 7,
        "multiStartVersion": 3,
        "baselineVersion": 4,
        "candidateRuleVersion": 8,
        "refineRuleVersion": 2,
    }


def _capabilities(
    *, complete: bool = True, build_identity: str | None = BUILD_IDENTITY
) -> EngineCapabilities:
    versions = _versions()
    if not complete:
        versions.pop("solverVersion")
    return EngineCapabilities(
        protocol_version=MIXED_NESTING_PROTOCOL_VERSION,
        engine_version="mixed-nesting-core-v2",
        reflection="forbidden",
        default_rotation="free",
        continuous_translation=True,
        profiles=("fast", "balanced", "tight"),
        layout_intents=("quantity_fulfillment", "autofill_single_sheet"),
        native_build_identity=build_identity,
        manifest_schema_version=MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
        algorithm_versions=tuple(sorted(versions.items())),
    )


def _fake_source_pins(
    production: ProductionNestingRequest,
) -> tuple[PinnedNestingSource, ...]:
    """Pin giả chỉ dành cho unit contract; E2E source lifecycle dùng PDF thật."""

    descriptors: dict[str, dict] = {}
    for part in production.render_bundle.get("parts", []):
        source = part["source"]
        descriptors.setdefault(source["locatorId"], source)
    return tuple(
        PinnedNestingSource(
            locator_id=locator_id,
            content_hash=source["contentHash"],
            byte_size=source["byteSize"],
            page_count=source["pageCount"],
            revision=source["revision"],
            pages=(),
            snapshot_path=Path(f"C:/prynx-test-source/{locator_id}.pdf"),
            lease_token=("a" if offset % 2 == 0 else "b") * 64,
        )
        for offset, (locator_id, source) in enumerate(sorted(descriptors.items()))
    )


def _persist(
    store: NestingManifestStore,
    *,
    production_request: ProductionNestingRequest,
    manifest: dict,
    source_pins: tuple[PinnedNestingSource, ...] | None = None,
):
    return _STRICT_MANIFEST_PERSIST(
        store,
        production_request=production_request,
        manifest=manifest,
        source_pins=(
            _fake_source_pins(production_request)
            if source_pins is None
            else source_pins
        ),
    )


def _fake_resolve_final_source(
    locator_id,
    expected_hash,
    expected_byte_size,
    expected_page_count,
    expected_pages,
    *,
    renew=True,
):
    del expected_pages, renew
    return ResolvedPinnedSource(
        locator_id=locator_id,
        content_hash=expected_hash,
        byte_size=expected_byte_size,
        page_count=expected_page_count,
        revision=expected_hash,
        pages=(),
        path=Path(f"C:/prynx-test-source/{locator_id}.pdf"),
    )


@pytest.fixture(autouse=True)
def _fake_native_revalidation(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fixture schema không giả solver; chỉ thay biên native chưa rebuild của test."""

    monkeypatch.setattr(
        mixed_nesting_service_module,
        "_validate_manifest_with_native",
        lambda _request, _manifest: None,
    )
    monkeypatch.setattr(
        nesting_manifest_store_module, "engine_capabilities", _capabilities
    )
    monkeypatch.setattr(
        nesting_manifest_store_module, "verify_source_pin", lambda *_args: None
    )
    monkeypatch.setattr(
        nesting_manifest_store_module, "promote_source_pin", lambda _pin: True
    )
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "resolve_final_source",
        _fake_resolve_final_source,
    )



def _public_request() -> dict:
    return {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 42,
        "profile": "balanced",
        "sheet": {
            "widthMm": 320.0,
            "heightMm": 450.0,
            "marginMm": {"left": 5.0, "right": 5.0, "top": 7.0, "bottom": 7.0},
            "maxSheets": 12,
        },
        "gapMm": 4.0,
        "layoutIntent": "quantity_fulfillment",
        "orientationPolicy": {
            "defaultRotation": {"mode": "fixed", "angleDeg": 90.0},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": "tem-b",
                "quantity": 2,
                "outer": [[25.0, 10.0], [25.0, 30.0], [5.0, 30.0], [5.0, 10.0]],
                "holes": [],
                "rotationConstraint": {"mode": "fixed", "angleDeg": 13.0},
            },
            {
                "partId": "tem-a",
                "quantity": 3,
                "outer": [[0.0, 0.0], [40.0, 0.0], [40.0, 20.0], [0.0, 20.0]],
                "holes": [],
            },
        ],
    }


def _clearance() -> dict:
    return {
        "partToPart": {"xMm": 2.0, "yMm": 3.0},
        "partToSheetEdge": {"xMm": 1.0, "yMm": 1.5},
        "partToObstacle": {"xMm": 4.0, "yMm": 5.0},
    }


def _polygon(outer: list[list[float]]) -> dict:
    return {"outer": copy.deepcopy(outer), "holes": []}


def _page_binding(
    page_index: int,
    *,
    rotate_deg: int = 0,
    transform: list[float] | None = None,
) -> dict:
    return {
        "pageIndex": page_index,
        "pageBoxesMm": {
            "mediaBox": [0.0, 0.0, 210.0, 297.0],
            "cropBox": [0.0, 0.0, 210.0, 297.0],
            "trimBox": [5.0, 5.0, 205.0, 292.0],
        },
        "userUnit": 1.0,
        "rotateDeg": rotate_deg,
        "sourcePageToCanonical": (
            transform
            if transform is not None
            else [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        ),
    }


def _cut_style() -> dict:
    """cutStyle canonical mặc định: nét bế nhận theo kênh spot ``cutcontour``."""

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
            "widthMm": 0.25,
            "colorSpace": "cmyk",
            "components": [0.0, 1.0, 0.0, 0.0],
            "separationName": None,
            # NEST §A3.1: alternate chỉ có nghĩa với separation, nhưng contract
            # dùng exact-fields nên phải khai tường minh là null.
            "alternate": None,
            "overprint": False,
        },
    }


def _bundle() -> dict:
    outer_a = [[0.0, 0.0], [40.0, 0.0], [40.0, 20.0], [0.0, 20.0]]
    outer_b = [[25.0, 10.0], [25.0, 30.0], [5.0, 30.0], [5.0, 10.0]]
    hash_a = "sha256:" + "a" * 64
    hash_b = "sha256:" + "b" * 64
    return {
        "schemaVersion": 2,
        "flow": {
            "tool": "cnc_imposer",
            "taskMode": "nup",
            "layoutIntent": "quantity_fulfillment",
        },
        "outputSides": ["front", "back", "cut"],
        "duplex": {
            "mode": "duplex",
            "flipEdge": "long",
            "physicalAxis": "x",
        },
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
            "duplexRegistration": True,
        },
        "artifactOptions": {
            "exportUniqueSheets": True,
            "report": {"enabled": False},
        },
        "sheetFrames": {
            "front": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            "back": [-1.0, 0.0, 0.0, 1.0, 320.0, 0.0],
            "cut": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        },
        "renderer": {
            "identity": "cnc_imposer_pdf",
            "version": "cnc-affine-v1",
        },
        "cutStyle": _cut_style(),
        "parts": [
            {
                "partId": "tem-b",
                "packingFootprint": _polygon(outer_b),
                "cutContour": _polygon(outer_b),
                "artworkClipPath": _polygon(outer_b),
                "source": {
                    "locatorId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "contentHash": hash_b,
                    "byteSize": 2000,
                    "pageCount": 16,
                    "revision": hash_b,
                },
                "pages": {
                    "front": _page_binding(
                        1,
                        rotate_deg=90,
                        transform=[0.0, -1.0, 1.0, 0.0, 0.0, 210.0],
                    ),
                    "back": _page_binding(2),
                    "cut": _page_binding(3),
                },
            },
            {
                "partId": "tem-a",
                "packingFootprint": _polygon(outer_a),
                "cutContour": _polygon(outer_a),
                "artworkClipPath": _polygon(outer_a),
                "source": {
                    "locatorId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "contentHash": hash_a,
                    "byteSize": 1000,
                    "pageCount": 16,
                    "revision": hash_a,
                },
                "pages": {
                    "front": _page_binding(0),
                    "back": _page_binding(1),
                    "cut": _page_binding(4),
                },
            },
        ],
    }


def _enabled_artifact_options(
    *, fields: list[str] | None = None
) -> dict:
    return {
        "exportUniqueSheets": True,
        "report": {
            "enabled": True,
            "fields": fields or [
                "orderCode",
                "labelName",
                "material",
                "lamination",
                "labelsPerSheet",
            ],
            "requestedQty": None,
            "labelName": "Tem nhãn",
            "material": "Decal PP",
            "lamination": {"type": "matte", "sides": 2},
            "orderCode": "DH-001",
            "customText": "Ca đêm",
            "removeDiacritics": False,
            "placement": {
                "position": "top",
                "centered": True,
                "offsetXmm": 0.0,
                "offsetYmm": 5.0,
                "fontSizePt": 8.0,
            },
        },
    }

def _build(**overrides):
    values = {
        "public_request": _public_request(),
        "job_id": JOB_ID,
        "request_revision": 3,
        "render_bundle": _bundle(),
        "clearance": _clearance(),
        "fixed_obstacles": [
            {
                "obstacleId": "boong-1",
                "kind": "gripper",
                "outer": [[0.0, 0.0], [320.0, 0.0], [320.0, 8.0], [0.0, 8.0]],
            }
        ],
        "algorithm_versions": _versions(),
        "native_build_identity": BUILD_IDENTITY,
    }
    values.update(overrides)
    return build_production_request(**values)


def _maximize_area_zones() -> list[dict]:
    """Hai dải ngang phủ đúng usable sheet 310 × 436 mm."""

    return [
        {
            "partId": "tem-b",
            "bounds": {
                "minXmm": 5.0,
                "minYmm": 225.0,
                "maxXmm": 315.0,
                "maxYmm": 443.0,
            },
        },
        {
            "partId": "tem-a",
            "bounds": {
                "minXmm": 5.0,
                "minYmm": 7.0,
                "maxXmm": 315.0,
                "maxYmm": 225.0,
            },
        },
    ]


def _build_autofill() -> ProductionNestingRequest:
    request = _public_request()
    request["layoutIntent"] = "autofill_single_sheet"
    request["sheet"]["maxSheets"] = 1
    for part in request["parts"]:
        part.pop("quantity")
    bundle = _bundle()
    bundle["flow"]["layoutIntent"] = "autofill_single_sheet"
    return _build(public_request=request, render_bundle=bundle)


def _manifest(
    production: ProductionNestingRequest, *, pose_delta: float = 0.0
) -> dict:
    request = production.engine_request
    contract = request["productionContract"]
    versions = _versions()
    placements: list[dict] = []
    ordinal = 0
    for part in request["parts"]:
        for part_ordinal in range(1, part.get("quantity", 1) + 1):
            placements.append(
                {
                    "instanceId": f"{part['partId']}#{part_ordinal:04d}",
                    "partId": part["partId"],
                    "sheetIndex": 0,
                    "pose": {
                        "rotationDeg": 17.0 + ordinal,
                        "translateXmm": 30.0 + ordinal * 45.0,
                        "translateYmm": 40.0 + pose_delta,
                    },
                    "sourceRevision": part["sourceRevision"],
                }
            )
            ordinal += 1
    selected_score = {
        "invalidCount": 0,
        "primaryPenalty": 0,
        "sheetCount": 1,
        "lastSheetUsedAreaFixed": 1,
        "wastedWithinEnvelopeFixed": 1,
        "scoreVersion": versions["scoreVersion"],
    }
    return {
        "schemaVersion": MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
        "manifestId": request["jobId"],
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "engineVersion": versions["engineVersion"],
        "jobId": request["jobId"],
        "requestRevision": contract["requestRevision"],
        "inputHash": contract["inputHash"],
        "layoutFingerprint": contract["layoutFingerprint"],
        "layoutIntent": request["layoutIntent"],
        "seed": request["seed"],
        "status": "completed",
        "validation": {
            "valid": True,
            "validatorVersion": versions["validatorVersion"],
        },
        "provenance": {
            "nativeBuildIdentity": production.native_build_identity,
            **{
                key: value
                for key, value in versions.items()
                if key
                not in {"protocolVersion", "engineVersion", "validatorVersion"}
            },
        },
        "placements": placements,
        "unplaced": [],
        "stats": {
            "sheetCount": 1,
            "placedCount": len(placements),
            "unplacedCount": 0,
            "materialUtilization": 0.1,
            "elapsedMs": 10,
            "attempts": len(placements),
            "orientationEvaluations": len(placements),
            "poseRefinements": 0,
            "terminationReason": (
                "all_placed"
                if request["layoutIntent"] == "quantity_fulfillment"
                else "sheet_full"
            ),
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
            "baselineScore": copy.deepcopy(selected_score),
            "selectedScore": selected_score,
        },
    }


def _race_store_worker(
    root: str,
    barrier,
    result_queue,

    pose_delta: float,
) -> None:
    """Worker top-level để Windows spawn kiểm race publish đa tiến trình."""

    # Windows ``spawn`` không kế thừa monkeypatch fixture của process cha.
    mixed_nesting_service_module._validate_manifest_with_native = (
        lambda _request, _manifest: None
    )
    nesting_manifest_store_module.engine_capabilities = _capabilities
    nesting_manifest_store_module.verify_source_pin = lambda *_args: None
    nesting_manifest_store_module.promote_source_pin = lambda _pin: True
    nesting_manifest_store_module.resolve_final_source = _fake_resolve_final_source

    try:
        production = _build()
        manifest = _manifest(production, pose_delta=pose_delta)
        barrier.wait(timeout=20)
        stored = _persist(
            NestingManifestStore(root=Path(root)),
            production_request=production,
            manifest=manifest,
        )
        result_queue.put(
            (
                "stored",
                stored.manifest["placements"][0]["pose"]["translateYmm"],
            )
        )
    except ManifestConflictError:
        result_queue.put(("conflict", pose_delta))
    except BaseException as exc:  # noqa: BLE001 - chuyển lỗi process về parent
        result_queue.put(("error", f"{type(exc).__name__}: {exc}"))


def _race_source_lease_worker(
    uploads_root: str,
    results_root: str,
    snapshot_path: str,
    locator_id: str,
    barrier,
    result_queue,
) -> None:
    """Worker spawn kiểm marker locator no-replace xuyên process."""

    from app.core import artifact_lease

    artifact_lease.settings.UPLOAD_DIR = uploads_root
    artifact_lease.settings.RESULTS_DIR = results_root
    try:
        barrier.wait(timeout=20)
        token = artifact_lease.create_artifact_lease(
            "nesting_source",
            snapshot_path,
            locator_id=locator_id,
        )
        result_queue.put(("stored", token))
    except ValueError:
        result_queue.put(("conflict", None))
    except BaseException as exc:  # noqa: BLE001 - chuyển lỗi process về parent
        result_queue.put(("error", f"{type(exc).__name__}: {exc}"))


@pytest.mark.parametrize(
    "rotate_deg,expected_source_affine",
    [
        (0, [1.0, 0.0, 0.0, 1.0, -7.055556, -14.111111]),
        (90, [0.0, -1.0, 1.0, 0.0, -14.111111, 148.166667]),
        (180, [-1.0, 0.0, 0.0, -1.0, 148.166667, 84.666667]),
        (270, [0.0, 1.0, -1.0, 0.0, 84.666667, -7.055556]),
    ],
)
def test_source_pin_snapshot_doc_lap_metadata_va_stale_409(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rotate_deg: int,
    expected_source_affine: list[float],
) -> None:
    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_source_pin import (
        discard_source_pin,
        pin_uploaded_pdf,
        source_descriptor,
        verify_source_pin,
    )

    uploads = tmp_path / "uploads"
    results = tmp_path / "results"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "original.pdf"
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200.0, 100.0))
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(
        [10.0, 20.0, 210.0, 120.0]
    )
    page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array(
        [20.0, 30.0, 200.0, 110.0]
    )
    page.obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(
        [25.0, 35.0, 195.0, 105.0]
    )
    page.obj[pikepdf.Name("/UserUnit")] = 2.0
    page.obj[pikepdf.Name("/Rotate")] = rotate_deg
    pdf.save(original)
    pdf.close()

    class FakeSession:
        def query(self, _model):
            return self

        def filter(self, _condition):
            return self

        def first(self):
            return type("Uploaded", (), {"file_path": str(original)})()

        def close(self):
            return None

    pin = pin_uploaded_pdf(
        "11111111-1111-4111-8111-111111111111",
        session_factory=FakeSession,
    )
    assert pin.snapshot_path.is_file()
    assert not pin.snapshot_path.samefile(original)
    assert pin.revision == pin.content_hash
    assert pin.page_count == 1
    assert source_descriptor(pin) == {
        "locatorId": pin.locator_id,
        "contentHash": pin.content_hash,
        "byteSize": pin.byte_size,
        "pageCount": 1,
        "revision": pin.content_hash,
    }
    metadata = pin.pages[0].to_binding_metadata()
    assert metadata["pageBoxesMm"]["mediaBox"] == pytest.approx(
        [7.055556, 14.111111, 148.166667, 84.666667]
    )
    assert metadata["userUnit"] == 2.0
    assert metadata["rotateDeg"] == rotate_deg
    assert metadata["sourcePageToCanonical"] == pytest.approx(
        expected_source_affine
    )

    descriptor = source_descriptor(pin)
    verify_source_pin(pin, descriptor, [metadata])
    original.write_bytes(b"nguon-goc-da-doi")
    verify_source_pin(pin, descriptor, [metadata])

    bundle = _bundle()
    for part in bundle["parts"]:
        part["source"] = copy.deepcopy(descriptor)
        part["pages"] = {
            side: copy.deepcopy(metadata)
            for side in ("front", "back", "cut")
        }
    production = _build(render_bundle=bundle)
    manifest = _manifest(production)

    # E2E này chủ đích bỏ fake source layer của fixture autouse.
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "verify_source_pin",
        _REAL_VERIFY_SOURCE_PIN,
    )
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "promote_source_pin",
        _REAL_PROMOTE_SOURCE_PIN,
    )
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "resolve_final_source",
        _REAL_RESOLVE_FINAL_SOURCE,
    )

    clean_snapshot = pin.snapshot_path.read_bytes()
    marker = artifact_lease._nesting_source_marker_path(pin.locator_id)
    assert marker is not None
    assert json.loads(marker.read_text(encoding="utf-8"))["phase"] == "provisional"

    # NESTING (audit 2026-08-28 §SOURCE.1): token không được làm confused deputy
    # để promote/discard locator hoặc path khác với snapshot đã verify.
    wrong_locator = replace(
        pin, locator_id="22222222-2222-4222-8222-222222222222"
    )
    assert not promote_source_pin(wrong_locator)
    discard_source_pin(wrong_locator)
    assert pin.snapshot_path.is_file()
    assert marker.is_file()

    wrong_path = uploads / f"nesting_source_{'f' * 32}.pdf"
    wrong_path.write_bytes(clean_snapshot)
    wrong_snapshot = replace(pin, snapshot_path=wrong_path)
    assert not promote_source_pin(wrong_snapshot)
    discard_source_pin(wrong_snapshot)
    assert wrong_path.is_file()
    assert pin.snapshot_path.is_file()
    assert marker.is_file()

    store = NestingManifestStore(root=tmp_path / "manifests-e2e")
    stored = _STRICT_MANIFEST_PERSIST(
        store,
        production_request=production,
        manifest=manifest,
        source_pins=(pin,),
    )
    assert set(stored.resolved_sources) == {pin.locator_id}
    assert stored.resolved_sources[pin.locator_id].path == pin.snapshot_path

    envelope = json.loads(stored.canonical_bytes)
    assert set(envelope) == {
        "storageSchemaVersion",
        "manifestId",
        "layoutFingerprint",
        "contentSha256",
        "manifest",
        "productionRequest",
    }
    persisted_locators = {
        part["source"]["locatorId"]
        for part in envelope["productionRequest"]["renderBundle"]["parts"]
    }
    assert persisted_locators == {pin.locator_id}
    canonical_text = stored.canonical_bytes.decode("utf-8")
    assert "leaseToken" not in canonical_text
    assert "snapshotPath" not in canonical_text
    assert pin.lease_token not in canonical_text
    assert pin.snapshot_path.name not in canonical_text

    # Persist idempotent sau promotion phải dùng lại đúng final source.
    second = _STRICT_MANIFEST_PERSIST(
        store,
        production_request=production,
        manifest=manifest,
        source_pins=(pin,),
    )
    assert second.canonical_bytes == stored.canonical_bytes

    before_renew = json.loads(marker.read_text(encoding="utf-8"))
    future = (
        before_renew["initial_expires_at"]
        - artifact_lease.NESTING_SOURCE_FINAL_IDLE_SECONDS
        + 120.0
    )
    monkeypatch.setattr(artifact_lease.time, "time", lambda: future)

    reopened = NestingManifestStore(root=store.root)
    loaded = reopened.load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    assert loaded.resolved_sources[pin.locator_id].path == pin.snapshot_path
    after_renew = json.loads(marker.read_text(encoding="utf-8"))
    assert (
        after_renew["initial_expires_at"]
        >= before_renew["initial_expires_at"] + 119.0
    )

    with pin.snapshot_path.open("ab") as stream:
        stream.write(b"tamper")
    with pytest.raises(ManifestFingerprintMismatchError) as caught:
        reopened.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )
    assert caught.value.code == "LAYOUT_MANIFEST_STALE"
    assert caught.value.status_code == 409

    pin.snapshot_path.write_bytes(clean_snapshot)
    assert reopened.load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    ).resolved_sources[pin.locator_id].path == pin.snapshot_path

    # Handle provisional cũ không được xóa source final của manifest đã publish.
    discard_source_pin(pin)
    assert pin.snapshot_path.is_file()
    assert marker.is_file()

    # PDF truncate/corrupt phải map thành stale 409, không lọt ValueError thành 500.
    pin.snapshot_path.write_bytes(b"%PDF-1.7\nbroken")
    with pytest.raises(ManifestFingerprintMismatchError) as corrupt:
        reopened.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )
    assert corrupt.value.code == "LAYOUT_MANIFEST_STALE"
    assert corrupt.value.status_code == 409

    pin.snapshot_path.write_bytes(clean_snapshot)
    pin.snapshot_path.unlink()
    with pytest.raises(ManifestFingerprintMismatchError) as missing:
        reopened.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )
    assert missing.value.code == "LAYOUT_MANIFEST_STALE"
    assert missing.value.status_code == 409



def test_pin_pdf_path_dung_chung_snapshot_hash_lease_khong_can_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_source_pin import discard_source_pin, pin_pdf_path
    from app.core.source_revision import capture_source_fingerprint

    uploads = tmp_path / "uploads-path"
    results = tmp_path / "results-path"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    source = tmp_path / "nguon-production.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(source)
    pdf.close()

    fingerprint = capture_source_fingerprint(source.parent / "." / source.name)
    pin = pin_pdf_path(source, expected_fingerprint=fingerprint)
    snapshot = pin.snapshot_path
    assert snapshot.is_file()
    assert not snapshot.samefile(source)
    assert pin.content_hash == pin.revision
    assert pin.page_count == 1

    # Creator còn sở hữu provisional pin nên nhánh chưa persist phải dọn được.
    discard_source_pin(pin)
    assert not snapshot.exists()


def test_source_proof_bo_inspect_lap_nhung_load_van_verify_day_du(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Proof chỉ tái dùng metadata; mỗi chốt vẫn băm và load mới vẫn full inspect."""

    import pikepdf

    from app.core import artifact_lease
    from app.core import nesting_source_pin as source_pin_module
    from app.core.nesting_manifest_store import preflight_production_source_pins
    from app.core.nesting_source_pin import pin_pdf_path, source_descriptor

    uploads = tmp_path / "uploads-proof"
    results = tmp_path / "results-proof"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "proof-source.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    descriptor = source_descriptor(pin)
    metadata = pin.pages[0].to_binding_metadata()
    bundle = _bundle()
    for part in bundle["parts"]:
        part["source"] = copy.deepcopy(descriptor)
        part["pages"] = {
            side: copy.deepcopy(metadata) for side in ("front", "back", "cut")
        }
    production = _build(render_bundle=bundle)
    manifest = _manifest(production)

    monkeypatch.setattr(
        nesting_manifest_store_module, "verify_source_pin", _REAL_VERIFY_SOURCE_PIN
    )
    monkeypatch.setattr(
        nesting_manifest_store_module, "promote_source_pin", _REAL_PROMOTE_SOURCE_PIN
    )
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "resolve_final_source",
        _REAL_RESOLVE_FINAL_SOURCE,
    )

    calls = {"hash": 0, "inspect": 0, "lease_scan": 0}
    real_hash = source_pin_module._hash_file
    real_inspect = source_pin_module._inspect_pdf
    real_lease_scan = source_pin_module.resolve_nesting_source_lease

    def counting_hash(path, **kwargs):
        calls["hash"] += 1
        return real_hash(path, **kwargs)

    def counting_inspect(path):
        calls["inspect"] += 1
        return real_inspect(path)

    def counting_lease_scan(locator_id, **kwargs):
        calls["lease_scan"] += 1
        return real_lease_scan(locator_id, **kwargs)

    monkeypatch.setattr(source_pin_module, "_hash_file", counting_hash)
    monkeypatch.setattr(source_pin_module, "_inspect_pdf", counting_inspect)
    monkeypatch.setattr(
        source_pin_module,
        "resolve_nesting_source_lease",
        counting_lease_scan,
    )

    proofs = preflight_production_source_pins(production, (pin,))
    # Hai SHA-256 kẹp parser: metadata phải thuộc đúng byte stream đã băm,
    # đồng thời bắt tamper cùng size/mtime trong khe hash→inspect.
    # Pin mới mang receipt server-only ngay khi tạo lease; preflight không cần
    # quét locator UUID vừa do chính server sinh.
    assert calls == {"hash": 2, "inspect": 1, "lease_scan": 0}
    assert len(proofs) == 1

    calls.update(hash=0, inspect=0, lease_scan=0)
    store = NestingManifestStore(root=tmp_path / "proof-manifests")
    stored = _STRICT_MANIFEST_PERSIST(
        store,
        production_request=production,
        manifest=manifest,
        source_pins=(pin,),
        source_proofs=proofs,
    )
    # Hai chốt SHA-256: trước promote và sau publish. Không parse lại cùng PDF.
    # Proof mang receipt server-only: hai chốt hash chỉ reread đúng marker token
    # O(1), không quét lại thư mục lease trong cùng transaction.
    assert calls == {"hash": 2, "inspect": 0, "lease_scan": 0}

    calls.update(hash=0, inspect=0, lease_scan=0)
    loaded = NestingManifestStore(root=store.root).load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    assert loaded.canonical_bytes == stored.canonical_bytes
    # Process/load độc lập không được tin proof RAM của transaction cũ.
    assert calls == {"hash": 2, "inspect": 1, "lease_scan": 1}


def test_source_proof_bat_tamper_cung_size_mtime_giua_publish_readback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Đổi byte nhưng giữ size/mtime vẫn phải stale ở chốt SHA-256 sau publish."""

    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_manifest_store import preflight_production_source_pins
    from app.core.nesting_source_pin import pin_pdf_path, source_descriptor

    uploads = tmp_path / "uploads-proof-tamper"
    results = tmp_path / "results-proof-tamper"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "proof-tamper.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    descriptor = source_descriptor(pin)
    metadata = pin.pages[0].to_binding_metadata()
    bundle = _bundle()
    for part in bundle["parts"]:
        part["source"] = copy.deepcopy(descriptor)
        part["pages"] = {
            side: copy.deepcopy(metadata) for side in ("front", "back", "cut")
        }
    production = _build(render_bundle=bundle)
    manifest = _manifest(production)

    monkeypatch.setattr(
        nesting_manifest_store_module, "verify_source_pin", _REAL_VERIFY_SOURCE_PIN
    )
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "resolve_final_source",
        _REAL_RESOLVE_FINAL_SOURCE,
    )
    proofs = preflight_production_source_pins(production, (pin,))
    clean_stat = pin.snapshot_path.stat()
    clean_bytes = pin.snapshot_path.read_bytes()

    def promote_then_tamper(value):
        promoted = _REAL_PROMOTE_SOURCE_PIN(value)
        tampered = bytearray(clean_bytes)
        tampered[0] ^= 0x01
        pin.snapshot_path.write_bytes(tampered)
        os.utime(
            pin.snapshot_path,
            ns=(clean_stat.st_atime_ns, clean_stat.st_mtime_ns),
        )
        assert pin.snapshot_path.stat().st_size == clean_stat.st_size
        assert pin.snapshot_path.stat().st_mtime_ns == clean_stat.st_mtime_ns
        return promoted

    monkeypatch.setattr(
        nesting_manifest_store_module, "promote_source_pin", promote_then_tamper
    )
    store = NestingManifestStore(root=tmp_path / "proof-tamper-manifests")
    with pytest.raises(ManifestFingerprintMismatchError) as caught:
        _STRICT_MANIFEST_PERSIST(
            store,
            production_request=production,
            manifest=manifest,
            source_pins=(pin,),
            source_proofs=proofs,
        )
    assert caught.value.code == "LAYOUT_MANIFEST_STALE"
    assert caught.value.status_code == 409
    with pytest.raises(ManifestFingerprintMismatchError):
        NestingManifestStore(root=store.root).load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_verify_source_pin_bat_tamper_cung_size_mtime_giua_hash_va_inspect(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hash hậu kiểm phải bắt đúng khe TOCTOU mà stat size/mtime không thấy."""

    import pikepdf

    from app.core import artifact_lease
    from app.core import nesting_source_pin as source_pin_module
    from app.core.nesting_source_pin import (
        NestingSourceStaleError,
        pin_pdf_path,
        source_descriptor,
        verify_source_pin,
    )

    uploads = tmp_path / "uploads-proof-hash-inspect"
    results = tmp_path / "results-proof-hash-inspect"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "proof-hash-inspect.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    descriptor = source_descriptor(pin)
    metadata = pin.pages[0].to_binding_metadata()
    clean_stat = pin.snapshot_path.stat()
    clean_bytes = pin.snapshot_path.read_bytes()
    real_hash = source_pin_module._hash_file
    call_count = 0

    def hash_then_tamper(path, **kwargs):
        nonlocal call_count
        result = real_hash(path, **kwargs)
        call_count += 1
        if call_count == 1:
            tampered = bytearray(clean_bytes)
            tampered[0] ^= 0x01
            pin.snapshot_path.write_bytes(tampered)
            os.utime(
                pin.snapshot_path,
                ns=(clean_stat.st_atime_ns, clean_stat.st_mtime_ns),
            )
            assert pin.snapshot_path.stat().st_size == clean_stat.st_size
            assert pin.snapshot_path.stat().st_mtime_ns == clean_stat.st_mtime_ns
        return result

    monkeypatch.setattr(source_pin_module, "_hash_file", hash_then_tamper)
    with pytest.raises(NestingSourceStaleError):
        verify_source_pin(pin, descriptor, (metadata,))
    assert call_count == 2


def test_source_lease_locator_no_replace_tu_choi_duplicate_khac_phase(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Marker locator authoritative chặn final + provisional ngay lúc tạo."""

    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_source_pin import pin_pdf_path, promote_source_pin

    uploads = tmp_path / "uploads-duplicate-locator"
    results = tmp_path / "results-duplicate-locator"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "duplicate-locator.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    assert promote_source_pin(pin)
    with pytest.raises(ValueError, match="đã có lease khác"):
        artifact_lease.create_artifact_lease(
            "nesting_source",
            pin.snapshot_path,
            locator_id=pin.locator_id,
        )

    resolved = artifact_lease.resolve_nesting_source_lease(
        pin.locator_id,
        require_final=True,
    )
    assert resolved is not None
    assert resolved.token == pin.lease_token
    assert resolved.phase == "final"


def test_source_lease_receipt_cu_khong_ghi_de_marker_locator_moi(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Token stale không được promote/delete authority mới cùng locator (ABA)."""

    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_source_pin import pin_pdf_path

    uploads = tmp_path / "uploads-locator-aba"
    results = tmp_path / "results-locator-aba"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "locator-aba.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    assert artifact_lease.discard_artifact_lease(
        pin.lease_token,
        expected_locator_id=pin.locator_id,
        expected_artifact_path=pin.snapshot_path,
    )
    replacement_token = artifact_lease.create_artifact_lease(
        "nesting_source",
        pin.snapshot_path,
        locator_id=pin.locator_id,
    )

    assert not artifact_lease.promote_artifact_lease(
        pin.lease_token,
        expected_locator_id=pin.locator_id,
        expected_artifact_path=pin.snapshot_path,
    )
    replacement = artifact_lease.resolve_nesting_source_lease_token(
        replacement_token,
        expected_locator_id=pin.locator_id,
        expected_artifact_path=pin.snapshot_path,
        require_final=False,
    )
    assert replacement is not None
    assert replacement.token == replacement_token


def test_source_lease_locator_no_replace_giua_hai_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hai process tranh cùng locator chỉ đúng một marker/token được công bố."""

    from app.core import artifact_lease

    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(2)
    result_queue = context.Queue()
    uploads = tmp_path / "uploads-locator-race"
    results = tmp_path / "results-locator-race"
    uploads.mkdir()
    results.mkdir()
    locator_id = "12345678-1234-4234-8234-123456789abc"
    snapshot = uploads / f"nesting_source_{locator_id.replace('-', '')}.pdf"
    snapshot.write_bytes(b"%PDF-1.7\n%%EOF\n")
    processes = [
        context.Process(
            target=_race_source_lease_worker,
            args=(
                str(uploads),
                str(results),
                str(snapshot),
                locator_id,
                barrier,
                result_queue,
            ),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=30)
        assert process.exitcode == 0

    outcomes = [result_queue.get(timeout=5) for _ in processes]
    assert sorted(outcome[0] for outcome in outcomes) == ["conflict", "stored"]
    winner_token = next(
        outcome[1] for outcome in outcomes if outcome[0] == "stored"
    )
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))
    resolved = artifact_lease.resolve_nesting_source_lease(
        locator_id,
        require_final=False,
    )
    assert resolved is not None
    assert resolved.token == winner_token
    assert len(list(results.glob(".artifact_lease_nesting_source_*.json"))) == 1


def test_source_lease_legacy_van_tu_choi_duplicate_truoc_phase(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fallback marker token v1 vẫn đếm duplicate trước khi chọn final."""

    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_source_pin import pin_pdf_path, promote_source_pin

    uploads = tmp_path / "uploads-legacy-duplicate"
    results = tmp_path / "results-legacy-duplicate"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "legacy-duplicate.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    assert promote_source_pin(pin)
    authoritative = artifact_lease._nesting_source_marker_path(pin.locator_id)
    assert authoritative is not None
    legacy = results / f".artifact_lease_{pin.lease_token}.json"
    authoritative.replace(legacy)
    duplicate_token = "f" * 64 if pin.lease_token != "f" * 64 else "e" * 64
    payload = json.loads(legacy.read_text(encoding="utf-8"))
    payload["token"] = duplicate_token
    payload["phase"] = "provisional"
    (results / f".artifact_lease_{duplicate_token}.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    assert artifact_lease.resolve_nesting_source_lease(
        pin.locator_id,
        require_final=True,
    ) is None
    assert artifact_lease.resolve_nesting_source_lease(
        pin.locator_id,
        require_final=False,
    ) is None


def test_store_load_many_quet_lease_mot_lan_va_giu_full_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Batch gọi resolver một lần; marker mới O(1), legacy chỉ scan tối đa một lần."""

    import pikepdf

    from app.core import artifact_lease
    from app.core import nesting_source_pin as source_pin_module
    from app.core.nesting_source_pin import pin_pdf_path, source_descriptor

    uploads = tmp_path / "uploads-load-many"
    results = tmp_path / "results-load-many"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "load-many.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    descriptor = source_descriptor(pin)
    metadata = pin.pages[0].to_binding_metadata()
    bundle = _bundle()
    for part in bundle["parts"]:
        part["source"] = copy.deepcopy(descriptor)
        part["pages"] = {
            side: copy.deepcopy(metadata) for side in ("front", "back", "cut")
        }
    production = _build(render_bundle=bundle)
    manifest = _manifest(production)

    monkeypatch.setattr(
        nesting_manifest_store_module, "verify_source_pin", _REAL_VERIFY_SOURCE_PIN
    )
    monkeypatch.setattr(
        nesting_manifest_store_module, "promote_source_pin", _REAL_PROMOTE_SOURCE_PIN
    )
    monkeypatch.setattr(
        nesting_manifest_store_module,
        "resolve_final_source",
        _REAL_RESOLVE_FINAL_SOURCE,
    )
    store = NestingManifestStore(root=tmp_path / "load-many-manifests")
    stored = _STRICT_MANIFEST_PERSIST(
        store,
        production_request=production,
        manifest=manifest,
        source_pins=(pin,),
    )
    reference = {
        "manifestId": stored.manifest_id,
        "layoutFingerprint": stored.layout_fingerprint,
    }

    scans = 0
    inspections = 0
    real_batch_resolve = nesting_manifest_store_module.resolve_nesting_source_leases
    real_inspect = source_pin_module._inspect_pdf

    def count_batch_resolve(locator_ids, **kwargs):
        nonlocal scans
        scans += 1
        return real_batch_resolve(locator_ids, **kwargs)

    def count_inspect(path):
        nonlocal inspections
        inspections += 1
        return real_inspect(path)

    monkeypatch.setattr(
        nesting_manifest_store_module,
        "resolve_nesting_source_leases",
        count_batch_resolve,
    )
    monkeypatch.setattr(source_pin_module, "_inspect_pdf", count_inspect)
    loaded = NestingManifestStore(root=store.root).load_many((reference, reference))

    assert len(loaded) == 2
    assert loaded[0].canonical_bytes == loaded[1].canonical_bytes
    assert scans == 1
    # Hai locator load đều SHA-256 đầy đủ; metadata cùng digest chỉ parse một lần
    # trong chính batch request, không đi qua cache RAM của persist trước đó.
    assert inspections == 1


def test_receipt_khong_gia_han_lai_lease_het_han_trong_luc_hash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lease hết hạn sau resolve nhưng trước renew phải stale, không resurrect."""

    import pikepdf

    from app.core import artifact_lease
    from app.core import nesting_source_pin as source_pin_module
    from app.core.nesting_source_pin import (
        NestingSourceStaleError,
        pin_pdf_path,
        promote_source_pin,
        reverify_source_pin,
        source_descriptor,
        verify_source_pin,
    )

    uploads = tmp_path / "uploads-receipt-expiry"
    results = tmp_path / "results-receipt-expiry"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    original = tmp_path / "receipt-expiry.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(original)
    pdf.close()
    pin = pin_pdf_path(original)
    descriptor = source_descriptor(pin)
    metadata = pin.pages[0].to_binding_metadata()
    proof = verify_source_pin(pin, descriptor, (metadata,))
    assert promote_source_pin(pin)
    marker = artifact_lease._nesting_source_marker_path(pin.locator_id)
    assert marker is not None
    expires_at = json.loads(marker.read_text(encoding="utf-8"))[
        "initial_expires_at"
    ]
    clock = [float(expires_at) - 1.0]
    monkeypatch.setattr(artifact_lease.time, "time", lambda: clock[0])
    real_hash = source_pin_module._hash_file

    def hash_then_expire(path, **kwargs):
        result = real_hash(path, **kwargs)
        clock[0] = float(expires_at) + 1.0
        return result

    monkeypatch.setattr(source_pin_module, "_hash_file", hash_then_expire)
    with pytest.raises(NestingSourceStaleError):
        reverify_source_pin(
            pin,
            proof,
            descriptor,
            (metadata,),
            require_final=True,
            renew=True,
        )
    assert not marker.exists()


def test_pin_pdf_path_tu_choi_revision_da_doi_truoc_snapshot_khong_orphan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pikepdf

    from app.core import artifact_lease
    from app.core.nesting_source_pin import pin_pdf_path
    from app.core.source_revision import (
        SOURCE_REVISION_CHANGED_MESSAGE,
        SourceRevisionChangedError,
        capture_source_fingerprint,
    )

    uploads = tmp_path / "uploads-stale"
    results = tmp_path / "results-stale"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    source = tmp_path / "nguon-da-doi.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(source)
    pdf.close()
    expected = capture_source_fingerprint(source)

    source.write_bytes(source.read_bytes() + b"\n% revision moi")
    with pytest.raises(SourceRevisionChangedError) as caught:
        pin_pdf_path(source, expected_fingerprint=expected)

    assert str(caught.value) == SOURCE_REVISION_CHANGED_MESSAGE
    assert list(uploads.glob("nesting_source_*.pdf")) == []


def test_pin_pdf_path_race_tai_os_open_khong_tao_snapshot_hoac_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pikepdf

    from app.core import artifact_lease
    from app.core import nesting_source_pin as source_pin_module
    from app.core.source_revision import (
        SourceRevisionChangedError,
        capture_source_fingerprint,
    )

    uploads = tmp_path / "uploads-race"
    results = tmp_path / "results-race"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(artifact_lease.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))

    source = tmp_path / "nguon-race.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(144.0, 72.0))
    pdf.save(source)
    pdf.close()
    expected = capture_source_fingerprint(source)

    real_os_open = source_pin_module.os.open
    source_key = str(source.resolve()).casefold()
    raced = False
    lease_calls: list[tuple] = []

    def race_at_source_open(path, flags, *args):
        nonlocal raced
        path_key = str(Path(path).resolve()).casefold()
        if not raced and path_key == source_key:
            raced = True
            source.write_bytes(source.read_bytes() + b"\n% race revision")
        return real_os_open(path, flags, *args)

    def record_lease(*args, **kwargs):
        lease_calls.append((args, kwargs))
        raise AssertionError("Revision stale không được tạo lease.")

    monkeypatch.setattr(source_pin_module.os, "open", race_at_source_open)
    monkeypatch.setattr(source_pin_module, "create_artifact_lease", record_lease)

    with pytest.raises(SourceRevisionChangedError):
        source_pin_module.pin_pdf_path(
            source,
            expected_fingerprint=expected,
        )

    assert raced
    assert lease_calls == []
    assert list(uploads.glob("nesting_source_*.pdf")) == []


def test_pin_uploaded_pdf_uy_quyen_ve_pin_pdf_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core import nesting_source_pin as source_pin_module

    source_path = "D:/du-lieu/nguon.pdf"
    sentinel = object()

    class FakeSession:
        def query(self, _model):
            return self

        def filter(self, _condition):
            return self

        def first(self):
            return type("Uploaded", (), {"file_path": source_path})()

        def close(self):
            return None

    calls: list[str] = []

    def fake_pin_pdf_path(path):
        calls.append(path)
        return sentinel

    monkeypatch.setattr(source_pin_module, "pin_pdf_path", fake_pin_pdf_path)
    result = source_pin_module.pin_uploaded_pdf(
        "11111111-1111-4111-8111-111111111111",
        session_factory=FakeSession,
    )
    assert result is sentinel
    assert calls == [source_path]


@pytest.mark.parametrize(
    "width_mm,height_mm,flip_edge,physical_axis,expected_back",
    [
        (320.0, 450.0, "long", "x", [-1.0, 0.0, 0.0, 1.0, 320.0, 0.0]),
        (320.0, 450.0, "short", "y", [1.0, 0.0, 0.0, -1.0, 0.0, 450.0]),
        (450.0, 320.0, "long", "x", [-1.0, 0.0, 0.0, 1.0, 450.0, 0.0]),
        (450.0, 320.0, "short", "y", [1.0, 0.0, 0.0, -1.0, 0.0, 320.0]),
    ],
)
def test_duplex_cnc_giu_mapping_long_x_short_y_doc_lap_huong_to(
    width_mm,
    height_mm,
    flip_edge,
    physical_axis,
    expected_back,
) -> None:
    request = _public_request()
    request["sheet"]["widthMm"] = width_mm
    request["sheet"]["heightMm"] = height_mm
    bundle = _bundle()
    bundle["duplex"] = {
        "mode": "duplex",
        "flipEdge": flip_edge,
        "physicalAxis": physical_axis,
    }
    bundle["sheetFrames"]["back"] = expected_back

    production = _build(public_request=request, render_bundle=bundle)
    assert production.render_bundle["duplex"]["physicalAxis"] == physical_axis
    assert production.render_bundle["sheetFrames"]["back"] == expected_back
    determinant = (
        expected_back[0] * expected_back[3]
        - expected_back[1] * expected_back[2]
    )
    assert determinant == -1.0

    wrong = copy.deepcopy(bundle)
    wrong["duplex"]["physicalAxis"] = "y" if physical_axis == "x" else "x"
    with pytest.raises(ProductionAdapterError):
        _build(public_request=request, render_bundle=wrong)


@pytest.mark.parametrize(
    "tool,task_mode,duplex_mode,separate_cut,expected_sides",
    [
        ("sticker_imposer", "step_repeat", "simplex", False, ["front"]),
        ("sticker_imposer", "nup", "simplex", True, ["front", "cut"]),
        ("cnc_imposer", "step_repeat", "simplex", True, ["front", "cut"]),
        (
            "cnc_imposer",
            "nup",
            "duplex",
            True,
            ["front", "back", "cut"],
        ),
    ],
)
def test_render_bundle_phu_du_bon_flow_va_output_sides(
    tool,
    task_mode,
    duplex_mode,
    separate_cut,
    expected_sides,
) -> None:
    request = _public_request()
    bundle = _bundle()
    bundle["flow"]["tool"] = tool
    bundle["flow"]["taskMode"] = task_mode
    bundle["renderer"] = {
        "identity": (
            "sticker_imposer_pdf"
            if tool == "sticker_imposer"
            else "cnc_imposer_pdf"
        ),
        "version": "affine-flow-v1",
    }
    bundle["outputSides"] = expected_sides
    bundle["marks"]["cut"]["separatePage"] = separate_cut

    if duplex_mode == "simplex":
        bundle["duplex"] = {
            "mode": "simplex",
            "flipEdge": "none",
            "physicalAxis": "none",
        }
        bundle["sheetFrames"]["back"] = None
        bundle["marks"]["duplexRegistration"] = False
        for part in bundle["parts"]:
            part["pages"]["back"] = None

    if task_mode == "step_repeat":
        request["parts"] = [request["parts"][0]]
        bundle["parts"] = [bundle["parts"][0]]

    production = _build(public_request=request, render_bundle=bundle)
    assert production.render_bundle["flow"] == {
        "tool": tool,
        "taskMode": task_mode,
        "layoutIntent": "quantity_fulfillment",
    }
    assert production.render_bundle["outputSides"] == expected_sides
    assert production.render_bundle["sheetFrames"]["back"] == (
        None
        if duplex_mode == "simplex"
        else [-1.0, 0.0, 0.0, 1.0, 320.0, 0.0]
    )


@pytest.mark.parametrize(
    "rotate_deg,expected_transform",
    [
        (0, [1.0, 0.0, 0.0, 1.0, -10.0, -20.0]),
        (90, [0.0, -1.0, 1.0, 0.0, -20.0, 210.0]),
        (180, [-1.0, 0.0, 0.0, -1.0, 210.0, 120.0]),
        (270, [0.0, 1.0, -1.0, 0.0, 120.0, -10.0]),
    ],
)
def test_source_page_affine_khoa_du_bon_rotate_va_origin_khac_khong(
    rotate_deg,
    expected_transform,
) -> None:
    bundle = _bundle()
    binding = bundle["parts"][1]["pages"]["front"]
    binding["pageBoxesMm"] = {
        "mediaBox": [10.0, 20.0, 210.0, 120.0],
        "cropBox": [15.0, 25.0, 205.0, 115.0],
        "trimBox": [20.0, 30.0, 200.0, 110.0],
    }
    binding["rotateDeg"] = rotate_deg
    binding["sourcePageToCanonical"] = expected_transform

    production = _build(render_bundle=bundle)
    canonical_part = next(
        part
        for part in production.render_bundle["parts"]
        if part["partId"] == "tem-a"
    )
    canonical = canonical_part["pages"]["front"]
    assert canonical["rotateDeg"] == rotate_deg
    assert canonical["sourcePageToCanonical"] == expected_transform
    determinant = (
        expected_transform[0] * expected_transform[3]
        - expected_transform[1] * expected_transform[2]
    )
    assert determinant == 1.0


def test_adapter_khong_tin_rotation_cua_client_va_mac_dinh_cardinal() -> None:
    """Miền xoay là server-owned, và mặc định Chặng A là cardinal.

    NEST (audit 2026-08-28 §A2.1) — ĐỔI KỲ VỌNG CÓ CHỦ ĐÍCH.

    Bản trước khoá ``orientationPolicy == {"mode": "free"}`` vì hàm dựng request
    ghi CỨNG giá trị đó. Bất biến thật cần giữ là *không tin client*, chứ không
    phải *luôn luôn free*: kế hoạch rollout yêu cầu Chặng A chạy cardinal, và số
    đo Lô 0 cho thấy free còn kém cardinal ở 8/9 ca.

    Client vẫn gửi ``fixed 90°`` ở cấp job và ``fixed 13°`` ở cấp part (xem
    ``_public_request``); cả hai vẫn phải bị bỏ qua.
    """

    production = _build()
    request = production.engine_request

    assert request["gapMm"] == 0.0
    assert request["orientationPolicy"] == {
        "defaultRotation": {
            "mode": "discrete",
            "anglesDeg": [0.0, 90.0, 180.0, 270.0],
        },
        "reflection": "forbidden",
    }
    assert all(
        part["rotationConstraint"] == {"mode": "inherit"}
        for part in request["parts"]
    )
    assert [part["partId"] for part in request["parts"]] == ["tem-a", "tem-b"]
    assert request["productionContract"]["inputHash"].startswith("sha256:")
    assert request["productionContract"]["layoutFingerprint"].startswith("sha256:")


def test_client_khong_duoc_gui_field_server_owned() -> None:
    request = _public_request()
    request["productionContract"] = {"schemaVersion": 1}
    with pytest.raises(ProductionAdapterError):
        _build(public_request=request)

    request = _public_request()
    request["parts"][0]["referencePointMm"] = [0.0, 0.0]
    with pytest.raises(ProductionAdapterError):
        _build(public_request=request)


def test_hash_on_dinh_voi_thu_tu_field_ring_va_negative_zero() -> None:
    first = _build()
    request = _public_request()
    request = json.loads(json.dumps(request))
    request["parts"].reverse()
    for part in request["parts"]:
        part["outer"] = part["outer"][2:] + part["outer"][:2]
    request["sheet"]["widthMm"] = 320.0000004
    request["sheet"]["marginMm"]["left"] = 5.0000004
    request["parts"][0]["outer"][2][0] = -0.0
    bundle = _bundle()
    bundle["parts"].reverse()
    bundle["parts"][0]["packingFootprint"]["outer"] = request["parts"][0]["outer"]
    second = _build(public_request=request, render_bundle=bundle)

    assert second.input_hash == first.input_hash
    assert second.layout_fingerprint == first.layout_fingerprint
    assert second.render_bundle_hash == first.render_bundle_hash


def test_grouping_zone_canonical_hash_va_rebuild_identity() -> None:
    zones = _maximize_area_zones()
    production = _build(
        grouping_intent="maximize_area",
        placement_zones=zones,
    )
    reordered = _build(
        grouping_intent="maximize_area",
        placement_zones=list(reversed(zones)),
    )
    contract = production.engine_request["productionContract"]
    assert contract["schemaVersion"] == MIXED_NESTING_PRODUCTION_SCHEMA_VERSION
    assert contract["groupingIntent"] == "maximize_area"
    assert [zone["partId"] for zone in contract["placementZones"]] == [
        "tem-a",
        "tem-b",
    ]
    assert reordered.engine_request == production.engine_request
    assert reordered.geometry_constraints_hash == production.geometry_constraints_hash
    assert validate_production_request_identity(production) == production

    free_gang = _build()
    assert free_gang.geometry_constraints_hash != production.geometry_constraints_hash
    assert free_gang.input_hash != production.input_hash
    assert free_gang.layout_fingerprint != production.layout_fingerprint

    reassociated = copy.deepcopy(zones)
    reassociated[0]["partId"], reassociated[1]["partId"] = (
        reassociated[1]["partId"],
        reassociated[0]["partId"],
    )
    changed_association = _build(
        grouping_intent="maximize_area",
        placement_zones=reassociated,
    )
    assert changed_association.geometry_constraints_hash != production.geometry_constraints_hash

    changed_bounds = copy.deepcopy(zones)
    changed_bounds[0]["bounds"]["minYmm"] = 224.5
    moved_boundary = _build(
        grouping_intent="maximize_area",
        placement_zones=changed_bounds,
    )
    assert moved_boundary.geometry_constraints_hash != production.geometry_constraints_hash


def test_grouping_zone_fail_closed_khi_partition_thieu_hoac_tamper() -> None:
    with pytest.raises(ProductionAdapterError, match="không được mang"):
        _build(placement_zones=_maximize_area_zones())
    with pytest.raises(ProductionAdapterError, match="thiếu vùng"):
        _build(grouping_intent="maximize_area", placement_zones=())

    production = _build(
        grouping_intent="maximize_area",
        placement_zones=_maximize_area_zones(),
    )
    tampered = copy.deepcopy(production.engine_request)
    tampered["productionContract"]["groupingIntent"] = "free_gang"
    with pytest.raises(ProductionAdapterError):
        validate_production_request_identity(
            replace(production, engine_request=tampered)
        )


@pytest.mark.parametrize(
    ("mutator", "identity"),
    [
        (lambda request, bundle, clearance, versions: request["parts"][0].update(quantity=9), "input"),
        (lambda request, bundle, clearance, versions: bundle["parts"][1]["pages"]["front"].update(pageIndex=9), "input"),
        (lambda request, bundle, clearance, versions: clearance["partToPart"].update(xMm=9.0), "input"),
        (lambda request, bundle, clearance, versions: versions.update(solverVersion=99), "fingerprint"),
    ],
)
def test_hash_doi_khi_input_bundle_clearance_hoac_version_doi(mutator, identity) -> None:
    baseline = _build()
    request = _public_request()
    bundle = _bundle()
    clearance = _clearance()
    versions = _versions()
    mutator(request, bundle, clearance, versions)
    changed = _build(
        public_request=request,
        render_bundle=bundle,
        clearance=clearance,
        algorithm_versions=versions,
    )

    if identity == "input":
        assert changed.input_hash != baseline.input_hash
    assert changed.layout_fingerprint != baseline.layout_fingerprint


def test_job_id_khong_lam_doi_input_hash_nhung_manifest_identity_van_doi() -> None:
    first = _build(job_id=JOB_ID)
    other_id = "fedcba9876543210fedcba9876543210"
    second = _build(job_id=other_id)

    assert second.input_hash == first.input_hash
    assert second.layout_fingerprint == first.layout_fingerprint
    assert second.engine_request["jobId"] == other_id


def test_native_cu_fail_closed_cho_production() -> None:
    with pytest.raises(EngineUnavailableError):
        _capabilities(complete=False).require_production_versions()


def test_validate_manifest_echo_exact_va_mismatch_fail_closed() -> None:
    production = _build()
    manifest = _manifest(production)
    validate_production_manifest(manifest, production.engine_request, _capabilities())

    manifest["layoutFingerprint"] = "sha256:" + "f" * 64
    with pytest.raises(MixedNestingError) as caught:
        validate_production_manifest(manifest, production.engine_request, _capabilities())
    assert caught.value.code == "MIXED_NESTING_MANIFEST_MISMATCH"


def test_pyo3_solve_mot_lan_va_revalidate_manifest_that_fail_closed() -> None:
    native = pytest.importorskip(
        "pdfcompare_native",
        reason="Cần bản native đã rebuild để kiểm re-validator PyO3 thật.",
    )
    run_class = getattr(native, "MixedNestingRun", None)
    if run_class is None or not callable(getattr(run_class, "validate_manifest", None)):
        pytest.skip("Bản native hiện tại chưa có static placement re-validator.")

    capabilities = json.loads(run_class.capabilities())
    versions = capabilities.get("algorithmVersions")
    build_identity = capabilities.get("nativeBuildIdentity")
    assert isinstance(versions, dict)
    assert isinstance(build_identity, str)
    production = _build(
        algorithm_versions=versions,
        native_build_identity=build_identity,
    )
    request_payload = json.dumps(
        production.engine_request,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )

    solve_calls = 0
    run = run_class()

    def solve_once() -> dict:
        nonlocal solve_calls
        solve_calls += 1
        return json.loads(run.solve(request_payload))

    manifest = solve_once()
    validate_fn = run_class.validate_manifest
    validate_fn(
        request_payload,
        json.dumps(manifest, allow_nan=False, separators=(",", ":"), sort_keys=True),
    )

    invalid: list[dict] = []
    pose_tampered = copy.deepcopy(manifest)
    pose_tampered["placements"][0]["pose"]["translateXmm"] += 0.125
    invalid.append(pose_tampered)

    trial_tampered = copy.deepcopy(manifest)
    trial_tampered["search"]["selectedCandidate"] = {
        "kind": "smart_trial",
        "trialId": 999,
    }
    invalid.append(trial_tampered)

    baseline_tampered = copy.deepcopy(manifest)
    baseline_score = baseline_tampered["search"].get("baselineScore")
    assert isinstance(baseline_score, dict)
    baseline_score["sheetCount"] = max(
        0,
        int(baseline_tampered["search"]["selectedScore"]["sheetCount"]) - 1,
    )
    invalid.append(baseline_tampered)

    for candidate in invalid:
        with pytest.raises(RuntimeError) as caught:
            validate_fn(
                request_payload,
                json.dumps(
                    candidate,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            )
        assert "MIXED_NESTING_MANIFEST_MISMATCH" in str(caught.value)

    assert solve_calls == 1


def test_orchestrator_solve_mot_lan_persist_reload_khong_nested_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.mixed_nesting_jobs import mixed_nesting_jobs

    def reject_nested_job(*_args, **_kwargs):
        pytest.fail("Production không được tạo nested /mixed-nesting/jobs.")

    monkeypatch.setattr(mixed_nesting_jobs, "submit", reject_nested_job)
    template = _build()
    source_pins = _fake_source_pins(template)
    solve_calls: list[dict] = []
    native_manifests: list[dict] = []

    class CountingHandle:
        capabilities = _capabilities()

        def solve_production(self, request):
            solve_calls.append(request)
            carrier = type(
                "ProductionCarrier",
                (),
                {
                    "engine_request": request,
                    "native_build_identity": BUILD_IDENTITY,
                },
            )()
            manifest = _manifest(carrier)
            native_manifests.append(manifest)
            return manifest

    value = ProductionNestingInput(
        manifest_id=JOB_ID,
        request_revision=3,
        public_request=_public_request(),
        render_bundle=_bundle(),
        clearance=_clearance(),
        fixed_obstacles=(
            {
                "obstacleId": "boong-1",
                "kind": "gripper",
                "outer": [
                    [0.0, 0.0],
                    [320.0, 0.0],
                    [320.0, 8.0],
                    [0.0, 8.0],
                ],
            },
        ),
        source_pins=source_pins,
    )
    solved = solve_production_nesting(
        value,
        run_factory=lambda: CountingHandle(),
    )
    assert solved.production_request.engine_request["jobId"] == JOB_ID
    # NEST (audit 2026-08-28 §A2.1): orchestrator không truyền rotation_policy nên
    # nhận mặc định Chặng A là cardinal, không còn là free ghi cứng.
    assert solved.production_request.engine_request["orientationPolicy"] == {
        "defaultRotation": {
            "mode": "discrete",
            "anglesDeg": [0.0, 90.0, 180.0, 270.0],
        },
        "reflection": "forbidden",
    }
    assert solve_calls == [solved.production_request.engine_request]

    authoritative_manifest = solved.manifest
    authoritative_production = solved.production_request
    native_manifests[0]["placements"][0]["pose"]["translateXmm"] += 99.0
    writer_copy = solved.manifest
    writer_copy["placements"][0]["pose"]["translateYmm"] += 77.0
    request_copy = solved.production_request
    request_copy.engine_request["seed"] = 999
    assert solved.manifest == authoritative_manifest
    assert solved.production_request == authoritative_production

    store = NestingManifestStore(root=tmp_path / "orchestrator-store")
    stored = persist_production_nesting(solved, store=store)
    loaded = NestingManifestStore(root=store.root).load(
        manifest_id=JOB_ID,
        layout_fingerprint=solved.production_request.layout_fingerprint,
    )
    assert loaded.canonical_bytes == stored.canonical_bytes
    assert loaded.manifest == solved.manifest
    assert solve_calls == [solved.production_request.engine_request]


def test_orchestrator_truyen_grant_cache_va_giu_canonical_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import contextmanager
    from types import SimpleNamespace

    template = _build()
    plan = SimpleNamespace(
        worker_grant=7,
        nfp_cache_max_bytes_per_trial=123_456_789,
        estimated_peak_mb=987.5,
        reason="hardware-plan-test",
    )
    calls: dict[str, object] = {}
    reservation_active = False
    native_manifest: dict[str, object] = {}

    def fake_plan(request):
        calls["planned_request"] = copy.deepcopy(request)
        return plan

    def fake_assert(candidate):
        calls["asserted_plan"] = candidate

    @contextmanager
    def fake_reservation(kind, required_mb, budget_provider, queue_cancelled):
        nonlocal reservation_active
        calls["reservation"] = (
            kind,
            required_mb,
            budget_provider(),
            queue_cancelled,
        )
        reservation_active = True
        try:
            yield
        finally:
            reservation_active = False

    monkeypatch.setattr(nesting_production_orchestrator_module, "plan_hardware", fake_plan)
    monkeypatch.setattr(
        nesting_production_orchestrator_module,
        "assert_fits_memory",
        fake_assert,
    )
    monkeypatch.setattr(
        nesting_production_orchestrator_module,
        "memory_budget_mb",
        lambda: 4_096.0,
    )
    monkeypatch.setattr(
        nesting_production_orchestrator_module,
        "memory_reservation",
        fake_reservation,
    )

    class HardwareHandle:
        capabilities = _capabilities()

        def solve_production_with_hardware(
            self,
            request,
            *,
            worker_grant,
            nfp_cache_max_bytes_per_trial,
        ):
            assert reservation_active
            calls["native_request"] = copy.deepcopy(request)
            calls["worker_grant"] = worker_grant
            calls["cache_bytes"] = nfp_cache_max_bytes_per_trial
            carrier = type(
                "ProductionCarrier",
                (),
                {
                    "engine_request": request,
                    "native_build_identity": BUILD_IDENTITY,
                },
            )()
            manifest = _manifest(carrier)
            native_manifest.update(copy.deepcopy(manifest))
            return manifest

    solved = solve_production_nesting(
        ProductionNestingInput(
            manifest_id=JOB_ID,
            request_revision=3,
            public_request=_public_request(),
            render_bundle=_bundle(),
            clearance=_clearance(),
            fixed_obstacles=(),
            source_pins=_fake_source_pins(template),
        ),
        run_factory=lambda: HardwareHandle(),
    )

    canonical_request = solved.production_request.engine_request
    assert calls["planned_request"] == canonical_request
    assert calls["native_request"] == canonical_request
    assert calls["asserted_plan"] is plan
    assert calls["worker_grant"] == 7
    assert calls["cache_bytes"] == 123_456_789
    assert calls["reservation"][:3] == (
        nesting_production_orchestrator_module.MIXED_NESTING_KIND,
        987.5,
        4_096.0,
    )
    assert calls["reservation"][3] is None
    assert "workerGrant" not in canonical_request
    assert "nfpCacheMaxBytesPerTrial" not in canonical_request
    assert solved.manifest == native_manifest
    assert solved.manifest["placements"] == native_manifest["placements"]
    assert not reservation_active


@pytest.mark.parametrize("mode", ["success", "error", "cancel"])
def test_orchestrator_nha_reservation_khi_terminal(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
) -> None:
    from contextlib import contextmanager
    from types import SimpleNamespace
    import threading

    template = _build()
    cancel_event = threading.Event() if mode == "cancel" else None
    plan = SimpleNamespace(
        worker_grant=2,
        nfp_cache_max_bytes_per_trial=64 * 1024 * 1024,
        estimated_peak_mb=512.0,
        reason="reservation-terminal-test",
    )
    transitions: list[str] = []

    monkeypatch.setattr(
        nesting_production_orchestrator_module,
        "plan_hardware",
        lambda _request: plan,
    )
    monkeypatch.setattr(
        nesting_production_orchestrator_module,
        "assert_fits_memory",
        lambda candidate: None,
    )

    @contextmanager
    def tracking_reservation(_kind, _required, _provider, _cancelled):
        transitions.append("enter")
        try:
            yield
        finally:
            transitions.append("exit")

    monkeypatch.setattr(
        nesting_production_orchestrator_module,
        "memory_reservation",
        tracking_reservation,
    )

    class TerminalHandle:
        capabilities = _capabilities()

        def cancel(self):
            pass

        def solve_production_with_hardware(self, request, **_grant):
            assert transitions == ["enter"]
            if mode == "error":
                raise RuntimeError("solve-production-boom")
            if mode == "cancel":
                assert cancel_event is not None
                cancel_event.set()
            carrier = type(
                "ProductionCarrier",
                (),
                {
                    "engine_request": request,
                    "native_build_identity": BUILD_IDENTITY,
                },
            )()
            return _manifest(carrier)

    value = ProductionNestingInput(
        manifest_id=JOB_ID,
        request_revision=3,
        public_request=_public_request(),
        render_bundle=_bundle(),
        clearance=_clearance(),
        fixed_obstacles=(),
        source_pins=_fake_source_pins(template),
    )
    if mode == "error":
        with pytest.raises(RuntimeError, match="solve-production-boom"):
            solve_production_nesting(value, run_factory=lambda: TerminalHandle())
    elif mode == "cancel":
        with pytest.raises(MixedNestingError) as caught:
            solve_production_nesting(
                value,
                cancel_event=cancel_event,
                run_factory=lambda: TerminalHandle(),
            )
        assert caught.value.code == "MIXED_NESTING_CANCELLED"
    else:
        solved = solve_production_nesting(
            value,
            run_factory=lambda: TerminalHandle(),
        )
        assert solved.manifest["status"] == "completed"
    assert transitions == ["enter", "exit"]


def test_align_tham_gia_fingerprint_va_reload_identity() -> None:
    center = _build(alignment="center")
    top_left = _build(alignment="top-left")

    assert center.input_hash != top_left.input_hash
    assert center.solver_config_hash == top_left.solver_config_hash
    assert center.layout_fingerprint != top_left.layout_fingerprint
    assert validate_production_request_identity(center) == center
    assert validate_production_request_identity(top_left) == top_left


def test_orchestrator_pin_mismatch_fail_truoc_native_solve() -> None:
    from app.core.nesting_manifest_store import ManifestContractError

    template = _build()
    pins = list(_fake_source_pins(template))
    pins[0] = replace(
        pins[0],
        locator_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    )
    solve_calls = 0

    class CountingHandle:
        capabilities = _capabilities()

        def solve_production(self, _request):
            nonlocal solve_calls
            solve_calls += 1
            raise AssertionError("Pin mismatch không được đi tới native solve.")

    value = ProductionNestingInput(
        manifest_id=JOB_ID,
        request_revision=3,
        public_request=_public_request(),
        render_bundle=_bundle(),
        clearance=_clearance(),
        fixed_obstacles=(),
        source_pins=tuple(pins),
    )
    with pytest.raises(ManifestContractError, match="exact locator set"):
        solve_production_nesting(value, run_factory=lambda: CountingHandle())
    assert solve_calls == 0


def test_orchestrator_cancel_trong_solve_goi_handle_cancel_va_khong_tra_session() -> None:
    import threading

    template = _build()
    cancel_event = threading.Event()
    solve_started = threading.Event()
    native_cancelled = threading.Event()
    cancel_calls = 0

    class CancelAwareHandle:
        capabilities = _capabilities()

        def cancel(self):
            nonlocal cancel_calls
            cancel_calls += 1
            native_cancelled.set()

        def solve_production(self, request):
            solve_started.set()
            assert native_cancelled.wait(timeout=3.0)
            carrier = type(
                "ProductionCarrier",
                (),
                {
                    "engine_request": request,
                    "native_build_identity": BUILD_IDENTITY,
                },
            )()
            return _manifest(carrier)

    def request_cancel():
        assert solve_started.wait(timeout=3.0)
        cancel_event.set()

    requester = threading.Thread(target=request_cancel)
    requester.start()
    value = ProductionNestingInput(
        manifest_id=JOB_ID,
        request_revision=3,
        public_request=_public_request(),
        render_bundle=_bundle(),
        clearance=_clearance(),
        fixed_obstacles=(),
        source_pins=_fake_source_pins(template),
    )
    with pytest.raises(MixedNestingError) as caught:
        solve_production_nesting(
            value,
            cancel_event=cancel_event,
            run_factory=lambda: CancelAwareHandle(),
        )
    requester.join(timeout=3.0)

    assert not requester.is_alive()
    assert caught.value.code == "MIXED_NESTING_CANCELLED"
    assert cancel_calls == 1


def _solved_orchestrator_fixture():
    template = _build()

    class Handle:
        capabilities = _capabilities()

        def solve_production(self, request):
            carrier = type(
                "ProductionCarrier",
                (),
                {
                    "engine_request": request,
                    "native_build_identity": BUILD_IDENTITY,
                },
            )()
            return _manifest(carrier)

    return solve_production_nesting(
        ProductionNestingInput(
            manifest_id=JOB_ID,
            request_revision=3,
            public_request=_public_request(),
            render_bundle=_bundle(),
            clearance=_clearance(),
            fixed_obstacles=(),
            source_pins=_fake_source_pins(template),
        ),
        run_factory=lambda: Handle(),
    )


def test_commit_fence_cancel_truoc_persist_khong_goi_store() -> None:
    solved = _solved_orchestrator_fixture()
    fence = create_production_commit_fence()
    persist_calls = 0

    class Store:
        def persist(self, **_kwargs):
            nonlocal persist_calls
            persist_calls += 1
            raise AssertionError("Cancel trước commit không được gọi store.")

    assert fence.request_cancel()
    with pytest.raises(MixedNestingError) as caught:
        persist_production_nesting(
            solved,
            store=Store(),
            commit_fence=fence,
        )

    assert caught.value.code == "MIXED_NESTING_CANCELLED"
    assert persist_calls == 0
    assert fence.state == "cancel_requested"


def test_commit_fence_tu_choi_cancel_tu_persist_den_khi_receipt_xong() -> None:
    import threading

    solved = _solved_orchestrator_fixture()
    fence = create_production_commit_fence()
    receipt_started = threading.Event()
    release_receipt = threading.Event()
    stored_sentinel = object()
    receipts: list[object] = []
    outcomes: list[object] = []

    class Store:
        def persist(self, **_kwargs):
            return stored_sentinel

    def publish_receipt(stored):
        receipts.append(stored)
        receipt_started.set()
        assert release_receipt.wait(timeout=3.0)

    def commit():
        outcomes.append(
            persist_production_nesting(
                solved,
                store=Store(),
                commit_fence=fence,
                receipt_publisher=publish_receipt,
            )
        )

    worker = threading.Thread(target=commit)
    worker.start()
    assert receipt_started.wait(timeout=3.0)
    assert fence.state == "committing"
    assert not fence.request_cancel()
    assert not fence.cancel_event.is_set()
    release_receipt.set()
    worker.join(timeout=3.0)

    assert not worker.is_alive()
    assert receipts == [stored_sentinel]
    assert outcomes == [stored_sentinel]
    assert fence.state == "committed"
    assert not fence.request_cancel()


def test_orchestrator_cancel_truoc_solve_khong_tao_native_handle() -> None:
    import threading

    template = _build()
    cancel_event = threading.Event()
    cancel_event.set()
    factory_calls = 0

    def fail_if_created():
        nonlocal factory_calls
        factory_calls += 1
        raise AssertionError("Không được tạo native handle sau khi đã cancel.")

    value = ProductionNestingInput(
        manifest_id=JOB_ID,
        request_revision=3,
        public_request=_public_request(),
        render_bundle=_bundle(),
        clearance=_clearance(),
        fixed_obstacles=(),
        source_pins=_fake_source_pins(template),
    )
    with pytest.raises(MixedNestingError) as caught:
        solve_production_nesting(
            value,
            cancel_event=cancel_event,
            run_factory=fail_if_created,
        )
    assert caught.value.code == "MIXED_NESTING_CANCELLED"
    assert factory_calls == 0


def test_solve_production_goi_solve_dung_mot_lan(monkeypatch) -> None:
    production = _build()
    manifest = _manifest(production)
    calls: list[dict] = []
    handle = object.__new__(MixedNestingRunHandle)
    handle._capabilities = _capabilities()
    handle._run = object()

    def fake_solve(self, request):
        calls.append(request)
        return manifest

    monkeypatch.setattr(MixedNestingRunHandle, "solve", fake_solve)
    assert handle.solve_production(production.engine_request) is manifest
    assert calls == [production.engine_request]


def test_solve_production_with_hardware_fail_closed_khi_native_stale() -> None:
    production = _build()
    handle = object.__new__(MixedNestingRunHandle)
    handle._capabilities = _capabilities()  # Chưa có runtimeControlVersion.
    handle._run = object()

    with pytest.raises(EngineUnavailableError, match="worker grant"):
        handle.solve_production_with_hardware(
            production.engine_request,
            worker_grant=4,
            nfp_cache_max_bytes_per_trial=192 * 1024 * 1024,
        )


def test_store_persist_reload_idempotent_stale_va_conflict(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "nesting-manifests")
    first = _persist(store,
        production_request=production,
        manifest=manifest,
    )
    second = _persist(store,
        production_request=production,
        manifest=dict(reversed(list(manifest.items()))),
    )
    assert second.canonical_bytes == first.canonical_bytes

    store.close()
    reopened = NestingManifestStore(root=tmp_path / "nesting-manifests")
    loaded = reopened.load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    assert loaded.render_bundle_hash == production.render_bundle_hash
    assert loaded.manifest == manifest

    with pytest.raises(ManifestFingerprintMismatchError) as caught:
        reopened.load(
            manifest_id=JOB_ID,
            layout_fingerprint="sha256:" + "e" * 64,
        )
    assert caught.value.code == "LAYOUT_MANIFEST_STALE"
    assert caught.value.status_code == 409

    changed_manifest = copy.deepcopy(manifest)
    changed_manifest["placements"][0]["pose"]["translateYmm"] += 1.0
    with pytest.raises(ManifestConflictError):
        _persist(reopened,
            production_request=production,
            manifest=changed_manifest,
        )


def test_native_proof_chi_bo_validator_readback_cung_transaction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Persist dùng exact canonical proof; load độc lập vẫn native-validate."""

    calls = 0

    def count_native(_request, _manifest):
        nonlocal calls
        calls += 1

    monkeypatch.setattr(
        mixed_nesting_service_module,
        "_validate_manifest_with_native",
        count_native,
    )
    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "native-proof")

    first = _persist(
        store,
        production_request=production,
        manifest=manifest,
    )
    assert calls == 1

    second = _persist(
        store,
        production_request=production,
        manifest=manifest,
    )
    assert second.canonical_bytes == first.canonical_bytes
    assert calls == 2

    loaded = NestingManifestStore(root=store.root).load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    assert loaded.canonical_bytes == first.canonical_bytes
    assert calls == 3



def test_load_manifest_build_a_bang_engine_build_b_bao_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    production_a = _build(native_build_identity="1" * 64)
    store = NestingManifestStore(root=tmp_path / "build-stale")
    _persist(store,
        production_request=production_a,
        manifest=_manifest(production_a),
    )

    monkeypatch.setattr(
        nesting_manifest_store_module,
        "engine_capabilities",
        lambda: _capabilities(build_identity="2" * 64),
    )
    with pytest.raises(ManifestFingerprintMismatchError) as caught:
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production_a.layout_fingerprint,
        )
    assert caught.value.code == "LAYOUT_MANIFEST_STALE"
    assert caught.value.status_code == 409


def test_load_manifest_production_schema_cu_bao_stale_khong_bao_corrupt(
    tmp_path: Path,
) -> None:
    production = _build()
    store = NestingManifestStore(root=tmp_path / "schema-stale")
    stored = _persist(
        store,
        production_request=production,
        manifest=_manifest(production),
    )
    payload = json.loads(stored.canonical_bytes)
    old_schema = MIXED_NESTING_PRODUCTION_SCHEMA_VERSION - 1
    payload["productionRequest"]["algorithmVersions"][
        "productionSchemaVersion"
    ] = old_schema
    payload["productionRequest"]["engineRequest"]["productionContract"][
        "schemaVersion"
    ] = old_schema
    body = {key: value for key, value in payload.items() if key != "contentSha256"}
    payload["contentSha256"] = hashlib.sha256(
        store_canonical_json_bytes(body)
    ).hexdigest()
    (store.root / f"{JOB_ID}.json").write_bytes(
        store_canonical_json_bytes(payload)
    )

    with pytest.raises(ManifestFingerprintMismatchError) as caught:
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )
    assert caught.value.code == "LAYOUT_MANIFEST_STALE"
    assert caught.value.status_code == 409


def test_load_manifest_hai_production_schema_tag_lech_nhau_bao_integrity(
    tmp_path: Path,
) -> None:
    production = _build()
    store = NestingManifestStore(root=tmp_path / "schema-corrupt")
    stored = _persist(
        store,
        production_request=production,
        manifest=_manifest(production),
    )
    payload = json.loads(stored.canonical_bytes)
    payload["productionRequest"]["algorithmVersions"][
        "productionSchemaVersion"
    ] = MIXED_NESTING_PRODUCTION_SCHEMA_VERSION - 1
    body = {key: value for key, value in payload.items() if key != "contentSha256"}
    payload["contentSha256"] = hashlib.sha256(
        store_canonical_json_bytes(body)
    ).hexdigest()
    (store.root / f"{JOB_ID}.json").write_bytes(
        store_canonical_json_bytes(payload)
    )

    with pytest.raises(ManifestIntegrityError):
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_store_reject_bundle_hash_mismatch_va_path_traversal(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "nesting-manifests")

    broken = replace(production, render_bundle={})
    with pytest.raises(ManifestContractError):
        _persist(store,
            production_request=broken,
            manifest=manifest,
        )
    with pytest.raises(ManifestIdentifierError):
        store.load(
            manifest_id="../" + JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_store_phat_hien_file_bi_sua_sau_publish(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "nesting-manifests")
    stored = _persist(store,
        production_request=production,
        manifest=manifest,
    )
    path = store.root / f"{JOB_ID}.json"
    payload = json.loads(stored.canonical_bytes)
    payload["productionRequest"]["renderBundle"]["parts"][0]["pages"]["front"]["pageIndex"] = 99
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ManifestIntegrityError):
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_version_map_production_co_dung_16_tag() -> None:
    assert set(_versions()) == set(PRODUCTION_ALGORITHM_VERSION_KEYS)
    assert canonical_sha256(_versions()).startswith("sha256:")


def test_render_bundle_v1_reject_thieu_part_source_page_pivot_va_affine_xau() -> None:
    cases: list[tuple[str, dict]] = []

    empty: dict = {}
    cases.append(("bundle rỗng", empty))

    missing_part = _bundle()
    missing_part["parts"].pop()
    cases.append(("thiếu part", missing_part))

    missing_source = _bundle()
    del missing_source["parts"][0]["source"]["contentHash"]
    cases.append(("thiếu source hash", missing_source))

    missing_front = _bundle()
    missing_front["parts"][0]["pages"]["front"] = None
    cases.append(("thiếu front mapping", missing_front))

    client_pivot = _bundle()
    client_pivot["parts"][0]["referencePointMm"] = [0.0, 0.0]
    cases.append(("resolver tự khai pivot", client_pivot))

    footprint_mismatch = _bundle()
    footprint_mismatch["parts"][0]["packingFootprint"]["outer"][0][0] += 1.0
    cases.append(("footprint lệch request", footprint_mismatch))

    mirror_affine = _bundle()
    mirror_affine["parts"][0]["pages"]["front"]["sourcePageToCanonical"] = [
        -1.0,
        0.0,
        0.0,
        1.0,
        210.0,
        0.0,
    ]
    cases.append(("affine mirror", mirror_affine))

    for _name, bundle in cases:
        with pytest.raises(ProductionAdapterError):
            _build(render_bundle=bundle)


@pytest.mark.parametrize("schema_version", [1, 2.0])
def test_render_bundle_production_reject_v1_va_float_v2(schema_version) -> None:
    bundle = _bundle()
    bundle["schemaVersion"] = schema_version
    with pytest.raises(ProductionAdapterError):
        _build(render_bundle=bundle)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("trim", "corners"),
        ("pontsOnCutFile", False),
    ],
)
def test_cnc_reject_context_renderer_bo_qua(field: str, value) -> None:
    bundle = _bundle()
    if field == "trim":
        bundle["marks"]["trim"]["type"] = value
    else:
        bundle["marks"]["cut"][field] = value
    with pytest.raises(ProductionAdapterError):
        _build(render_bundle=bundle)


def test_artifact_options_field_an_khong_lam_doi_canonical_hash() -> None:
    bundle_a = _bundle()
    bundle_a["artifactOptions"] = _enabled_artifact_options(fields=["identifier"])
    bundle_b = copy.deepcopy(bundle_a)
    report_b = bundle_b["artifactOptions"]["report"]
    report_b["labelName"] = "Tên ẩn khác"
    report_b["material"] = "Vật liệu ẩn khác"
    report_b["orderCode"] = "Mã ẩn khác"
    report_b["lamination"] = {"type": "gloss", "sides": 1}

    build_a = _build(render_bundle=bundle_a)
    build_b = _build(render_bundle=bundle_b)

    assert build_a.render_bundle["artifactOptions"] == build_b.render_bundle["artifactOptions"]
    canonical_report = build_a.render_bundle["artifactOptions"]["report"]
    assert canonical_report["labelName"] == ""
    assert canonical_report["material"] == ""
    assert canonical_report["lamination"] == {"type": "none", "sides": 1}
    assert canonical_report["orderCode"] == ""
    assert build_a.render_bundle_hash == build_b.render_bundle_hash
    assert build_a.layout_fingerprint == build_b.layout_fingerprint


def test_artifact_options_thay_doi_hash_va_persist_reload_nguyen_ven(
    tmp_path: Path,
) -> None:
    baseline = _build()
    bundle = _bundle()
    bundle["artifactOptions"] = _enabled_artifact_options(fields=["labelName"])
    bundle["artifactOptions"]["report"]["labelName"] = "  Te\u0302m nha\u0303n  "
    changed = _build(render_bundle=bundle)

    assert changed.render_bundle_hash != baseline.render_bundle_hash
    assert changed.layout_fingerprint != baseline.layout_fingerprint
    assert changed.render_bundle["artifactOptions"]["report"]["labelName"] == "Têm nhãn"

    store = NestingManifestStore(root=tmp_path / "artifact-options-store")
    stored = _persist(
        store,
        production_request=changed,
        manifest=_manifest(changed),
    )
    store.close()
    reopened = NestingManifestStore(root=tmp_path / "artifact-options-store")
    loaded = reopened.load(
        manifest_id=JOB_ID,
        layout_fingerprint=changed.layout_fingerprint,
    )
    assert loaded.render_bundle["artifactOptions"] == changed.render_bundle["artifactOptions"]
    assert loaded.render_bundle_hash == stored.render_bundle_hash


def test_artifact_options_reject_schema_type_enum_va_gia_tri_xau() -> None:
    cases: list[dict] = []

    missing = _bundle()
    del missing["artifactOptions"]
    cases.append(missing)

    extra = _bundle()
    extra["artifactOptions"]["unexpected"] = True
    cases.append(extra)

    non_boolean_export = _bundle()
    non_boolean_export["artifactOptions"]["exportUniqueSheets"] = 1
    cases.append(non_boolean_export)

    cnc_non_unique = _bundle()
    cnc_non_unique["artifactOptions"]["exportUniqueSheets"] = False
    cases.append(cnc_non_unique)

    autofill_non_unique = _bundle()
    autofill_non_unique["flow"]["layoutIntent"] = "autofill_single_sheet"
    autofill_non_unique["artifactOptions"]["exportUniqueSheets"] = False
    request_autofill = _public_request()
    request_autofill["layoutIntent"] = "autofill_single_sheet"
    request_autofill["sheet"]["maxSheets"] = 1
    for part in request_autofill["parts"]:
        part.pop("quantity")
    with pytest.raises(ProductionAdapterError):
        _build(public_request=request_autofill, render_bundle=autofill_non_unique)
    enabled_not_boolean = _bundle()
    enabled_not_boolean["artifactOptions"]["report"] = {"enabled": 1}
    cases.append(enabled_not_boolean)

    disabled_with_stale_payload = _bundle()
    disabled_with_stale_payload["artifactOptions"]["report"] = {
        "enabled": False,
        "labelName": "stale",
    }
    cases.append(disabled_with_stale_payload)

    duplicate_field = _bundle()
    duplicate_field["artifactOptions"] = _enabled_artifact_options(
        fields=["labelName", "labelName"]
    )
    cases.append(duplicate_field)

    unknown_field = _bundle()
    unknown_field["artifactOptions"] = _enabled_artifact_options(fields=["unknown"])
    cases.append(unknown_field)

    bad_lamination = _bundle()
    bad_lamination["artifactOptions"] = _enabled_artifact_options()
    bad_lamination["artifactOptions"]["report"]["lamination"]["type"] = "silk"
    cases.append(bad_lamination)

    bad_sides = _bundle()
    bad_sides["artifactOptions"] = _enabled_artifact_options()
    bad_sides["artifactOptions"]["report"]["lamination"]["sides"] = True
    cases.append(bad_sides)

    bad_position = _bundle()
    bad_position["artifactOptions"] = _enabled_artifact_options()
    bad_position["artifactOptions"]["report"]["placement"]["position"] = "center"
    cases.append(bad_position)

    bad_centered = _bundle()
    bad_centered["artifactOptions"] = _enabled_artifact_options()
    bad_centered["artifactOptions"]["report"]["placement"]["centered"] = 1
    cases.append(bad_centered)

    negative_offset = _bundle()
    negative_offset["artifactOptions"] = _enabled_artifact_options()
    negative_offset["artifactOptions"]["report"]["placement"]["offsetXmm"] = -0.1
    cases.append(negative_offset)

    non_finite_offset = _bundle()
    non_finite_offset["artifactOptions"] = _enabled_artifact_options()
    non_finite_offset["artifactOptions"]["report"]["placement"]["offsetYmm"] = float("nan")
    cases.append(non_finite_offset)
    bad_font = _bundle()
    bad_font["artifactOptions"] = _enabled_artifact_options()
    bad_font["artifactOptions"]["report"]["placement"]["fontSizePt"] = 40.1
    cases.append(bad_font)

    control_text = _bundle()
    control_text["artifactOptions"] = _enabled_artifact_options(fields=["labelName"])
    control_text["artifactOptions"]["report"]["labelName"] = "Tem\nnhãn"
    cases.append(control_text)

    for bundle in cases:
        with pytest.raises(ProductionAdapterError):
            _build(render_bundle=bundle)

def test_store_bat_buoc_exact_source_pin_set(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    pins = _fake_source_pins(production)
    store = NestingManifestStore(root=tmp_path / "strict-source-pins")

    with pytest.raises(TypeError):
        _STRICT_MANIFEST_PERSIST(
            store,
            production_request=production,
            manifest=manifest,
        )

    extra = replace(
        pins[0],
        locator_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        lease_token="c" * 64,
    )
    for invalid_pins in (
        pins[:-1],
        pins + (extra,),
        pins + (pins[0],),
    ):
        with pytest.raises(ManifestContractError):
            _STRICT_MANIFEST_PERSIST(
                store,
                production_request=production,
                manifest=manifest,
                source_pins=invalid_pins,
            )
    assert not store.root.exists()


def test_build_identity_khoa_fingerprint_va_manifest_exact() -> None:
    build_a = _build(native_build_identity="1" * 64)
    build_b = _build(native_build_identity="2" * 64)

    assert build_a.input_hash == build_b.input_hash
    assert build_a.layout_fingerprint != build_b.layout_fingerprint

    manifest_a = _manifest(build_a)
    validate_production_manifest(
        manifest_a,
        build_a.engine_request,
        _capabilities(build_identity="1" * 64),
    )
    with pytest.raises(MixedNestingError):
        validate_production_manifest(
            manifest_a,
            build_a.engine_request,
            _capabilities(build_identity="2" * 64),
        )


@pytest.mark.parametrize(
    "mutator",
    [
        lambda manifest: manifest.update(status="failed"),
        lambda manifest: manifest.update(status="cancelled"),
        lambda manifest: manifest["validation"].update(valid=False),
        lambda manifest: manifest["provenance"].update(
            nativeBuildIdentity="9" * 64
        ),
    ],
)
def test_store_reject_terminal_invalid_hoac_provenance_lech(
    tmp_path: Path, mutator
) -> None:
    production = _build()
    manifest = _manifest(production)
    mutator(manifest)
    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / "manifest-invalid"),
            production_request=production,
            manifest=manifest,
        )


def test_store_dung_lai_identity_va_reject_request_bundle_bi_ghep() -> None:
    production = _build()
    variants: list[ProductionNestingRequest] = []

    engine_pivot = copy.deepcopy(production.engine_request)
    engine_pivot["parts"][0]["referencePointMm"][0] += 1.0
    variants.append(replace(production, engine_request=engine_pivot))

    bundle_source = copy.deepcopy(production.render_bundle)
    bundle_source["parts"][0]["source"]["contentHash"] = "sha256:" + "f" * 64
    variants.append(replace(production, render_bundle=bundle_source))

    bundle_page = copy.deepcopy(production.render_bundle)
    bundle_page["parts"][0]["pages"]["front"]["pageIndex"] += 1
    variants.append(replace(production, render_bundle=bundle_page))

    variants.append(replace(production, input_hash="sha256:" + "f" * 64))
    variants.append(
        replace(production, layout_fingerprint="sha256:" + "e" * 64)
    )

    for variant in variants:
        with pytest.raises(ProductionAdapterError):
            validate_production_request_identity(variant)


def test_load_recompute_identity_du_envelope_da_duoc_bam_lai(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "manifest-rehash")
    stored = _persist(store, production_request=production, manifest=manifest)
    payload = json.loads(stored.canonical_bytes)
    payload["productionRequest"]["renderBundle"]["parts"][0]["source"][
        "revision"
    ] = "source-da-bi-thay"
    body = {key: value for key, value in payload.items() if key != "contentSha256"}
    payload["contentSha256"] = hashlib.sha256(
        store_canonical_json_bytes(body)
    ).hexdigest()
    path = store.root / f"{JOB_ID}.json"
    path.write_bytes(store_canonical_json_bytes(payload))

    with pytest.raises(ManifestIntegrityError):
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_load_reject_production_request_field_la_du_envelope_da_bam_lai(
    tmp_path: Path,
) -> None:
    production = _build()
    store = NestingManifestStore(root=tmp_path / "production-extra-field")
    stored = _persist(store,
        production_request=production,
        manifest=_manifest(production),
    )
    payload = json.loads(stored.canonical_bytes)
    payload["productionRequest"]["fieldLa"] = {"boQuaImLang": True}
    body = {key: value for key, value in payload.items() if key != "contentSha256"}
    payload["contentSha256"] = hashlib.sha256(
        store_canonical_json_bytes(body)
    ).hexdigest()
    (store.root / f"{JOB_ID}.json").write_bytes(
        store_canonical_json_bytes(payload)
    )

    with pytest.raises(ManifestIntegrityError):
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_reload_du_pivot_va_affine_de_dung_lai_ctm(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "manifest-ctm")
    _persist(store, production_request=production, manifest=manifest)
    loaded = store.load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    part = next(
        item for item in loaded.render_bundle["parts"] if item["partId"] == "tem-b"
    )
    placement = next(
        item for item in loaded.manifest["placements"]
        if item["instanceId"] == "tem-b#0001"
    )

    def apply(matrix: list[float], point: tuple[float, float]) -> tuple[float, float]:
        a, b, c, d, e, f = matrix
        return (
            a * point[0] + c * point[1] + e,
            b * point[0] + d * point[1] + f,
        )

    reference = tuple(part["referencePointMm"])
    source_matrix = part["pages"]["front"]["sourcePageToCanonical"]
    source_reference = tuple(part["pages"]["front"]["sourceReferencePointMm"])
    assert apply(source_matrix, source_reference) == pytest.approx(reference)

    pose = placement["pose"]
    radians = math.radians(pose["rotationDeg"])
    cosine, sine = math.cos(radians), math.sin(radians)
    reference_x, reference_y = reference
    geometry_matrix = [
        cosine,
        sine,
        -sine,
        cosine,
        pose["translateXmm"] - cosine * reference_x + sine * reference_y,
        pose["translateYmm"] - sine * reference_x - cosine * reference_y,
    ]
    assert apply(geometry_matrix, reference) == pytest.approx(
        (pose["translateXmm"], pose["translateYmm"])
    )
    assert apply(geometry_matrix, apply(source_matrix, source_reference)) == pytest.approx(
        (pose["translateXmm"], pose["translateYmm"])
    )


def test_publish_no_replace_giua_hai_process(tmp_path: Path) -> None:
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(2)
    result_queue = context.Queue()
    root = tmp_path / "manifest-race"
    processes = [
        context.Process(
            target=_race_store_worker,
            args=(str(root), barrier, result_queue, delta),
        )
        for delta in (0.0, 1.0)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=30)
        assert process.exitcode == 0

    results = [result_queue.get(timeout=5) for _ in processes]
    assert sorted(result[0] for result in results) == ["conflict", "stored"]
    stored_y = next(result[1] for result in results if result[0] == "stored")
    production = _build()
    loaded = NestingManifestStore(root=root).load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    assert loaded.manifest["placements"][0]["pose"]["translateYmm"] == stored_y


@pytest.mark.parametrize(
    "job_id",
    [
        "f" * 31,
        "F" * 32,
        "g" * 32,
        "../" + "f" * 32,
        True,
    ],
)
def test_adapter_reject_job_id_khong_canonical(job_id) -> None:
    with pytest.raises(ProductionAdapterError):
        _build(job_id=job_id)


@pytest.mark.parametrize(
    "case",
    [
        "missing_source_revision",
        "unknown_field",
        "part_binding",
        "noncanonical_instance_id",
        "duplicate_instance_id",
        "wrong_source_revision",
    ],
)
def test_store_reject_placement_schema_instance_va_source(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build()
    manifest = _manifest(production)
    placement = manifest["placements"][0]
    if case == "missing_source_revision":
        placement.pop("sourceRevision")
    elif case == "unknown_field":
        placement["matrix"] = [1, 0, 0, 1, 0, 0]
    elif case == "part_binding":
        placement["partId"] = "tem-b"
    elif case == "noncanonical_instance_id":
        placement["instanceId"] = "tem-a#1"
    elif case == "duplicate_instance_id":
        manifest["placements"][1]["instanceId"] = placement["instanceId"]
    else:
        placement["sourceRevision"] = "sha256:" + "f" * 64

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


@pytest.mark.parametrize(
    "case",
    [
        "missing_field",
        "unknown_field",
        "bool_rotation",
        "negative_rotation",
        "rotation_360",
        "nan_translation",
        "infinite_translation",
        "string_translation",
    ],
)
def test_store_reject_pose_khong_dung_serde(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build()
    manifest = _manifest(production)
    pose = manifest["placements"][0]["pose"]
    if case == "missing_field":
        pose.pop("translateYmm")
    elif case == "unknown_field":
        pose["scale"] = 1.0
    elif case == "bool_rotation":
        pose["rotationDeg"] = True
    elif case == "negative_rotation":
        pose["rotationDeg"] = -0.001
    elif case == "rotation_360":
        pose["rotationDeg"] = 360.0
    elif case == "nan_translation":
        pose["translateXmm"] = float("nan")
    elif case == "infinite_translation":
        pose["translateYmm"] = float("inf")
    else:
        pose["translateXmm"] = "30.0"

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


@pytest.mark.parametrize(
    "case",
    ["bool_index", "negative_index", "out_of_range", "non_contiguous"],
)
def test_store_reject_sheet_index_sai_mien_hoac_co_lo(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build()
    manifest = _manifest(production)
    if case == "bool_index":
        manifest["placements"][0]["sheetIndex"] = True
    elif case == "negative_index":
        manifest["placements"][0]["sheetIndex"] = -1
    elif case == "out_of_range":
        manifest["placements"][0]["sheetIndex"] = 12
    else:
        manifest["placements"][1]["sheetIndex"] = 2
        manifest["stats"]["sheetCount"] = 2

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


def test_store_accept_sheet_indices_lien_tuc_va_dem_distinct(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    for placement in manifest["placements"][3:]:
        placement["sheetIndex"] = 1
    manifest["stats"]["sheetCount"] = 2

    stored = _persist(
        NestingManifestStore(root=tmp_path / "contiguous"),
        production_request=production,
        manifest=manifest,
    )
    assert stored.manifest["stats"]["sheetCount"] == 2


@pytest.mark.parametrize(
    "case",
    [
        "missing_field",
        "unknown_field",
        "bool_count",
        "negative_counter",
        "overflow_counter",
        "nan_utilization",
        "low_utilization",
        "high_utilization",
        "invalid_termination",
        "termination_not_string",
        "placed_mismatch",
        "sheet_mismatch",
    ],
)
def test_store_reject_stats_sai_schema_type_mien_hoac_dem(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build()
    manifest = _manifest(production)
    stats = manifest["stats"]
    if case == "missing_field":
        stats.pop("poseRefinements")
    elif case == "unknown_field":
        stats["workerCount"] = 8
    elif case == "bool_count":
        stats["placedCount"] = True
    elif case == "negative_counter":
        stats["attempts"] = -1
    elif case == "overflow_counter":
        stats["orientationEvaluations"] = 2**64
    elif case == "nan_utilization":
        stats["materialUtilization"] = float("nan")
    elif case == "low_utilization":
        stats["materialUtilization"] = -0.001
    elif case == "high_utilization":
        stats["materialUtilization"] = 1.001
    elif case == "invalid_termination":
        stats["terminationReason"] = "finished"
    elif case == "termination_not_string":
        stats["terminationReason"] = []
    elif case == "placed_mismatch":
        stats["placedCount"] -= 1
    else:
        stats["sheetCount"] = 2

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


def _move_first_to_unplaced(manifest: dict, reason: str) -> dict:
    placement = manifest["placements"].pop(0)
    record = {
        "instanceId": placement["instanceId"],
        "partId": placement["partId"],
        "reason": reason,
    }
    manifest["unplaced"].append(record)
    manifest["stats"]["placedCount"] = len(manifest["placements"])
    manifest["stats"]["unplacedCount"] = len(manifest["unplaced"])
    return record


def test_quantity_reject_thieu_instance_du_stats_da_khop(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    manifest["placements"].pop()
    manifest["stats"]["placedCount"] = len(manifest["placements"])

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / "quantity-missing"),
            production_request=production,
            manifest=manifest,
        )


def test_quantity_reject_unplaced_du_exact_instance_set(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    _move_first_to_unplaced(manifest, "NO_FEASIBLE_POSE")

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / "quantity-unplaced"),
            production_request=production,
            manifest=manifest,
        )


@pytest.mark.parametrize(
    "reason",
    [
        "NO_FEASIBLE_POSE",
        "SEARCH_BUDGET_EXHAUSTED",
        "MAX_SHEETS_REACHED",
        "CANCELLED",
    ],
)
def test_autofill_reject_unplaced_ke_ca_reason_dung_enum_serde(
    tmp_path: Path,
    reason: str,
) -> None:
    production = _build_autofill()
    manifest = _manifest(production)
    _move_first_to_unplaced(manifest, reason)

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / reason),
            production_request=production,
            manifest=manifest,
        )


@pytest.mark.parametrize(
    "case",
    [
        "missing_reason",
        "unknown_field",
        "invalid_reason",
        "reason_not_string",
        "wrong_part_binding",
        "noncanonical_instance_id",
    ],
)
def test_store_reject_unplaced_schema_reason_va_id_binding(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build_autofill()
    manifest = _manifest(production)
    record = _move_first_to_unplaced(manifest, "NO_FEASIBLE_POSE")
    if case == "missing_reason":
        record.pop("reason")
    elif case == "unknown_field":
        record["sourceRevision"] = "khong-duoc-co"
    elif case == "invalid_reason":
        record["reason"] = "NO_SPACE"
    elif case == "reason_not_string":
        record["reason"] = []
    elif case == "wrong_part_binding":
        record["partId"] = "tem-b"
    else:
        record["instanceId"] = "tem-a#1"

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


@pytest.mark.parametrize("case", ["ordinal_gap", "missing_part"])
def test_autofill_reject_ordinal_khong_lien_tuc_hoac_part_rong(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build_autofill()
    manifest = _manifest(production)
    if case == "ordinal_gap":
        manifest["placements"][0]["instanceId"] = "tem-a#0002"
    else:
        manifest["placements"].pop(0)
        manifest["stats"]["placedCount"] = len(manifest["placements"])

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


def test_autofill_accept_ordinal_lien_tuc_tu_mot_cho_moi_part(
    tmp_path: Path,
) -> None:
    production = _build_autofill()
    manifest = _manifest(production)
    second_a = copy.deepcopy(manifest["placements"][0])
    second_a["instanceId"] = "tem-a#0002"
    second_a["pose"]["translateXmm"] += 100.0
    manifest["placements"].append(second_a)
    manifest["stats"]["placedCount"] = len(manifest["placements"])

    stored = _persist(
        NestingManifestStore(root=tmp_path / "autofill-contiguous"),
        production_request=production,
        manifest=manifest,
    )
    assert {item["instanceId"] for item in stored.manifest["placements"]} == {
        "tem-a#0001",
        "tem-a#0002",
        "tem-b#0001",
    }


@pytest.mark.parametrize(
    "case",
    [
        "root_missing",
        "root_unknown",
        "validation_unknown",
        "provenance_unknown",
        "search_unknown",
        "budget_unknown",
        "score_unknown",
        "candidate_unknown",
    ],
)
def test_store_reject_manifest_root_va_nested_field_khong_dung_serde(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build()
    manifest = _manifest(production)
    if case == "root_missing":
        manifest.pop("search")
    elif case == "root_unknown":
        manifest["debug"] = True
    elif case == "validation_unknown":
        manifest["validation"]["issues"] = []
    elif case == "provenance_unknown":
        manifest["provenance"]["buildDate"] = "2026-08-28"
    elif case == "search_unknown":
        manifest["search"]["workerCount"] = 8
    elif case == "budget_unknown":
        manifest["search"]["budget"]["angleStepDeg"] = 1.0
    elif case == "score_unknown":
        manifest["search"]["selectedScore"]["materialUtilization"] = 0.5
    else:
        manifest["search"]["selectedCandidate"]["trialId"] = 1

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


@pytest.mark.parametrize(
    "case",
    [
        "validation_bool",
        "provenance_uint",
        "trials_uint",
        "budget_uint",
        "score_i64",
        "candidate_kind",
        "smart_trial_missing_id",
        "smart_trial_bool_id",
    ],
)
def test_store_reject_manifest_nested_type_khong_dung_serde(
    tmp_path: Path,
    case: str,
) -> None:
    production = _build()
    manifest = _manifest(production)
    if case == "validation_bool":
        manifest["validation"]["valid"] = 1
    elif case == "provenance_uint":
        manifest["provenance"]["solverVersion"] = -1
    elif case == "trials_uint":
        manifest["search"]["trialsRun"] = True
    elif case == "budget_uint":
        manifest["search"]["budget"]["beamWidth"] = -1
    elif case == "score_i64":
        manifest["search"]["selectedScore"]["lastSheetUsedAreaFixed"] = 2**63
    elif case == "candidate_kind":
        manifest["search"]["selectedCandidate"] = {"kind": "fallback"}
    elif case == "smart_trial_missing_id":
        manifest["search"]["selectedCandidate"] = {"kind": "smart_trial"}
    else:
        manifest["search"]["selectedCandidate"] = {
            "kind": "smart_trial",
            "trialId": True,
        }

    with pytest.raises(ManifestContractError):
        _persist(
            NestingManifestStore(root=tmp_path / case),
            production_request=production,
            manifest=manifest,
        )


def test_store_accept_search_optional_va_smart_trial_dung_serde(tmp_path: Path) -> None:
    production = _build()
    manifest = _manifest(production)
    manifest["search"]["budget"]["timeBudgetMs"] = 5000
    manifest["search"]["selectedCandidate"] = {
        "kind": "smart_trial",
        "trialId": 0,
    }
    manifest["search"]["baselineScore"] = copy.deepcopy(
        manifest["search"]["selectedScore"]
    )

    stored = _persist(
        NestingManifestStore(root=tmp_path / "smart-trial"),
        production_request=production,
        manifest=manifest,
    )
    assert stored.manifest["search"]["selectedCandidate"] == {
        "kind": "smart_trial",
        "trialId": 0,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  cutStyle qua vòng đời manifest (Lô A1, audit 2026-08-28 §A1.1)
# ─────────────────────────────────────────────────────────────────────────────


def test_cut_style_song_sot_qua_persist_va_load_lai_nguyen_byte(tmp_path: Path) -> None:
    """Writer sau restart phải nhận đúng tiêu chí nét bế đã chốt lúc solve."""

    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "cutstyle-roundtrip")
    stored = _persist(store, production_request=production, manifest=manifest)

    payload = json.loads(stored.canonical_bytes)
    persisted_style = payload["productionRequest"]["renderBundle"]["cutStyle"]
    assert persisted_style == _cut_style()

    loaded = store.load(
        manifest_id=JOB_ID,
        layout_fingerprint=production.layout_fingerprint,
    )
    reloaded = json.loads(loaded.canonical_bytes)
    # Byte-identical: không có bước "dựng lại mặc định" nào được xen vào.
    assert (
        reloaded["productionRequest"]["renderBundle"]["cutStyle"] == persisted_style
    )


def test_cut_style_doi_thi_input_hash_va_fingerprint_doi_theo() -> None:
    """Đổi tiêu chí nét bế là đổi input; manifest cũ phải thành stale."""

    base = _build()
    changed_names = _bundle()
    changed_names["cutStyle"]["sourceFilter"]["spotNames"] = ["die-line"]
    by_names = _build(render_bundle=changed_names)

    changed_stroke = _bundle()
    changed_stroke["cutStyle"]["stroke"]["widthMm"] = 0.5
    by_stroke = _build(render_bundle=changed_stroke)

    assert base.render_bundle_hash != by_names.render_bundle_hash
    assert base.render_bundle_hash != by_stroke.render_bundle_hash
    assert base.input_hash != by_names.input_hash
    assert base.input_hash != by_stroke.input_hash
    assert base.layout_fingerprint != by_names.layout_fingerprint
    assert base.layout_fingerprint != by_stroke.layout_fingerprint


def test_cut_style_bi_sua_tren_dia_thi_load_fail_closed(tmp_path: Path) -> None:
    """Sửa cutStyle sau publish phải bị phát hiện, không được render tiếp."""

    production = _build()
    manifest = _manifest(production)
    store = NestingManifestStore(root=tmp_path / "cutstyle-tamper")
    stored = _persist(store, production_request=production, manifest=manifest)

    path = store.root / f"{JOB_ID}.json"
    payload = json.loads(stored.canonical_bytes)
    payload["productionRequest"]["renderBundle"]["cutStyle"]["stroke"][
        "widthMm"
    ] = 1.5
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ManifestIntegrityError):
        store.load(
            manifest_id=JOB_ID,
            layout_fingerprint=production.layout_fingerprint,
        )


def test_cut_style_khong_hop_le_thi_identity_bi_tu_choi() -> None:
    """Bundle ghép tay với cutStyle sai phải fail ở bước dựng lại identity."""

    production = _build()
    variants: list[ProductionNestingRequest] = []

    missing = copy.deepcopy(production.render_bundle)
    missing.pop("cutStyle")
    variants.append(replace(production, render_bundle=missing))

    unknown_field = copy.deepcopy(production.render_bundle)
    unknown_field["cutStyle"]["sourceFilter"]["extra"] = 1
    variants.append(replace(production, render_bundle=unknown_field))

    bad_mode = copy.deepcopy(production.render_bundle)
    bad_mode["cutStyle"]["sourceFilter"]["mode"] = "layer"
    variants.append(replace(production, render_bundle=bad_mode))

    bad_arity = copy.deepcopy(production.render_bundle)
    bad_arity["cutStyle"]["stroke"]["components"] = [0.0, 1.0]
    variants.append(replace(production, render_bundle=bad_arity))

    bool_width = copy.deepcopy(production.render_bundle)
    bool_width["cutStyle"]["stroke"]["widthMm"] = True
    variants.append(replace(production, render_bundle=bool_width))

    for variant in variants:
        with pytest.raises(ProductionAdapterError):
            validate_production_request_identity(variant)


def test_cut_style_simplex_va_cnc_duplex_doc_lap() -> None:
    """Đổi duplex không được kéo theo thay đổi ngầm nào trong cutStyle."""

    duplex = _build()
    assert duplex.render_bundle["duplex"]["mode"] == "duplex"

    simplex_bundle = _bundle()
    simplex_bundle["outputSides"] = ["front", "cut"]
    simplex_bundle["duplex"] = {
        "mode": "simplex",
        "flipEdge": "none",
        "physicalAxis": "none",
    }
    simplex_bundle["marks"]["duplexRegistration"] = False
    simplex_bundle["sheetFrames"]["back"] = None
    for part in simplex_bundle["parts"]:
        part["pages"]["back"] = None
    simplex = _build(render_bundle=simplex_bundle)

    assert simplex.render_bundle["duplex"]["mode"] == "simplex"
    assert simplex.render_bundle["cutStyle"] == duplex.render_bundle["cutStyle"]
    # Nhưng identity vẫn phải khác vì duplex là đầu vào khác.
    assert simplex.render_bundle_hash != duplex.render_bundle_hash


# ─────────────────────────────────────────────────────────────────────────────
#  Miền xoay server-owned + cổng rollout (Lô A2, audit 2026-08-28 §A2.1)
# ─────────────────────────────────────────────────────────────────────────────


def _rotation(default_rotation: dict) -> dict:
    return {"defaultRotation": default_rotation, "reflection": "forbidden"}


def test_rotation_policy_den_tu_callsite_chu_khong_ghi_cung() -> None:
    """Callsite quyết định miền xoay; hai chỗ dùng cùng MỘT object canonical."""

    policy = _rotation({"mode": "discrete", "anglesDeg": [0.0, 180.0]})
    production = _build(rotation_policy=policy)
    assert production.engine_request["orientationPolicy"] == {
        "defaultRotation": {"mode": "discrete", "anglesDeg": [0.0, 180.0]},
        "reflection": "forbidden",
    }
    # Đổi miền xoay là đổi input: identity phải đổi theo, manifest cũ thành stale.
    baseline = _build()
    assert production.input_hash != baseline.input_hash
    assert production.layout_fingerprint != baseline.layout_fingerprint
    assert production.solver_config_hash != baseline.solver_config_hash


def test_rotation_policy_khong_the_lech_giua_solver_config_va_engine() -> None:
    """solverConfigHash và engine_request phải nói cùng một miền xoay.

    Nếu hai chỗ dựng riêng thì hash có thể khớp trong khi engine chạy miền khác —
    loại lệch im lặng không test nào bắt được sau này.
    """

    policy = _rotation({"mode": "fixed", "angleDeg": 90.0})
    production = _build(rotation_policy=policy)
    engine_policy = production.engine_request["orientationPolicy"]
    assert engine_policy["defaultRotation"] == {"mode": "fixed", "angleDeg": 90.0}
    # Dựng lại solverConfigHash từ chính engine_request phải cho đúng hash đã ghim.
    solver_config = {
        "seed": production.engine_request["seed"],
        "profile": production.engine_request["profile"],
        "layoutIntent": production.engine_request["layoutIntent"],
        "maxSheets": production.engine_request["sheet"]["maxSheets"],
        "orientationPolicy": engine_policy,
    }
    if "timeBudgetMs" in production.engine_request:
        solver_config["timeBudgetMs"] = production.engine_request["timeBudgetMs"]
    assert canonical_sha256(solver_config) == production.solver_config_hash


@pytest.mark.parametrize("mode", ["free", "ranges"])
def test_cong_rollout_dong_mien_goc_lien_tuc(mode) -> None:
    """Chặng A: free và ranges bị chặn cứng, phải nói rõ vì sao và dùng gì thay."""

    policy = _rotation(
        {"mode": "free"}
        if mode == "free"
        else {"mode": "ranges", "arcs": [{"startDeg": 0.0, "sweepDeg": 45.0}]}
    )
    with pytest.raises(ProductionAdapterError, match="miền góc liên tục"):
        _build(rotation_policy=policy)
    # Mở cổng tường minh thì đi qua được — đây là đường dùng sau Cổng Chặng B.
    production = _build(rotation_policy=policy, allow_continuous_rotation=True)
    assert production.engine_request["orientationPolicy"]["defaultRotation"]["mode"] == mode


def test_cong_rollout_khong_chan_mien_goc_huu_han() -> None:
    for default_rotation in (
        {"mode": "fixed", "angleDeg": 0.0},
        {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]},
    ):
        production = _build(rotation_policy=_rotation(default_rotation))
        assert (
            production.engine_request["orientationPolicy"]["defaultRotation"]
            == default_rotation
        )


def test_rotation_policy_chuan_hoa_goc_va_thu_tu() -> None:
    """Góc lượng tử 6 chữ số, sắp tăng dần; arcs sắp theo byte canonical."""

    production = _build(
        rotation_policy=_rotation(
            {"mode": "discrete", "anglesDeg": [270.0, 0.0000004, 90.0, 180.0]}
        )
    )
    assert production.engine_request["orientationPolicy"]["defaultRotation"] == {
        "mode": "discrete",
        "anglesDeg": [0.0, 90.0, 180.0, 270.0],
    }
    # Cùng tập góc khác thứ tự ⇒ cùng identity.
    same = _build(
        rotation_policy=_rotation(
            {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]}
        )
    )
    assert production.input_hash == same.input_hash


@pytest.mark.parametrize(
    "policy,match",
    [
        ("khong-phai-object", "phải là object"),
        ({"defaultRotation": {"mode": "fixed", "angleDeg": 0.0}}, "thiếu reflection"),
        (
            {
                "defaultRotation": {"mode": "fixed", "angleDeg": 0.0},
                "reflection": "allowed",
            },
            "chỉ được là 'forbidden'",
        ),
        (
            {
                "defaultRotation": {"mode": "fixed", "angleDeg": 0.0},
                "reflection": "forbidden",
                "extra": 1,
            },
            "field lạ extra",
        ),
        (_rotation({"mode": "inherit"}), "chỉ hợp lệ ở cấp chi tiết"),
        (_rotation({"mode": "cardinal"}), "mode không được hỗ trợ"),
        (_rotation({"mode": "fixed"}), "thiếu angleDeg"),
        (
            _rotation({"mode": "free", "anglesDeg": [0.0]}),
            "field lạ anglesDeg",
        ),
        (
            _rotation({"mode": "fixed", "angleDeg": 360.0}),
            r"canonical trong \[0, 360\)",
        ),
        (
            _rotation({"mode": "fixed", "angleDeg": -1.0}),
            r"canonical trong \[0, 360\)",
        ),
        (_rotation({"mode": "fixed", "angleDeg": True}), "phải là số hữu hạn"),
        (
            _rotation({"mode": "fixed", "angleDeg": float("nan")}),
            "số hữu hạn|chuẩn hoá",
        ),
        (
            _rotation({"mode": "fixed", "angleDeg": float("inf")}),
            "số hữu hạn|chuẩn hoá",
        ),
        (_rotation({"mode": "discrete", "anglesDeg": []}), "không được rỗng"),
        (
            _rotation({"mode": "discrete", "anglesDeg": [0.0, 0.0]}),
            "không được trùng góc",
        ),
        (
            _rotation({"mode": "discrete", "anglesDeg": "0"}),
            "phải là mảng số",
        ),
        (
            _rotation({"mode": "discrete", "anglesDeg": [0.0] * 4097}),
            "vượt giới hạn 4096",
        ),
        (_rotation({"mode": "ranges", "arcs": []}), "không được rỗng"),
        (
            _rotation({"mode": "ranges", "arcs": [{"startDeg": 0.0, "sweepDeg": 0.0}]}),
            r"thuộc khoảng \(0, 360\]",
        ),
        (
            _rotation(
                {"mode": "ranges", "arcs": [{"startDeg": 0.0, "sweepDeg": 361.0}]}
            ),
            r"thuộc khoảng \(0, 360\]",
        ),
        (
            _rotation({"mode": "ranges", "arcs": [{"startDeg": 0.0}]}),
            "thiếu sweepDeg",
        ),
    ],
)
def test_rotation_policy_sai_hop_dong_bi_tu_choi(policy, match) -> None:
    with pytest.raises(ProductionAdapterError, match=match):
        _build(rotation_policy=policy, allow_continuous_rotation=True)


def test_allow_continuous_rotation_phai_la_boolean() -> None:
    with pytest.raises(ProductionAdapterError, match="phải là boolean"):
        _build(allow_continuous_rotation=1)


def test_client_gui_orientation_policy_van_bi_bo_qua() -> None:
    """Client không được nới miền xoay bằng payload — kể cả khi gửi free."""

    request = _public_request()
    request["orientationPolicy"] = _rotation({"mode": "free"})
    production = _build(public_request=request)
    assert production.engine_request["orientationPolicy"]["defaultRotation"] == {
        "mode": "discrete",
        "anglesDeg": [0.0, 90.0, 180.0, 270.0],
    }


def test_client_gui_gap_mm_van_bi_bo_qua_va_clearance_la_nguon_that() -> None:
    """gapMm client bị bỏ; gapX/gapY đi qua clearance.partToPart.

    Rust trả LEGACY_GAP_WITH_PRODUCTION_CONTRACT nếu engine_request.gapMm != 0 khi
    đã có productionContract, nên `gapMm: 0.0` là bắt buộc chứ không phải bỏ sót.
    """

    request = _public_request()
    request["gapMm"] = 4.0
    production = _build(public_request=request)
    assert production.engine_request["gapMm"] == 0.0

    contract = production.engine_request["productionContract"]
    assert contract["clearance"]["partToPart"] == {"xMm": 2.0, "yMm": 3.0}
    assert contract["clearance"]["partToObstacle"] == {"xMm": 4.0, "yMm": 5.0}

    # Đổi riêng trục X của clearance phải đổi identity: gap dị hướng là dữ liệu
    # thật, không bị nén về một số vô hướng.
    other = _clearance()
    other["partToPart"]["xMm"] = 2.5
    assert _build(clearance=other).input_hash != production.input_hash


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


@requires_engine
def test_request_production_that_duoc_native_chap_nhan_va_ton_trong_cardinal() -> None:
    """Đẩy request production THẬT qua native thật, không dùng handle giả.

    NEST (audit 2026-08-28 §A2.1): trước lô này không có test nào nối
    ``build_production_request`` với native thật — mọi test vòng đời đều dùng
    handle giả. Nghĩa là một lệch giữa canonicalization phía Python và
    ``deny_unknown_fields``/tagged enum phía Rust sẽ chỉ lộ ra ở runtime.

    Test này khoá ba điều: native nhận được request, validator nói hợp lệ, và
    mọi góc trong manifest đều nằm trong tập cardinal đã khai.
    """

    from app.core.mixed_nesting_service import create_run

    handle = create_run()
    capabilities = handle.capabilities
    production = _build(
        algorithm_versions=capabilities.require_production_versions(),
        native_build_identity=capabilities.native_build_identity,
    )
    assert production.engine_request["orientationPolicy"]["defaultRotation"] == {
        "mode": "discrete",
        "anglesDeg": [0.0, 90.0, 180.0, 270.0],
    }

    manifest = handle.solve_production(production.engine_request)

    assert manifest["status"] == "completed"
    assert manifest["validation"]["valid"] is True
    assert manifest["placements"]
    # Miền xoay đã khai phải được tôn trọng trong từng pose thật.
    for placement in manifest["placements"]:
        assert placement["pose"]["rotationDeg"] in (0.0, 90.0, 180.0, 270.0)
    # Provenance phải nói rõ phương án đến từ đâu, không phải boolean fallback.
    assert manifest["search"]["selectedCandidate"]["kind"] in {"baseline", "smart_trial"}


@requires_engine
def test_native_tu_choi_gap_mm_khac_khong_khi_co_production_contract() -> None:
    """Chứng minh `gapMm: 0.0` là bắt buộc, không phải bỏ sót của adapter."""

    from app.core.mixed_nesting_service import MixedNestingError, create_run

    handle = create_run()
    capabilities = handle.capabilities
    production = _build(
        algorithm_versions=capabilities.require_production_versions(),
        native_build_identity=capabilities.native_build_identity,
    )
    tampered = copy.deepcopy(production.engine_request)
    tampered["gapMm"] = 4.0
    with pytest.raises((MixedNestingError, ValueError)) as excinfo:
        handle.solve_production(tampered)
    assert "GAP" in str(excinfo.value).upper() or "gap" in str(excinfo.value)


def test_report_requested_quantity_sr_canonical_hash_va_exact_schema() -> None:
    """Adapter giữ demand S&R khi text phụ thuộc, nhưng strip khi field bị ẩn."""

    def build(*, fields: list[str], requested_qty) -> ProductionNestingRequest:
        request = _public_request()
        request["layoutIntent"] = "step_repeat_single_sheet"
        request["sheet"]["maxSheets"] = 1
        request["parts"] = [request["parts"][0]]
        request["parts"][0].pop("quantity")

        bundle = _bundle()
        bundle["flow"]["taskMode"] = "step_repeat"
        bundle["flow"]["layoutIntent"] = "step_repeat_single_sheet"
        bundle["parts"] = [
            part for part in bundle["parts"]
            if part["partId"] == request["parts"][0]["partId"]
        ]
        bundle["artifactOptions"] = _enabled_artifact_options(fields=fields)
        bundle["artifactOptions"]["report"]["requestedQty"] = requested_qty
        return _build(public_request=request, render_bundle=bundle)

    visible_17 = build(fields=["sheetCount"], requested_qty=17)
    visible_18 = build(fields=["sheetCount"], requested_qty=18)
    assert visible_17.render_bundle["artifactOptions"]["report"]["requestedQty"] == 17
    assert visible_17.render_bundle_hash != visible_18.render_bundle_hash

    hidden_17 = build(fields=["labelName"], requested_qty=17)
    hidden_18 = build(fields=["labelName"], requested_qty=18)
    assert hidden_17.render_bundle["artifactOptions"]["report"]["requestedQty"] is None
    assert hidden_17.render_bundle_hash == hidden_18.render_bundle_hash

    with pytest.raises(ProductionAdapterError, match="số nguyên dương"):
        build(fields=["sheetCount"], requested_qty="17")

    missing = _bundle()
    missing["artifactOptions"] = _enabled_artifact_options(fields=["sheetCount"])
    del missing["artifactOptions"]["report"]["requestedQty"]
    with pytest.raises(ProductionAdapterError, match="requestedQty"):
        _build(render_bundle=missing)

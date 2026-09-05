from __future__ import annotations

import hashlib
import json
import os
from types import SimpleNamespace

from app.core.nesting_debug_trace import (
    TRACE_ENABLED_ENV,
    TRACE_PATH_ENV,
    contour_envelope_summary,
    manifest_trace_summary,
    nfp_diagnostics_summary,
    native_runtime_summary,
    nesting_trace_enabled,
    production_identity_summary,
    summarize_finishing_settings,
    summarize_quantities,
    trace_nesting_event,
)


def test_trace_ghi_jsonl_tai_duong_dan_cau_hinh(tmp_path, monkeypatch):
    from app.config import settings

    trace_path = tmp_path / "logs" / "nesting_trace.jsonl"
    monkeypatch.setattr(settings, "DEV_MODE", True)
    monkeypatch.setenv(TRACE_PATH_ENV, str(trace_path))
    monkeypatch.setenv(TRACE_ENABLED_ENV, "1")

    returned = trace_nesting_event(
        "preview.request",
        trace_id="trace-1",
        request_id="request-1",
        job_id="job-1",
        note="tiếng Việt",
    )

    assert returned == trace_path
    lines = trace_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["event"] == "preview.request"
    assert payload["traceId"] == "trace-1"
    assert payload["requestId"] == "request-1"
    assert payload["jobId"] == "job-1"
    assert payload["note"] == "tiếng Việt"
    assert payload["pid"] == os.getpid()
    assert payload["timestamp"].endswith("Z")


def test_trace_tat_bang_env_khong_tao_file(tmp_path, monkeypatch):
    from app.config import settings

    trace_path = tmp_path / "nesting_trace.jsonl"
    monkeypatch.setattr(settings, "DEV_MODE", True)
    monkeypatch.setenv(TRACE_PATH_ENV, str(trace_path))
    monkeypatch.setenv(TRACE_ENABLED_ENV, "0")

    assert trace_nesting_event("preview.request") == trace_path
    assert not trace_path.exists()


def test_test_suite_mac_dinh_khong_ghi_trace(monkeypatch):
    monkeypatch.delenv(TRACE_ENABLED_ENV, raising=False)

    assert nesting_trace_enabled() is False


def test_trace_dung_append_khi_dat_tran(tmp_path, monkeypatch):
    from app.core import nesting_debug_trace as module

    trace_path = tmp_path / "nesting_trace.jsonl"
    trace_path.write_text("du-lieu-cu\n", encoding="utf-8")
    monkeypatch.setenv(TRACE_PATH_ENV, str(trace_path))
    monkeypatch.setenv(TRACE_ENABLED_ENV, "1")
    monkeypatch.setattr(module, "MAX_TRACE_BYTES", 1)

    trace_nesting_event("preview.request")

    assert trace_path.read_text(encoding="utf-8") == "du-lieu-cu\n"


def test_tom_tat_manifest_goc_xoay_va_khoang_trong_tam():
    manifest = {
        "manifestId": "a" * 32,
        "layoutFingerprint": "sha256:" + "b" * 64,
        "placements": [
            {"sheetIndex": 0, "pose": {"rotationDeg": 0}},
            {"sheetIndex": 0, "pose": {"rotationDeg": 90}},
            {"sheetIndex": 1, "pose": {"rotationDeg": 0}},
        ],
        "search": {
            "selectedCandidate": {"kind": "baseline"},
            "trialsRun": 2,
            "trialsRejected": 1,
            "budget": {"trialCount": 4, "evaluationBudget": 1000},
            "baselineScore": {"sheetCount": 3, "scoreVersion": 2},
            "selectedScore": {"sheetCount": 2, "scoreVersion": 2},
        },
        "stats": {
            "placedCount": 3,
            "sheetCount": 2,
            "terminationReason": "deadline",
            "elapsedMs": 1234,
            "attempts": 12,
            "orientationEvaluations": 34,
            "poseRefinements": 56,
        },
        "validation": {"valid": True},
        "provenance": {"nativeBuildIdentity": "c" * 64},
    }

    summary = manifest_trace_summary(manifest)
    assert summary["capacity"] == 3
    assert summary["rotationHistogram"] == {"0": 2, "90": 1}
    assert summary["sheet0RotationHistogram"] == {"0": 1, "90": 1}
    assert summary["selectedCandidate"] == "baseline"
    assert summary["trialsRun"] == 2
    assert summary["trialsRejected"] == 1
    assert summary["searchBudget"]["evaluationBudget"] == 1000
    assert summary["baselineScore"]["sheetCount"] == 3
    assert summary["selectedScore"]["sheetCount"] == 2
    assert summary["attempts"] == 12
    assert summary["orientationEvaluations"] == 34
    assert summary["poseRefinements"] == 56
    assert summary["validationValid"] is True
    assert summary["manifestNativeBuildIdentity"] == "c" * 64

    diagnostics = nfp_diagnostics_summary(
        {
            "baseline": {
                "cacheHits": 2,
                "cacheMisses": 3,
                "nfpBuildTimeUs": 400,
                "prewarmBatches": 2,
                "prewarmTasks": 11,
                "prewarmPeakWorkers": 4,
                "prewarmWallTimeUs": 350,
                "fieldNgoaiHopDong": "bo qua",
            },
            "search": {"differenceCalls": 5, "differenceTimeUs": 900},
        }
    )
    assert diagnostics == {
        "baseline": {
            "feasibleRegionCalls": None,
            "interruptedCalls": None,
            "blockersConsidered": None,
            "bboxRejects": None,
            "blockerRingsGenerated": None,
            "cacheHits": 2,
            "cacheMisses": 3,
            "cacheEntriesBuilt": None,
            "cacheInsertSkipped": None,
            "cachePeakEstimatedBytes": None,
            "nfpBuildTimeUs": 400,
            "differenceCalls": None,
            "differenceTimeUs": None,
            "prewarmBatches": 2,
            "prewarmTasks": 11,
            "prewarmPeakWorkers": 4,
            "prewarmWallTimeUs": 350,
        },
        "search": {
            "feasibleRegionCalls": None,
            "interruptedCalls": None,
            "blockersConsidered": None,
            "bboxRejects": None,
            "blockerRingsGenerated": None,
            "cacheHits": None,
            "cacheMisses": None,
            "cacheEntriesBuilt": None,
            "cacheInsertSkipped": None,
            "cachePeakEstimatedBytes": None,
            "nfpBuildTimeUs": None,
            "differenceCalls": 5,
            "differenceTimeUs": 900,
            "prewarmBatches": None,
            "prewarmTasks": None,
            "prewarmPeakWorkers": None,
            "prewarmWallTimeUs": None,
        },
    }
    assert nfp_diagnostics_summary({"baseline": "invalid"}) is None

    envelope = contour_envelope_summary(
        [[[10, 20], [30, 20], [30, 60], [10, 60]]],
        sheet_width_mm=100,
        sheet_height_mm=120,
        margins_mm={"left": 5, "right": 5, "bottom": 5, "top": 5},
    )
    assert envelope is not None
    assert envelope["freeSpaceMm"] == {
        "left": 5.0,
        "right": 65.0,
        "bottom": 15.0,
        "top": 55.0,
    }
    assert envelope["shiftToCenterMm"] == {"x": 30.0, "y": 20.0}


def test_tom_tat_finishing_khong_ghi_noi_dung_don_hang():
    settings = {
        "align": "center",
        "pontType": "corner",
        "pontConfig": {
            "shape": "circle",
            "size": 5,
            "disableCollision": False,
            "marginTop": 7,
        },
        "cutType": "default",
        "reportDisplay": {
            "enabled": True,
            "placement": "bottom",
            "fieldOrder": ["orderCode", "labelName"],
            "orderCode": "DON-HANG-NHAY-CAM",
            "labelName": "TEN-KHACH-NHAY-CAM",
        },
    }

    summary = summarize_finishing_settings(settings)
    encoded = json.dumps(summary, ensure_ascii=False)
    assert summary["pont"]["type"] == "corner"
    assert summary["artifact"]["report"] == {
        "enabled": True,
        "placement": "bottom",
        "fieldCount": 2,
    }
    assert "DON-HANG-NHAY-CAM" not in encoded
    assert "TEN-KHACH-NHAY-CAM" not in encoded


def test_quantity_chi_ghi_tong_khong_dump_map():
    assert summarize_quantities({"0": 45, "1": 0, "999": "5"}) == {
        "pageCount": 3,
        "nonZeroPageCount": 2,
        "total": 50,
    }


def _production(**overrides):
    values = {
        "engine_request": {"b": 2, "a": {"z": 9, "x": 7}},
        "input_hash": "sha256:" + "1" * 64,
        "solver_config_hash": "sha256:" + "2" * 64,
        "geometry_constraints_hash": "sha256:" + "3" * 64,
        "render_bundle_hash": "sha256:" + "4" * 64,
        "layout_fingerprint": "sha256:" + "5" * 64,
        "native_build_identity": "6" * 64,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_identity_production_bam_canonical_va_khong_lo_payload_nhay_cam():
    sentinel = r"D:\\DON_HANG\\KHACH_HANG_NHAY_CAM.pdf"
    first = _production(
        engine_request={"b": 2, "a": {"z": 9, "x": 7}, "private": sentinel}
    )
    reordered = _production(
        engine_request={"private": sentinel, "a": {"x": 7, "z": 9}, "b": 2}
    )

    one = production_identity_summary(first)
    two = production_identity_summary(reordered)

    assert one == two
    assert one["inputHash"] == first.input_hash
    assert one["renderBundleHash"] == first.render_bundle_hash
    assert one["nativeBuildIdentity"] == first.native_build_identity
    assert sentinel not in json.dumps(one)

    changed_request = production_identity_summary(
        _production(engine_request={"a": 99})
    )
    assert (
        changed_request["canonicalEngineRequestHash"]
        != one["canonicalEngineRequestHash"]
    )
    changed_bundle = production_identity_summary(
        _production(render_bundle_hash="sha256:" + "f" * 64)
    )
    assert changed_bundle["renderBundleHash"] != one["renderBundleHash"]


def test_native_runtime_chi_tra_hash_va_cache_doi_khi_binary_doi(
    tmp_path, monkeypatch
):
    from app.core import nesting_debug_trace as module

    binary = tmp_path / "pdfcompare_native.pyd"
    binary.write_bytes(b"native-build-a")
    sentinel_path = str(binary)
    monkeypatch.setattr(module, "_NATIVE_RUNTIME_CACHE", None)
    monkeypatch.setattr(
        module.importlib,
        "import_module",
        lambda _name: SimpleNamespace(__file__=sentinel_path),
    )

    first = native_runtime_summary()
    assert first == {
        "nativePydSha256": "sha256:" + hashlib.sha256(b"native-build-a").hexdigest()
    }
    assert sentinel_path not in json.dumps(first)

    binary.write_bytes(b"native-build-b-longer")
    second = native_runtime_summary()
    assert second == {
        "nativePydSha256": "sha256:"
        + hashlib.sha256(b"native-build-b-longer").hexdigest()
    }
    assert second != first

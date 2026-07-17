"""Test API router (task 11.1). Requirements: 6.2, 7.1.

Dùng TestClient cô lập trên một app tạm CHỈ gắn router cut_export — không đụng app thật.
"""

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.workers.cut_export.api import router
from app.core.license_guard import require_license


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_license] = lambda: True
    return TestClient(app)


def test_list_profiles():
    r = _client().get("/imposition/cut-profiles")
    assert r.status_code == 200
    ids = [p["id"] for p in r.json()["profiles"]]
    assert "yuty_a3_max" in ids and "generic_hpgl" in ids


def test_connection_test_rejects_empty_host():
    r = _client().post("/imposition/cut-connection-test", json={"host": "", "port": 9100})
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "IP" in r.json()["error"]


def test_cut_export_to_file(tmp_path):
    body = {
        "profile_id": "generic_hpgl",
        "sheet_w_mm": 100, "sheet_h_mm": 200,
        "paths": [[[10, 10], [20, 10], [20, 20], [10, 20]]],
        "transport_kind": "file",
        "dest_dir": str(tmp_path),
        "name": "apijob",
    }
    r = _client().post("/imposition/cut-export", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["detail"].endswith(".plt")
    assert data["total_items"] == 1


def test_cut_export_unknown_profile():
    body = {"profile_id": "nope", "sheet_w_mm": 10, "sheet_h_mm": 10, "paths": [[[0, 0], [1, 1]]]}
    r = _client().post("/imposition/cut-export", json=body)
    assert r.json()["ok"] is False


def test_cut_export_empty_paths_error(tmp_path):
    body = {"profile_id": "generic_hpgl", "sheet_w_mm": 10, "sheet_h_mm": 10,
            "paths": [], "dest_dir": str(tmp_path)}
    r = _client().post("/imposition/cut-export", json=body)
    assert r.json()["ok"] is False


# ── /cut-export-from-file ────────────────────────────────

import os as _os
_CUT_FIXTURE = _os.path.join(_os.path.dirname(__file__), "fixtures", "corel_cut_sample.pdf")


def test_cut_export_from_file_ok(tmp_path):
    pytest.importorskip("pikepdf")
    body = {
        "path": _CUT_FIXTURE,
        "profile_id": "generic_hpgl",
        "transport_kind": "file",
        "dest_dir": str(tmp_path),
        "name": "fromfile",
    }
    r = _client().post("/imposition/cut-export-from-file", json=body)
    data = r.json()
    assert data["ok"] is True
    assert data["total_items"] == 75  # 75 con tem trên lớp cắt thật
    assert data["detail"].endswith(".plt")


def test_cut_preview_from_file_ok():
    pytest.importorskip("pikepdf")
    r = _client().post("/imposition/cut-preview-from-file",
                       json={"path": _CUT_FIXTURE, "page_idx": 0})
    data = r.json()
    assert data["ok"] is True
    assert data["total_items"] == 75
    assert "<svg" in data["svg"]


def test_cut_export_from_file_missing():
    r = _client().post("/imposition/cut-export-from-file",
                       json={"path": "C:/nope/none.pdf", "profile_id": "generic_hpgl"})
    assert r.json()["ok"] is False


def test_cut_export_from_file_non_pdf(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("hi", encoding="utf-8")
    r = _client().post("/imposition/cut-export-from-file",
                       json={"path": str(f), "profile_id": "generic_hpgl"})
    assert r.json()["ok"] is False

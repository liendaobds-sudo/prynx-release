"""Test API router (task 11.1). Requirements: 6.2, 7.1.

Dùng TestClient cô lập trên một app tạm CHỈ gắn router cut_export — không đụng app thật.
"""

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import feature_entitlements as entitlements
from app.workers.cut_export.api import router
from app.core.license_guard import require_license

# SEC (audit 2026-08-28 §SEC.01): override CŨ là `lambda: True` — một bool, không phải
# license context. Nó vô hiệu hoá luôn `require_feature` (vì `require_feature` phụ thuộc
# `require_license`) nên bộ test này KHÔNG THỂ phát hiện việc router thiếu quyền
# `impo.cnc`. Nay override bằng context Pro THẬT để happy path chạy đúng, và có thêm
# test Free→403 bên dưới để khoá hồi quy.
_PRO_LICENSE = {
    "license_key": "TEST-PRO",
    "hwid": "TEST-HWID",
    "verified": True,
    "plan": "pro",
    "features": ["*"],
}
_FREE_LICENSE = {
    "license_key": "TEST-FREE",
    "hwid": "TEST-HWID",
    "verified": True,
    "plan": "free",
    "features": [],
}


def _client(license_info: dict | None = None):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_license] = lambda: license_info or _PRO_LICENSE
    return TestClient(app)


@pytest.fixture
def gating_on(monkeypatch):
    """Bật gate quyền như bản đóng gói (binary compiled LUÔN bật — xem
    `feature_entitlements._feature_gating_enabled`). Chạy từ source thì mặc định TẮT,
    nên không bật tường minh ở đây thì test 403 sẽ xanh GIẢ."""
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)


# ── §SEC.01: quyền impo.cnc phải được cưỡng chế ở BACKEND, không chỉ ở UI ────────
# Đường tấn công đã vá: license Free hợp lệ (HMAC + token Ed25519 đều đúng) gọi thẳng
# /imposition/cut-export-from-file để xuất luồng cắt và đẩy tới máy bế qua TCP/serial.

_PRO_ONLY_CALLS = [
    ("post", "/imposition/cut-export", {"json": {"profile_id": "generic_hpgl", "sheet_w_mm": 10, "sheet_h_mm": 10}}),
    ("post", "/imposition/cut-export-from-file", {"json": {"profile_id": "generic_hpgl", "path": "x.pdf"}}),
    ("post", "/imposition/cut-layers", {"json": {"path": "x.pdf"}}),
    ("post", "/imposition/cut-pages", {"json": {"path": "x.pdf"}}),
    ("post", "/imposition/cut-inspect", {"json": {"path": "x.pdf"}}),
    ("get", "/imposition/cut-profiles", {}),
    ("post", "/imposition/cut-connection-test", {"json": {"host": "127.0.0.1", "port": 9100}}),
]


@pytest.mark.parametrize(("method", "path", "kwargs"), _PRO_ONLY_CALLS)
def test_free_bi_chan_403_truoc_khi_cham_engine(gating_on, method, path, kwargs):
    client = _client(_FREE_LICENSE)
    response = getattr(client, method)(path, **kwargs)
    assert response.status_code == 403, f"{path} → {response.status_code}: {response.text}"
    assert "impo.cnc" in response.json().get("detail", "")


def test_grant_rieng_impo_cnc_mo_duoc_cho_tai_khoan_free(gating_on):
    """Free có grant lẻ `impo.cnc` vẫn dùng được — gate là QUYỀN, không phải hạng gói."""
    granted = {**_FREE_LICENSE, "features": ["impo.cnc"]}
    response = _client(granted).get("/imposition/cut-profiles")
    assert response.status_code == 200


@pytest.mark.parametrize("grant_khac", ["impo.diecut", "impo.nup", "packaging.dieline"])
def test_grant_cua_tool_khac_khong_mo_duoc_cut_export(gating_on, grant_khac):
    """`impo.diecut`/`impo.nup`/`packaging.dieline` KHÔNG phải bí danh của `impo.cnc`."""
    granted = {**_FREE_LICENSE, "features": [grant_khac]}
    response = _client(granted).get("/imposition/cut-profiles")
    assert response.status_code == 403, grant_khac


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


def test_cut_inspect_unified_schema_and_selected_preview():
    pytest.importorskip("pikepdf")
    r = _client().post(
        "/imposition/cut-inspect",
        json={"path": _CUT_FIXTURE, "page_idx": 0},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["num_pages"] >= 1
    assert data["cut_pages"] == [0]
    assert data["selected_page_idx"] == 0
    assert data["candidates"]["layers"]
    assert data["preview"]["page_idx"] == 0
    assert data["preview"]["total_items"] == 75
    fingerprint = data["fingerprint"]
    assert fingerprint["algorithm"] == "sha256"
    assert len(fingerprint["sha256"]) == 64
    assert fingerprint["size_bytes"] > 0
    assert data["inspect_proof"].startswith("v2.")
    assert len(data["inspect_proof"]) == 100
    assert data["inspect_proofs"] == {"0": data["inspect_proof"]}


def test_cut_inspect_khong_co_cut_tra_proof_rong(tmp_path):
    pikepdf = pytest.importorskip("pikepdf")
    blank_path = tmp_path / "blank.pdf"
    pdf = pikepdf.Pdf.new()
    try:
        pdf.add_blank_page(page_size=(200, 200))
        pdf.save(blank_path)
    finally:
        pdf.close()

    data = _client().post(
        "/imposition/cut-inspect",
        json={"path": str(blank_path), "page_idx": 0},
    ).json()

    assert data["ok"] is True
    assert data["cut_pages"] == []
    assert data["selected_page_idx"] is None
    assert data["inspect_proof"] is None
    assert data["inspect_proofs"] == {}


def test_cut_inspect_bao_capacity_ro_rang_khi_batch_khong_vua_ram(monkeypatch):
    pytest.importorskip("pikepdf")
    from app.workers.cut_export import inspect_proof as proof_module

    monkeypatch.setattr(proof_module, "_current_proof_store_budget_bytes", lambda: 1)
    data = _client().post(
        "/imposition/cut-inspect",
        json={"path": _CUT_FIXTURE, "page_idx": 0},
    ).json()

    assert data["ok"] is False
    assert data["proof_error"] == "capacity"
    assert "RAM" in data["error"]


def test_proof_store_budget_may_manh_khong_bi_hard_cap():
    from app.workers.cut_export.inspect_proof import _proof_store_budget_bytes

    low = _proof_store_budget_bytes(6 * 1024, 4 * 1024)
    middle = _proof_store_budget_bytes(12 * 1024, 8 * 1024)
    strong = _proof_store_budget_bytes(32 * 1024, 20 * 1024)
    stronger = _proof_store_budget_bytes(64 * 1024, 40 * 1024)

    assert low <= 96 * 1024 * 1024
    assert middle <= 256 * 1024 * 1024
    assert strong > middle
    assert stronger == strong * 2


def test_cut_inspect_cap_proof_cho_moi_trang_cut_cung_mot_luot_quet(
    tmp_path, monkeypatch
):
    pikepdf = pytest.importorskip("pikepdf")
    combined_path = tmp_path / "hai-trang-cut.pdf"
    output = pikepdf.Pdf.new()
    source = pikepdf.open(_CUT_FIXTURE)
    try:
        output.pages.extend(source.pages)
        output.pages.extend(source.pages)
        output.save(combined_path)
    finally:
        source.close()
        output.close()

    real_open = pikepdf.open
    opened = []

    def counted_open(*args, **kwargs):
        opened.append(args[0])
        return real_open(*args, **kwargs)

    monkeypatch.setattr(pikepdf, "open", counted_open)
    data = _client().post(
        "/imposition/cut-inspect",
        json={"path": str(combined_path), "page_idx": 0},
    ).json()

    assert data["ok"] is True
    assert data["cut_pages"] == [0, 1]
    assert set(data["inspect_proofs"]) == {"0", "1"}
    assert data["inspect_proof"] == data["inspect_proofs"]["0"]
    assert data["inspect_proofs"]["0"] != data["inspect_proofs"]["1"]
    assert all(len(proof) == 100 for proof in data["inspect_proofs"].values())
    assert len(opened) == 1

    page_zero = _client().post(
        "/imposition/cut-export-from-file",
        json={
            "path": str(combined_path),
            "profile_id": "generic_hpgl",
            "transport_kind": "file",
            "dest_dir": str(tmp_path),
            "name": "batch-0",
            "page_idx": 0,
            "inspect_proof": data["inspect_proofs"]["0"],
        },
    ).json()
    page_one = _client().post(
        "/imposition/cut-export-from-file",
        json={
            "path": str(combined_path),
            "profile_id": "generic_hpgl",
            "transport_kind": "file",
            "dest_dir": str(tmp_path),
            "name": "batch-1",
            "page_idx": 1,
            "inspect_proof": data["inspect_proofs"]["1"],
        },
    ).json()

    assert page_zero["ok"] is True
    assert page_one["ok"] is True
    assert page_zero["total_items"] == page_one["total_items"] == 75


def _inspect_proof(client=None, *, path=_CUT_FIXTURE, page_idx=0, force_layer=None):
    client = client or _client()
    payload = {"path": path, "page_idx": page_idx}
    if force_layer is not None:
        payload["force_layer"] = force_layer
    data = client.post("/imposition/cut-inspect", json=payload).json()
    assert data["ok"] is True
    assert data["inspect_proof"]
    return data


def _export_with_proof(tmp_path, proof, **overrides):
    body = {
        "path": _CUT_FIXTURE,
        "profile_id": "generic_hpgl",
        "transport_kind": "file",
        "dest_dir": str(tmp_path),
        "name": "proof-export",
        "page_idx": 0,
        "inspect_proof": proof,
        **overrides,
    }
    return _client().post("/imposition/cut-export-from-file", json=body).json()


def test_cut_inspect_latest_per_binding_thay_proof_cu(tmp_path):
    first = _inspect_proof()
    second = _inspect_proof()

    stale = _export_with_proof(tmp_path, first["inspect_proof"], name="superseded")
    current = _export_with_proof(tmp_path, second["inspect_proof"], name="current")

    assert stale["ok"] is False
    assert stale["proof_error"] == "unknown-proof"
    assert current["ok"] is True


def test_cut_export_reuses_server_owned_inspect_proof_without_reparse(tmp_path, monkeypatch):
    pytest.importorskip("pikepdf")
    inspected = _inspect_proof()
    from app.workers.cut_export import api as cut_api

    def must_not_parse(*_args, **_kwargs):
        raise AssertionError("Proof path không được parse/extract PDF lại")

    monkeypatch.setattr(cut_api, "build_cut_model_from_pdf", must_not_parse)
    data = _export_with_proof(tmp_path, inspected["inspect_proof"])

    assert data["ok"] is True
    assert data["total_items"] == inspected["preview"]["total_items"] == 75


def test_cut_export_rejects_tampered_proof_without_legacy_fallback(tmp_path, monkeypatch):
    inspected = _inspect_proof()
    proof = inspected["inspect_proof"]
    tampered = proof[:-1] + ("0" if proof[-1] != "0" else "1")
    from app.workers.cut_export import api as cut_api

    monkeypatch.setattr(
        cut_api,
        "build_cut_model_from_pdf",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Không được fallback")),
    )
    data = _export_with_proof(tmp_path, tampered)

    assert data == {
        "ok": False,
        "error": "Bằng chứng inspect không hợp lệ hoặc đã hết hạn. Hãy xem trước lại file.",
        "proof_error": "bad-signature",
    }


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"page_idx": 1}, "binding-mismatch"),
        ({"force_layer": "CutContour"}, "binding-mismatch"),
        ({"path": __file__}, "binding-mismatch"),
    ],
)
def test_cut_export_proof_binds_path_page_and_layer(tmp_path, overrides, expected_code):
    inspected = _inspect_proof()
    if "path" in overrides:
        other_pdf = tmp_path / "other.pdf"
        other_pdf.write_bytes(open(_CUT_FIXTURE, "rb").read())
        overrides = {**overrides, "path": str(other_pdf)}
    data = _export_with_proof(tmp_path, inspected["inspect_proof"], **overrides)
    assert data["ok"] is False
    assert data["proof_error"] == expected_code


def test_cut_export_proof_is_one_shot(tmp_path):
    inspected = _inspect_proof()
    first = _export_with_proof(tmp_path, inspected["inspect_proof"], name="first")
    second = _export_with_proof(tmp_path, inspected["inspect_proof"], name="second")

    assert first["ok"] is True
    assert second["ok"] is False
    assert second["proof_error"] == "replay"


def test_cut_export_proof_replay_bi_chan_truoc_khi_bam_lai_source(
    tmp_path, monkeypatch
):
    inspected = _inspect_proof()
    proof = inspected["inspect_proof"]
    first = _export_with_proof(tmp_path, proof, name="first")
    assert first["ok"] is True

    from app.workers.cut_export import inspect_proof as proof_module

    monkeypatch.setattr(
        proof_module,
        "_verify_current_source",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Replay không được băm lại source")
        ),
    )
    second = _export_with_proof(tmp_path, proof, name="second")

    assert second["ok"] is False
    assert second["proof_error"] == "replay"


def test_cut_export_proof_cua_generation_cu_bi_tu_choi(tmp_path, monkeypatch):
    inspected = _inspect_proof()
    from app.workers.cut_export import inspect_proof as proof_module

    monkeypatch.setattr(proof_module, "_PROCESS_GENERATION_SECRET", b"x" * 32)
    data = _export_with_proof(tmp_path, inspected["inspect_proof"])

    assert data["ok"] is False
    assert data["proof_error"] == "bad-signature"


def test_cut_export_proof_rejects_expired_claim(tmp_path, monkeypatch):
    from app.workers.cut_export import inspect_proof as proof_module

    monkeypatch.setattr(proof_module.time, "time", lambda: 1_000)
    inspected = _inspect_proof()
    monkeypatch.setattr(proof_module.time, "time", lambda: 1_301)

    data = _export_with_proof(tmp_path, inspected["inspect_proof"])
    assert data["ok"] is False
    assert data["proof_error"] == "expired"


def test_cut_export_proof_rejects_source_changed_after_inspect(tmp_path):
    target = tmp_path / "source.pdf"
    target.write_bytes(open(_CUT_FIXTURE, "rb").read())
    inspected = _inspect_proof(path=str(target))
    original_stat = target.stat()
    with open(target, "r+b", buffering=0) as stream:
        stream.seek(7)
        old = stream.read(1)
        stream.seek(7)
        stream.write(b"6" if old != b"6" else b"5")
    _os.utime(target, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

    data = _export_with_proof(
        tmp_path,
        inspected["inspect_proof"],
        path=str(target),
    )
    assert data["ok"] is False
    assert data["proof_error"] == "source-stale"


def test_cut_export_without_proof_keeps_legacy_fallback(tmp_path):
    data = _export_with_proof(tmp_path, None, name="legacy")
    assert data["ok"] is True
    assert data["total_items"] == 75


def test_cut_export_proof_rong_fail_closed_khong_fallback(tmp_path, monkeypatch):
    from app.workers.cut_export import api as cut_api

    monkeypatch.setattr(
        cut_api,
        "build_cut_model_from_pdf",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Proof rỗng không được rơi về legacy")
        ),
    )
    data = _export_with_proof(tmp_path, "")

    assert data["ok"] is False
    assert data["proof_error"] == "malformed"


def test_cut_export_proof_qua_tran_bi_chan_tai_schema(tmp_path):
    from app.workers.cut_export.inspect_proof import CUT_INSPECT_PROOF_MAX_LENGTH

    response = _client().post(
        "/imposition/cut-export-from-file",
        json={
            "path": _CUT_FIXTURE,
            "profile_id": "generic_hpgl",
            "transport_kind": "file",
            "dest_dir": str(tmp_path),
            "inspect_proof": "x" * (CUT_INSPECT_PROOF_MAX_LENGTH + 1),
        },
    )

    assert response.status_code == 422


def test_cut_inspect_missing_file_returns_json_error():
    r = _client().post(
        "/imposition/cut-inspect",
        json={"path": "C:/nope/not-found.pdf", "page_idx": 0},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is False


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

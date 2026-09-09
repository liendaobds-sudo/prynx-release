"""Quyền hoàn tất Compare dùng fixture ký thật, không đụng key/PDF của người dùng."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from concurrent.futures import Future
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import compare, imposition, results, vdp
from app.core import feature_entitlements, job_access, license_guard as lg
from app.database import SessionLocal
from app.models.job import ComparisonJob, PageResult, UploadedFile
from tests.test_free_token_e2e import _prepared_body_binding


HEADER = "X-PrynX-Job-Access"
LICENSE_KEY = "PRYNX-JOB-ACCESS-TEST"
DEVICE_ID = "d3_" + "A" * 43
SESSION_SECRET = "job-access-session-gia-256-bit"


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


@pytest.fixture
def scenario(monkeypatch, tmp_path):
    clock = SimpleNamespace(wall=2_000_000_000.0, mono=1_000.0)
    monkeypatch.setattr(job_access, "_wall_seconds", lambda: clock.wall)
    monkeypatch.setattr(job_access, "_monotonic_seconds", lambda: clock.mono)
    monkeypatch.setattr(job_access, "_grants", {})
    monkeypatch.setattr(lg.time, "time", lambda: clock.wall)
    monkeypatch.setattr(lg, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(lg, "_enforce_license_token", lambda: True)
    monkeypatch.setattr(lg, "_clock_guard", lambda: (True, ""))
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", SESSION_SECRET)
    monkeypatch.setattr(lg, "_license_cache", {})
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    signing_key = Ed25519PrivateKey.generate()
    public = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw,
    )
    monkeypatch.setattr(lg, "_LICENSE_PUBLIC_KEY_B64", base64.b64encode(public).decode())

    async def online_check(*_args):
        return True

    monkeypatch.setattr(lg, "_verify_with_supabase", online_check)
    monkeypatch.setattr(compare.settings, "IS_DESKTOP_APP", True)
    monkeypatch.setattr(compare, "ensure_job_disk_space", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", SimpleNamespace(
        acquire=lambda **_kwargs: True, release=lambda: None,
    ))
    submitted = []
    monkeypatch.setattr(compare, "_submit_reserved_comparison", submitted.append)
    monkeypatch.setattr(imposition, "nup_jobs", {})
    monkeypatch.setattr(vdp, "vdp_jobs", {})
    for module, executor_name, slots_name in [
        (imposition, "_NUP_PREP_EXECUTOR", "_NUP_SUBMISSION_SLOTS"),
        (vdp, "_VDP_EXECUTOR", "_VDP_SUBMISSION_SLOTS"),
    ]:
        monkeypatch.setattr(module, executor_name, SimpleNamespace(submit=lambda *_args, **_kwargs: Future()))
        monkeypatch.setattr(module, slots_name, SimpleNamespace(
            acquire=lambda **_kwargs: True, release=lambda: None,
        ))
        monkeypatch.setattr(module, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(vdp, "UPLOAD_DIR", str(tmp_path))

    fixture_app = FastAPI()
    fixture_app.include_router(compare.router, prefix="/api")
    fixture_app.include_router(results.router, prefix="/api")
    fixture_app.include_router(imposition.router, prefix="/api")
    fixture_app.include_router(vdp.router, prefix="/api/vdp")
    client = TestClient(fixture_app)
    db = SessionLocal()
    files = []
    for name in ("a", "b", "other"):
        path = tmp_path / f"{name}.pdf"
        path.write_bytes(f"PDF-gia-{name}".encode())
        row = UploadedFile(
            filename=path.name, original_name=path.name,
            file_path=str(path), page_count=1,
        )
        db.add(row)
        files.append(row)
    db.commit()
    for row in files:
        db.refresh(row)

    def token(plan="pro"):
        payload = {
            "v": 3, "min_v": 3, "iat": int(clock.wall), "exp": int(clock.wall) + 900,
            "cid": str(uuid.uuid4()), "d": DEVICE_ID, "m": DEVICE_ID,
            "cnf": {"jkt": DEVICE_ID[3:]}, "p": "prynx", "plan": plan,
            "k": hashlib.sha256(LICENSE_KEY.encode()).hexdigest()[:16],
        }
        payload_b64 = _b64(json.dumps(payload, separators=(",", ":")).encode())
        return payload_b64 + "." + _b64(signing_key.sign(payload_b64.encode()))

    original_token = token()

    def signed(method, path, body=None, license_token=original_token, *, data=None, files=None):
        raw = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        content_type = "application/json" if body is not None else ""
        body_mode = "raw-v1" if raw else "none"
        commitment = lg._raw_body_commitment(raw) if raw else lg._BODY_NONE_COMMITMENT
        if data is not None or files is not None:
            prepared = httpx.Request(method, "http://testserver" + path, data=data, files=files)
            body_mode, commitment, content_type = _prepared_body_binding(prepared)
            raw = prepared.read()
        timestamp, nonce = str(int(clock.wall)), uuid.uuid4().hex
        signing_payload = lg._request_signature_payload_v2(
            timestamp, nonce, method, path, LICENSE_KEY, DEVICE_ID,
            hashlib.sha256(license_token.encode()).hexdigest(), body_mode,
            commitment, content_type,
        )
        headers = {
            "X-License-Key": LICENSE_KEY, "X-Hardware-Id": DEVICE_ID,
            "X-License-Token": license_token, "X-PrynX-Signature-Version": "2",
            "X-PrynX-Timestamp": timestamp, "X-PrynX-Nonce": nonce,
            "X-PrynX-Body-Mode": body_mode, "X-PrynX-Body-Commitment": commitment,
            "X-PrynX-Signature": hmac.new(
                SESSION_SECRET.encode(), signing_payload, hashlib.sha256,
            ).hexdigest(),
        }
        if content_type:
            headers["Content-Type"] = content_type
        return client.request(method, path, content=raw, headers=headers)

    body = {"file_a_id": files[0].id, "file_b_id": files[1].id}
    yield SimpleNamespace(
        clock=clock, client=client, db=db, files=files, signed=signed,
        body=body, submitted=submitted, token=token, tmp_path=tmp_path,
    )
    with compare._COMPARE_JOBS_LOCK:
        for job_id in submitted:
            compare._COMPARE_CONTROLS.pop(job_id, None)
    db.query(PageResult).filter(PageResult.job_id.in_(submitted)).delete(synchronize_session=False)
    db.query(ComparisonJob).filter(ComparisonJob.id.in_(submitted)).delete(synchronize_session=False)
    for row in files:
        db.delete(row)
    db.commit()
    db.close()
    client.close()


def _submit(scenario):
    response = scenario.signed("POST", "/api/jobs/compare", scenario.body)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get("job_access_token"), "Tác vụ đã nhận hợp lệ cần receipt hoàn tất riêng."
    return payload


def test_valid_submission_can_finish_and_read_results_after_license_expiry(scenario):
    receipt = _submit(scenario)
    job_id = receipt["job_id"]
    assert set(receipt["job_access_paths"]) == {
        f"GET /api/jobs/{job_id}", f"GET /api/jobs/{job_id}/results", f"POST /api/jobs/{job_id}/cancel",
        *(f"GET /api/files/{row.id}/serve" for row in scenario.files[:2]),
    }
    scenario.clock.wall += 901
    rejected = scenario.signed("GET", f"/api/jobs/{job_id}")
    assert rejected.status_code == 403 and "expired" in rejected.text
    scenario.db.query(ComparisonJob).filter_by(id=job_id).update({"status": "completed"})
    scenario.db.add(PageResult(job_id=job_id, page_number=1, status="pass", diff_count=0))
    scenario.db.commit()
    headers = {HEADER: receipt["job_access_token"]}
    status = scenario.client.get(f"/api/jobs/{job_id}", headers=headers)
    assert status.status_code == 200 and status.json()["status"] == "completed"
    result = scenario.client.get(f"/api/jobs/{job_id}/results", headers=headers)
    assert result.status_code == 200 and len(result.json()["pages"]) == 1
    page = scenario.client.get(f"/api/jobs/{job_id}/page/1", headers=headers)
    assert page.status_code == 200
    for row in scenario.files[:2]:
        source = scenario.client.get(f"/api/files/{row.id}/serve", headers=headers)
        assert source.status_code == 200 and source.content.startswith(b"PDF-gia-")
    blocked_submit = scenario.signed("POST", "/api/jobs/compare", scenario.body)
    assert blocked_submit.status_code == 403


@pytest.mark.parametrize("method,suffix", [
    ("POST", ""), ("DELETE", ""), ("GET", "/results?job=other"),
    ("POST", "/results"), ("GET", "/page/0"), ("GET", "/page/-1"),
    ("GET", "/page/1?format=other"), ("GET", "/cancel"),
])
def test_receipt_cannot_change_method_query_or_job_operation(scenario, method, suffix):
    receipt = _submit(scenario)
    response = scenario.client.request(
        method, f"/api/jobs/{receipt['job_id']}{suffix}",
        headers={HEADER: receipt["job_access_token"]},
    )
    # Path chưa đăng ký trả 405/404 trước dependency; path đã đăng ký phải 403.
    assert response.status_code in {403, 404, 405}


def test_receipt_cannot_access_other_job_file_or_start_new_work(scenario):
    first, second = _submit(scenario), _submit(scenario)
    headers = {HEADER: first["job_access_token"]}
    for method, path in [
        ("GET", f"/api/jobs/{second['job_id']}"),
        ("GET", f"/api/jobs/{second['job_id']}/results"),
        ("POST", f"/api/jobs/{second['job_id']}/cancel"),
        ("GET", f"/api/files/{scenario.files[2].id}/serve"),
        ("POST", "/api/jobs/compare"),
    ]:
        response = scenario.client.request(
            method, path, headers=headers,
            json=scenario.body if path == "/api/jobs/compare" else None,
        )
        assert response.status_code == 403, (path, response.text)
    assert len(scenario.submitted) == 2


def test_receipt_must_match_job_id_at_route_dependency(scenario):
    first, second = _submit(scenario), _submit(scenario)
    headers = {HEADER: first["job_access_token"]}
    for path in [f"/api/jobs/{second['job_id']}", f"/api/jobs/{second['job_id']}/results"]:
        response = scenario.client.get(path, headers=headers)
        assert response.status_code == 403, (path, response.text)


def test_receipt_allows_only_own_cancel_and_no_request_body(scenario):
    receipt = _submit(scenario)
    scenario.clock.wall += 901
    path = f"/api/jobs/{receipt['job_id']}/cancel"
    headers = {HEADER: receipt["job_access_token"]}
    rejected = scenario.client.post(path, headers=headers, json={"job_id": "other"})
    assert rejected.status_code == 403
    # Kết thúc giả lập tránh chạy pipeline/PDF hoặc cần một worker thật.
    scenario.db.query(ComparisonJob).filter_by(id=receipt["job_id"]).update({"status": "completed"})
    scenario.db.commit()
    cancelled = scenario.client.post(path, headers=headers)
    assert cancelled.status_code == 200 and cancelled.json()["cancelled"] is False


@pytest.mark.parametrize("alteration", ["missing", "unknown", "truncated", "uppercase", "duplicate"])
def test_receipt_rejects_malformed_or_unknown_tokens(scenario, alteration):
    receipt = _submit(scenario)
    token = receipt["job_access_token"]
    headers = {HEADER: {
        "missing": "", "unknown": "0" * 64, "truncated": token[:-1],
        "uppercase": token.upper(), "duplicate": token,
    }[alteration]}
    if alteration == "duplicate":
        headers = [(HEADER, token), (HEADER, token)]
    response = scenario.client.get(f"/api/jobs/{receipt['job_id']}", headers=headers)
    assert response.status_code == 403


@pytest.mark.parametrize("clock_change", ["wall_expiry", "monotonic_expiry", "clock_rollback"])
def test_receipt_retention_is_bounded_even_if_wall_clock_is_changed(scenario, clock_change):
    receipt = _submit(scenario)
    assert receipt["job_access_expires_at"] == scenario.clock.wall + 86_400
    if clock_change == "wall_expiry":
        scenario.clock.wall += 86_400
    elif clock_change == "monotonic_expiry":
        scenario.clock.mono += 86_400
    else:
        scenario.clock.wall -= 1
    response = scenario.client.get(
        f"/api/jobs/{receipt['job_id']}", headers={HEADER: receipt["job_access_token"]},
    )
    assert response.status_code == 403


def test_receipt_does_not_survive_sidecar_generation_change(scenario, monkeypatch):
    receipt = _submit(scenario)
    monkeypatch.setattr(lg, "_SIDECAR_TOKEN", "new-sidecar-generation-fixture")
    response = scenario.client.get(
        f"/api/jobs/{receipt['job_id']}", headers={HEADER: receipt["job_access_token"]},
    )
    assert response.status_code == 403


def test_observed_revocation_invalidates_receipt_instead_of_using_expiry_grace(scenario):
    receipt = _submit(scenario)
    owner = lg._hash_credentials(LICENSE_KEY, DEVICE_ID)
    lg._license_cache[owner] = (False, scenario.clock.wall + 1800)
    path = f"/api/jobs/{receipt['job_id']}"
    headers = {HEADER: receipt["job_access_token"]}
    assert scenario.client.get(path, headers=headers).status_code == 403
    # Một cache hợp lệ sau đó không được làm receipt đã thu hồi sống lại.
    lg._license_cache[owner] = (True, scenario.clock.wall + 1800)
    assert scenario.client.get(path, headers=headers).status_code == 403


def test_receipt_context_contains_no_general_license_entitlement(scenario):
    receipt = _submit(scenario)
    context = job_access.resolve_job_access(
        token=receipt["job_access_token"], method="GET",
        path=f"/api/jobs/{receipt['job_id']}", session_token=SESSION_SECRET,
        owner_is_revoked=lambda _owner: False,
    )
    assert set(context) == {"job_access"}
    assert job_access.is_job_access_for(context, "compare", receipt["job_id"])
    assert not job_access.is_job_access_for(context, "compare", str(uuid.uuid4()))
    with pytest.raises(PermissionError):
        feature_entitlements.assert_feature("util.upscale", context)


def test_free_or_expired_submission_cannot_mint_receipt(scenario):
    free_response = scenario.signed("POST", "/api/jobs/compare", scenario.body, scenario.token("free"))
    assert free_response.status_code == 403
    scenario.clock.wall += 901
    expired_response = scenario.signed("POST", "/api/jobs/compare", scenario.body)
    assert expired_response.status_code == 403
    assert scenario.submitted == [] and job_access._grants == {}


def test_failed_enqueue_does_not_mint_a_completion_receipt(scenario, monkeypatch):
    def refused_submit(_job_id):
        raise RuntimeError("Hàng đợi giả từ chối việc")

    monkeypatch.setattr(compare, "_submit_reserved_comparison", refused_submit)
    with pytest.raises(RuntimeError, match="Hàng đợi giả"):
        scenario.signed("POST", "/api/jobs/compare", scenario.body)
    assert job_access._grants == {}
    # Route hiện commit job trước enqueue; giữ vệ sinh DB fixture khi kiểm failure.
    orphan_jobs = scenario.db.query(ComparisonJob).filter_by(file_a_id=scenario.files[0].id).all()
    for job in orphan_jobs:
        scenario.submitted.append(job.id)


def test_unverified_context_never_mints_a_receipt(scenario):
    receipt = job_access.issue_job_access(
        family="compare", job_id=str(uuid.uuid4()),
        source_ids=tuple(row.id for row in scenario.files[:2]),
        license_info={"verified": False, "license_key": LICENSE_KEY, "hwid": DEVICE_ID, "plan": "pro"},
        session_token=SESSION_SECRET,
    )
    assert receipt is None and job_access._grants == {}


@pytest.mark.parametrize("submit_path", ["impose-start", "nup-start", "sticker-start"])
def test_nup_family_retains_own_download_and_cancel_after_expiry(scenario, submit_path):
    response = scenario.signed("POST", f"/api/imposition/{submit_path}", {
        "source_path": scenario.files[0].file_path, "settings": {},
    })
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt.get("job_access_token"), "Job bình bản đã nhận cần receipt hoàn tất."
    job_id = receipt["job_id"]
    paths = {
        f"GET /api/imposition/nup-status/{job_id}",
        f"GET /api/imposition/nup-download/{job_id}",
        f"POST /api/imposition/nup-cancel/{job_id}",
    }
    assert set(receipt["job_access_paths"]) == paths
    scenario.clock.wall += 901
    job = imposition.nup_jobs[job_id]
    output = scenario.tmp_path / "nup-completed-fixture.pdf"
    output.write_bytes(b"nup-result-fixture")
    job.update(status="completed", completed_at=scenario.clock.wall, output_path=str(output))
    headers = {HEADER: receipt["job_access_token"]}
    assert scenario.signed("GET", f"/api/imposition/nup-status/{job_id}").status_code == 403
    status = scenario.client.get(f"/api/imposition/nup-status/{job_id}", headers=headers)
    assert status.status_code == 200 and status.json()["status"] == "completed"
    download = scenario.client.get(f"/api/imposition/nup-download/{job_id}", headers=headers)
    assert download.status_code == 200 and download.content == b"nup-result-fixture"
    assert scenario.client.post(f"/api/imposition/nup-cancel/{job_id}", headers=headers).status_code == 200
    assert scenario.client.get("/api/imposition/nup-status/ffffffff", headers=headers).status_code == 403
    assert scenario.client.get(f"/api/files/{scenario.files[0].id}/serve", headers=headers).status_code == 403
    assert scenario.client.post(f"/api/imposition/{submit_path}", json={}, headers=headers).status_code == 403


def test_vdp_retains_own_download_and_cancel_after_expiry(scenario):
    response = scenario.signed("POST", "/api/vdp/generate", data={
        "fields": "[]", "data_format": "json", "feature_id": "vdp.datamerge",
    }, files={
        "data_file": ("data.json", b'[{"value":"fixture"}]', "application/json"),
        "file": ("template.pdf", b"%PDF-template-fixture", "application/pdf"),
    })
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt.get("job_access_token"), "Job VDP đã nhận cần receipt hoàn tất."
    job_id = receipt["job_id"]
    scenario.clock.wall += 901
    output = scenario.tmp_path / "vdp-completed-fixture.pdf"
    output.write_bytes(b"vdp-result-fixture")
    vdp.vdp_jobs[job_id].update(
        status="completed", total=1, result=str(output), completed_at=scenario.clock.wall,
    )
    headers = {HEADER: receipt["job_access_token"]}
    assert set(receipt["job_access_paths"]) == {
        f"GET /api/vdp/status/{job_id}", f"GET /api/vdp/download/{job_id}",
        f"POST /api/vdp/vdp-cancel/{job_id}", f"POST /api/vdp/cancel/{job_id}",
    }
    assert scenario.signed("GET", f"/api/vdp/status/{job_id}").status_code == 403
    assert scenario.client.get(f"/api/vdp/status/{job_id}", headers=headers).status_code == 200
    download = scenario.client.get(f"/api/vdp/download/{job_id}", headers=headers)
    assert download.status_code == 200 and download.content == b"vdp-result-fixture"
    for suffix in ["vdp-cancel", "cancel"]:
        assert scenario.client.post(f"/api/vdp/{suffix}/{job_id}", headers=headers).status_code == 200
    assert scenario.client.get("/api/vdp/download/" + "f" * 32, headers=headers).status_code == 403
    assert scenario.client.post("/api/vdp/generate", headers=headers).status_code == 403

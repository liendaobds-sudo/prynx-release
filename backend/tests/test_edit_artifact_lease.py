"""Hồi quy vòng đời lease của Working File do công cụ Edit tạo."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import edit as edit_route
from app.api.routes import results as results_route
from app.core import artifact_lease, cleanup
from app.database import SessionLocal
from app.models.job import UploadedFile


def _configure_results(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    results = tmp_path / "results"
    (results / edit_route.EDIT_OUTPUT_SUBDIR).mkdir(parents=True)
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    # Các module dùng cùng settings singleton; gán rõ từng nơi để test tự mô tả.
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(edit_route.settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(cleanup.settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(cleanup.settings, "UPLOAD_DIR", str(uploads))
    return results


def _write_edit_artifact(results: Path, name: str = "tai_lieu_deleted_a1b2c3.pdf") -> Path:
    artifact = results / edit_route.EDIT_OUTPUT_SUBDIR / name
    artifact.write_bytes(b"%PDF-1.4\n% lease-test\n")
    return artifact


def _row_state(fid: str) -> tuple[bool, datetime | None, str | None]:
    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if row is None:
            return False, None, None
        return True, row.expires_at, row.file_path
    finally:
        db.close()


def _set_expiry(fid: str, expires_at: datetime) -> None:
    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == fid).one()
        row.expires_at = expires_at
        db.commit()
    finally:
        db.close()


def _delete_row(fid: str) -> None:
    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if row is not None:
            db.delete(row)
            db.commit()
    finally:
        db.close()


def test_edit_response_publishes_fid_path_and_lease_only_after_artifact_exists(
    tmp_path,
    monkeypatch,
):
    results = _configure_results(tmp_path, monkeypatch)
    artifact = _write_edit_artifact(results)

    response = edit_route._build_output_response(
        str(artifact),
        {"changed": 1},
        {"license_key": "DEV_MODE"},
    )

    assert response.output_path == os.path.abspath(artifact)
    assert response.output_fid
    assert response.artifact_lease
    exists, _expiry, row_path = _row_state(response.output_fid)
    assert exists
    assert row_path == os.path.abspath(artifact)
    assert artifact_lease.claim_artifact_lease(
        response.artifact_lease,
        "tab-edit-ms",
        owner_ttl_seconds=0.001,
    )

    marker = artifact_lease._marker_path(response.artifact_lease)
    assert marker is not None
    payload = json.loads(marker.read_text(encoding="utf-8"))
    clock = [float(payload["owners"]["tab-edit-ms"]) + 0.001]
    monkeypatch.setattr(artifact_lease.time, "time", lambda: clock[0])
    assert not artifact_lease.is_artifact_path_protected(artifact)

    _delete_row(response.output_fid)
    artifact.unlink(missing_ok=True)


def test_edit_publication_lease_failure_rolls_back_db_and_artifact(
    tmp_path,
    monkeypatch,
):
    results = _configure_results(tmp_path, monkeypatch)
    artifact = _write_edit_artifact(results, "tai_lieu_rotated_b2c3d4.pdf")

    def _lease_failure(*_args, **_kwargs):
        raise OSError("không ghi được marker lease")

    monkeypatch.setattr(edit_route, "create_artifact_lease", _lease_failure)
    with pytest.raises(OSError, match="marker lease"):
        edit_route._build_output_response(
            str(artifact),
            {},
            {"license_key": "DEV_MODE"},
        )

    assert not artifact.exists()
    db = SessionLocal()
    try:
        assert (
            db.query(UploadedFile)
            .filter(UploadedFile.file_path == os.path.abspath(artifact))
            .first()
            is None
        )
    finally:
        db.close()


@pytest.mark.parametrize(
    ("route_handler", "materialize_name"),
    [
        (edit_route.session_commit, "commit"),
        (edit_route.session_flatten, "flatten"),
    ],
)
def test_session_publication_rollback_cannot_overwrite_a_competing_operation(
    monkeypatch,
    route_handler,
    materialize_name,
):
    """Op song song chỉ được chạy sau khi publication đã rollback xong."""
    session = SimpleNamespace(
        source_fid="fid-source",
        lock=threading.RLock(),
        dirty=True,
        last_commit_path="C:/valid/previous.pdf",
    )
    output_path = "C:/unpublished/new.pdf"
    lease_entered = threading.Event()
    release_lease = threading.Event()
    contender_attempting = threading.Event()
    contender_entered = threading.Event()

    def _materialize(current_session):
        assert current_session is session
        current_session.dirty = False
        current_session.last_commit_path = output_path
        return {
            "success": True,
            "output_filename": "new.pdf",
            "output_url": "/results/edit_output/new.pdf",
            "output_path": output_path,
            "output_fid": "fid-new",
            "warning": None,
        }

    def _lease_failure(_path, _fid):
        lease_entered.set()
        assert release_lease.wait(timeout=2), "Test không nhả điểm chặn publication"
        raise OSError("không publish được lease")

    def _competing_operation():
        contender_attempting.set()
        with session.lock:
            session.dirty = True
            session.last_commit_path = "C:/valid/after-competing-op.pdf"
            contender_entered.set()

    monkeypatch.setattr(edit_route.edit_session, "get_session", lambda _sid: session)
    monkeypatch.setattr(edit_route.edit_session, materialize_name, _materialize)
    monkeypatch.setattr(edit_route, "_lease_registered_working_file", _lease_failure)

    async def _scenario():
        request_task = asyncio.create_task(
            route_handler(
                edit_route.SessionCommitReq(session_id="session-atomic"),
                license_info={},
            )
        )
        assert await asyncio.to_thread(lease_entered.wait, 2)

        contender = threading.Thread(target=_competing_operation)
        contender.start()
        assert await asyncio.to_thread(contender_attempting.wait, 2)
        await asyncio.sleep(0.05)
        assert not contender_entered.is_set(), (
            "session.lock phải giữ tới khi publication/rollback kết thúc"
        )

        release_lease.set()
        with pytest.raises(HTTPException) as exc_info:
            await request_task
        assert exc_info.value.status_code == 500

        await asyncio.to_thread(contender.join, 2)
        assert not contender.is_alive()

    asyncio.run(_scenario())
    assert contender_entered.is_set()
    assert session.dirty is True
    assert session.last_commit_path == "C:/valid/after-competing-op.pdf"


def test_generic_renew_extends_edit_db_expiry_without_total_age_cap(
    tmp_path,
    monkeypatch,
):
    results = _configure_results(tmp_path, monkeypatch)
    artifact = _write_edit_artifact(results, "tai_lieu_moved_c3d4e5.pdf")
    fid, token = edit_route._register_and_lease_working_file(str(artifact), artifact.name)
    assert artifact_lease.claim_artifact_lease(token, "tab-edit-renew")

    # Tuổi marker rất cũ không được trở thành hard-cap khi owner vẫn heartbeat.
    marker = artifact_lease._marker_path(token)
    assert marker is not None
    payload = json.loads(marker.read_text(encoding="utf-8"))
    payload["created_at"] = time.time() - 3650 * 24 * 3600
    marker.write_text(json.dumps(payload), encoding="utf-8")

    old_expiry = datetime.now(timezone.utc) - timedelta(seconds=1)
    _set_expiry(fid, old_expiry)
    request = results_route.ArtifactLeaseBatchRequest.model_validate(
        {"tabId": "tab-edit-renew", "leaseTokens": [token]}
    )
    renewed = results_route.renew_artifact_leases(request, {})
    assert renewed == {"results": [{"leaseToken": token, "ok": True}]}

    exists, expires_at, _path = _row_state(fid)
    assert exists and expires_at is not None
    compare_now = (
        datetime.now(expires_at.tzinfo)
        if expires_at.tzinfo
        else datetime.now(timezone.utc).replace(tzinfo=None)
    )
    assert expires_at > compare_now + timedelta(hours=23)

    artifact_lease.release_artifact_lease(token, "tab-edit-renew")
    _delete_row(fid)
    artifact.unlink(missing_ok=True)


def test_invalid_token_fails_but_missing_edit_fid_keeps_marker_lease(tmp_path, monkeypatch):
    results = _configure_results(tmp_path, monkeypatch)
    fake_request = results_route.ArtifactLeaseBatchRequest.model_validate(
        {"tabId": "tab-invalid", "leaseTokens": ["f" * 64]}
    )
    assert results_route.renew_artifact_leases(fake_request, {})["results"][0]["ok"] is False

    artifact = _write_edit_artifact(results, "tai_lieu_resized_d4e5f6.pdf")
    missing_fid = str(uuid.uuid4())
    token = artifact_lease.create_artifact_lease("edit", artifact, fid=missing_fid)
    assert artifact_lease.claim_artifact_lease(token, "tab-invalid")
    request = results_route.ArtifactLeaseBatchRequest.model_validate(
        {"tabId": "tab-invalid", "leaseTokens": [token]}
    )
    assert results_route.renew_artifact_leases(request, {})["results"][0]["ok"] is True
    assert artifact.exists(), "Fail-closed phải giữ artifact thay vì xóa liều"
    assert artifact_lease.is_artifact_path_protected(artifact)

    artifact_lease.release_artifact_lease(token, "tab-invalid")
    artifact.unlink(missing_ok=True)


def test_edit_renew_db_failure_or_fid_path_mismatch_keeps_marker_only(
    tmp_path,
    monkeypatch,
):
    results = _configure_results(tmp_path, monkeypatch)
    artifact = _write_edit_artifact(results, "tai_lieu_marker_a7b8c9.pdf")
    other = _write_edit_artifact(results, "tai_lieu_other_b8c9d0.pdf")
    wrong_fid = edit_route._register_working_file(str(other), other.name)
    token = artifact_lease.create_artifact_lease("edit", artifact, fid=wrong_fid)
    assert artifact_lease.claim_artifact_lease(token, "tab-path-mismatch")
    old_expiry = datetime.now(timezone.utc) - timedelta(seconds=1)
    _set_expiry(wrong_fid, old_expiry)

    request = results_route.ArtifactLeaseBatchRequest.model_validate(
        {"tabId": "tab-path-mismatch", "leaseTokens": [token]}
    )
    assert results_route.renew_artifact_leases(request, {})["results"][0]["ok"] is True
    _exists, expiry_after_mismatch, row_path = _row_state(wrong_fid)
    assert row_path == os.path.abspath(other)
    assert expiry_after_mismatch is not None
    expected_old_expiry = (
        old_expiry.replace(tzinfo=None)
        if expiry_after_mismatch.tzinfo is None
        else old_expiry.astimezone(expiry_after_mismatch.tzinfo)
    )
    assert expiry_after_mismatch == expected_old_expiry
    assert artifact_lease.is_artifact_path_protected(artifact)

    class BrokenSession:
        def query(self, *_args, **_kwargs):
            raise OSError("sqlite tạm bận")

        def rollback(self):
            return None

        def close(self):
            return None

    monkeypatch.setattr(results_route, "SessionLocal", lambda: BrokenSession())
    assert results_route.renew_artifact_leases(request, {})["results"][0]["ok"] is True
    assert artifact_lease.is_artifact_path_protected(artifact)

    artifact_lease.release_artifact_lease(token, "tab-path-mismatch")
    _delete_row(wrong_fid)
    artifact.unlink(missing_ok=True)
    other.unlink(missing_ok=True)


def test_discard_refuses_leased_file_then_deletes_after_last_owner_release(
    tmp_path,
    monkeypatch,
):
    results = _configure_results(tmp_path, monkeypatch)
    artifact = _write_edit_artifact(results, "tai_lieu_edited_e5f6a7.pdf")
    fid, token = edit_route._register_and_lease_working_file(str(artifact), artifact.name)
    assert artifact_lease.claim_artifact_lease(token, "tab-discard")

    protected = asyncio.run(edit_route.discard_working_file(fid))
    assert protected == {"deleted": False, "reason": "leased"}
    assert artifact.exists()
    assert _row_state(fid)[0]

    assert artifact_lease.release_artifact_lease(token, "tab-discard")
    deleted = asyncio.run(edit_route.discard_working_file(fid))
    assert deleted == {"deleted": True}
    assert not artifact.exists()
    assert not _row_state(fid)[0]


def test_db_cleanup_refuses_leased_file_then_deletes_after_release(
    tmp_path,
    monkeypatch,
):
    results = _configure_results(tmp_path, monkeypatch)
    artifact = _write_edit_artifact(results, "tai_lieu_flattened_f6a7b8.pdf")
    fid, token = edit_route._register_and_lease_working_file(str(artifact), artifact.name)
    assert artifact_lease.claim_artifact_lease(token, "tab-cleanup")
    _set_expiry(fid, datetime.now(timezone.utc) - timedelta(seconds=1))

    cleanup.cleanup_expired()
    assert artifact.exists()
    assert _row_state(fid)[0]

    assert artifact_lease.release_artifact_lease(token, "tab-cleanup")
    cleanup.cleanup_expired()
    assert not artifact.exists()
    assert not _row_state(fid)[0]

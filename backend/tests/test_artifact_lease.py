"""Hồi quy lease bền cho Working artifact N-up/Sticker/VDP/Edit."""

from __future__ import annotations

import importlib
import json
import os
import time as system_time
import uuid
from collections import namedtuple

import pytest
from pydantic import ValidationError

from app.api.routes import results as results_route
from app.core import artifact_lease, cleanup
from app.core.license_guard import require_license


DiskUsage = namedtuple("DiskUsage", "total used free")


def _configure_results(tmp_path, monkeypatch):
    results = tmp_path / "results"
    uploads = tmp_path / "uploads"
    results.mkdir()
    uploads.mkdir()
    # Hai module dùng cùng object settings, đặt cả hai tên để test nói rõ contract.
    monkeypatch.setattr(artifact_lease.settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(cleanup.settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(cleanup.settings, "UPLOAD_DIR", str(uploads))
    return results, uploads


def _write(path, *, size=17, age_hours=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    if age_hours:
        past = system_time.time() - age_hours * 3600
        os.utime(path, (past, past))
    return path


def test_marker_survives_module_restart_and_owner_ttl_is_milliseconds(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    artifact = _write(results / "nup_deadbeef.pdf")
    token = artifact_lease.create_artifact_lease(
        "imposition",
        artifact,
        initial_ttl_seconds=0.2,
    )
    marker = artifact_lease._marker_path(token)
    assert marker is not None and marker.is_file()

    payload = json.loads(marker.read_text(encoding="utf-8"))
    clock = [float(payload["created_at"])]
    # Không dựa registry RAM: reload module mô phỏng sidecar restart rồi đọc marker.
    reloaded = importlib.reload(artifact_lease)
    monkeypatch.setattr(reloaded.settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(reloaded.time, "time", lambda: clock[0])
    assert reloaded.claim_artifact_lease(
        token,
        "tab-restart",
        owner_ttl_seconds=0.001,
    )
    assert reloaded.is_artifact_path_protected(artifact)

    clock[0] += 0.002
    assert not reloaded.is_artifact_path_protected(artifact)
    assert not marker.exists()
    assert artifact.exists(), "Lease hết hạn chỉ bỏ bảo vệ; cleanup mới sở hữu việc xóa"


def test_default_owner_ttl_chiu_duoc_timer_throttle_hon_hai_phut(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    artifact = _write(results / "nup_cafebabe.pdf")
    clock = [system_time.time()]
    monkeypatch.setattr(artifact_lease.time, "time", lambda: clock[0])
    token = artifact_lease.create_artifact_lease("imposition", artifact)

    assert artifact_lease.claim_artifact_lease(token, "tab-throttled")
    clock[0] += 121
    assert artifact_lease.is_artifact_path_protected(artifact)

    clock[0] += artifact_lease.ARTIFACT_OWNER_LEASE_SECONDS
    assert not artifact_lease.is_artifact_path_protected(artifact)


def test_owner_cu_reclaim_duoc_marker_sau_sleep_nhung_owner_la_bi_tu_choi(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    artifact = _write(results / "nup_facefeed.pdf")
    wall = [1_000.0]
    monkeypatch.setattr(artifact_lease.time, "time", lambda: wall[0])
    token = artifact_lease.create_artifact_lease("imposition", artifact)
    assert artifact_lease.claim_artifact_lease(
        token,
        "tab-suspend",
        owner_ttl_seconds=60,
    )

    # Sidecar và WebView cùng bị Windows suspend: marker chưa có lượt cleanup.
    wall[0] += 8 * 3600
    assert not artifact_lease.claim_artifact_lease(token, "tab-khac", owner_ttl_seconds=60)
    assert artifact_lease.renew_artifact_lease(
        token,
        "tab-suspend",
        owner_ttl_seconds=60,
    )

    # Sau khi reclaim, không heartbeat thật sự thì vẫn hết hạn bình thường.
    wall[0] += 61
    assert not artifact_lease.is_artifact_path_protected(artifact)


def test_cleanup_cho_heartbeat_resume_nhung_khong_hoan_vong_binh_thuong():
    assert cleanup.cleanup_resume_grace_seconds(
        cleanup.CLEANUP_LOOP_INTERVAL_SECONDS,
    ) == 0
    assert cleanup.cleanup_resume_grace_seconds(
        cleanup.CLEANUP_LOOP_INTERVAL_SECONDS + cleanup.CLEANUP_WAKE_SLACK_SECONDS + 1,
    ) == cleanup.CLEANUP_RESUME_GRACE_SECONDS


def test_allowlist_stores_relative_path_and_optional_edit_fid(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    fid = str(uuid.uuid4())
    edit = _write(results / "edit_output" / "tai_lieu_deleted_a1b2c3.pdf")

    token = artifact_lease.create_artifact_lease("edit", edit, fid=fid)
    marker = artifact_lease._marker_path(token)
    assert marker is not None
    payload = json.loads(marker.read_text(encoding="utf-8"))
    assert payload["artifact"] == "edit_output/tai_lieu_deleted_a1b2c3.pdf"
    assert payload["fid"] == fid
    assert not os.path.isabs(payload["artifact"])

    with pytest.raises(ValueError, match="allowlist"):
        artifact_lease.create_artifact_lease("vdp", edit)
    with pytest.raises(ValueError, match="fid"):
        artifact_lease.create_artifact_lease("edit", edit, fid="khong-hop-le")


def test_fake_token_and_tampered_relative_path_cannot_claim(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    artifact = _write(results / f"vdp_{'a' * 32}.pdf")
    token = artifact_lease.create_artifact_lease("vdp", artifact)

    assert not artifact_lease.claim_artifact_lease("f" * 64, "tab-fake")

    marker = artifact_lease._marker_path(token)
    assert marker is not None
    payload = json.loads(marker.read_text(encoding="utf-8"))
    payload["artifact"] = "../vdp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf"
    marker.write_text(json.dumps(payload), encoding="utf-8")

    assert not artifact_lease.claim_artifact_lease(token, "tab-tamper")
    assert artifact_lease.collect_artifact_lease_protected_path_keys() == set()


def test_symlink_artifact_is_rejected(tmp_path, monkeypatch):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    outside = _write(tmp_path / "outside.pdf")
    link = results / "nup_cafebabe.pdf"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"Hệ thống test không cho tạo symlink: {exc}")

    with pytest.raises(ValueError, match="allowlist"):
        artifact_lease.create_artifact_lease("imposition", link)


def test_multi_owner_release_and_renew_are_idempotent(tmp_path, monkeypatch):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    artifact = _write(results / "sticker_0123abcd.pdf")
    token = artifact_lease.create_artifact_lease("imposition", artifact)

    assert artifact_lease.claim_artifact_lease(token, "tab-a", owner_ttl_seconds=1)
    assert artifact_lease.claim_artifact_lease(token, "tab-b", owner_ttl_seconds=1)
    assert artifact_lease.release_artifact_lease(token, "tab-a")
    assert artifact_lease.is_artifact_path_protected(artifact)
    assert not artifact_lease.renew_artifact_lease(token, "tab-a")
    assert artifact_lease.renew_artifact_lease(
        token,
        "tab-b",
        owner_ttl_seconds=1,
    )

    assert artifact_lease.release_artifact_lease(token, "tab-b")
    assert artifact_lease.release_artifact_lease(token, "tab-b")
    assert not artifact_lease.is_artifact_path_protected(artifact)
    assert artifact.exists()


def test_batch_endpoints_dedupe_and_require_existing_owner_for_renew(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    artifact = _write(results / "nup_1234abcd.pdf")
    token = artifact_lease.create_artifact_lease("imposition", artifact)
    request = results_route.ArtifactLeaseBatchRequest.model_validate(
        {
            "tabId": "tab-api",
            "leaseTokens": [token, token],
        }
    )

    claimed = results_route.claim_artifact_leases(request, {})
    assert claimed == {"results": [{"leaseToken": token, "ok": True}]}

    other_owner = results_route.ArtifactLeaseBatchRequest.model_validate(
        {"tabId": "tab-khac", "leaseTokens": [token]}
    )
    assert results_route.renew_artifact_leases(other_owner, {})["results"][0]["ok"] is False
    assert results_route.renew_artifact_leases(request, {})["results"][0]["ok"] is True
    assert results_route.release_artifact_leases(request, {})["results"][0]["ok"] is True
    assert results_route.release_artifact_leases(request, {})["results"][0]["ok"] is True

    with pytest.raises(ValidationError):
        results_route.ArtifactLeaseBatchRequest.model_validate(
            {"tabId": "tab-qua-lon", "leaseTokens": [token] * 257}
        )


def test_batch_routes_are_registered_with_license_dependency():
    expected = {
        "/artifacts/claim",
        "/artifacts/renew",
        "/artifacts/release",
    }
    found = {}
    for route in results_route.router.routes:
        if getattr(route, "path", None) in expected:
            found[route.path] = route

    assert set(found) == expected
    for route in found.values():
        assert "POST" in route.methods
        dependency_calls = {
            dependency.call for dependency in route.dependant.dependencies
        }
        assert require_license in dependency_calls


def test_orphan_cleanup_keeps_live_lease_and_deletes_unleased_peer(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    leased = _write(results / "nup_aaaaaaaa.pdf", age_hours=30)
    unleased = _write(results / "nup_bbbbbbbb.pdf", age_hours=30)
    token = artifact_lease.create_artifact_lease("imposition", leased)
    assert artifact_lease.claim_artifact_lease(token, "tab-orphan")

    protected = artifact_lease.collect_artifact_lease_protected_path_keys()
    deleted, _freed = cleanup._cleanup_directory(
        results,
        system_time.time(),
        cleanup.FS_CLEANUP_MAX_AGE_HOURS * 3600,
        protected_path_keys=protected,
    )

    assert deleted == 1
    assert leased.exists()
    assert not unleased.exists()


def test_storage_pressure_rechecks_live_lease_before_unlink(
    tmp_path, monkeypatch,
):
    results, _uploads = _configure_results(tmp_path, monkeypatch)
    leased = _write(results / "nup_00000001.pdf", size=19, age_hours=5)
    unleased = _write(results / "nup_00000002.pdf", size=23, age_hours=5)
    token = artifact_lease.create_artifact_lease("imposition", leased)
    assert artifact_lease.claim_artifact_lease(token, "tab-pressure")

    monkeypatch.setattr(cleanup, "minimum_free_disk_bytes", lambda _total: 10_000)
    monkeypatch.setattr(cleanup, "_recovery_margin_bytes", lambda _total: 0)
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(100_000, 100_000, 0),
    )

    deleted, freed = cleanup._cleanup_storage_pressure(system_time.time())

    assert (deleted, freed) == (1, 23)
    assert leased.exists()
    assert not unleased.exists()

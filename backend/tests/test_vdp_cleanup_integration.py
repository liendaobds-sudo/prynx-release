"""Kiểm vòng cleanup nền gọi sweep job VDP qua import lazy."""

import asyncio

from app.api.routes import vdp
from app.core import cleanup


def test_cleanup_idle_sweep_calls_vdp_purge(monkeypatch):
    called = []
    monkeypatch.setattr(vdp, "_purge_old_jobs", lambda: called.append(True))

    cleanup._purge_vdp_jobs_idle()

    assert called == [True]


def test_cleanup_loop_runs_vdp_sweep_before_sleep(monkeypatch):
    calls = []
    monkeypatch.setattr(cleanup, "cleanup_expired", lambda: calls.append("db"))
    monkeypatch.setattr(cleanup, "cleanup_orphan_files", lambda: calls.append("fs"))
    monkeypatch.setattr(cleanup, "_purge_vdp_jobs_idle", lambda: calls.append("vdp"))
    monkeypatch.setattr(cleanup, "cleanup_resume_grace_seconds", lambda _elapsed: 0)

    async def stop_after_one_cycle(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr(cleanup.asyncio, "sleep", stop_after_one_cycle)
    try:
        asyncio.run(cleanup.cleanup_expired_files_loop())
    except asyncio.CancelledError:
        pass

    assert calls == ["db", "fs", "vdp"]


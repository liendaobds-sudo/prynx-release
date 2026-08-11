"""Gate vòng đời và hàng đợi của PPE ViewerSession dùng chung."""

from __future__ import annotations

import asyncio
import threading

import pytest

from app.core.ppe_viewer_session import (
    PpeViewerSessionManager,
    ViewerBackgroundSessionDeferred,
    ViewerFileStamp,
    ViewerSessionIdentity,
    ViewerSessionSuperseded,
    viewer_session_budget_policy,
)


def _identity(name: str = "job") -> ViewerSessionIdentity:
    return ViewerSessionIdentity(
        pdf=ViewerFileStamp(f"C:/fixtures/{name}.pdf", 100, 10, 11),
        cmyk_profile=ViewerFileStamp("C:/icc/FOGRA39.icc", 200, 20, 21),
        rgb_profile=ViewerFileStamp("C:/icc/sRGB.icm", 300, 30, 31),
        profile_id="fogra39",
        intent="relative",
        intent_code=1,
    )


class _FakeSession:
    def __init__(self, owner_id: str) -> None:
        self.owner_id = owner_id
        self.close_calls = 0

    def close(self, owner_id: str) -> bool:
        assert owner_id == self.owner_id
        self.close_calls += 1
        return self.close_calls == 1


class _FakeFactory:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.sessions: list[_FakeSession] = []

    def __call__(self, pdf_path: str, **kwargs) -> _FakeSession:
        self.calls.append({"pdf_path": pdf_path, **kwargs})
        session = _FakeSession(kwargs["owner_id"])
        self.sessions.append(session)
        return session


def _manager(factory, *, identity_is_current=lambda _identity: True):
    return PpeViewerSessionManager(
        open_session=factory,
        memory_status=lambda: (32 * 1024, 24 * 1024),
        identity_is_current=identity_is_current,
        session_overhead_mb=1,
        policy_refresh_seconds=60,
    )


def test_ngan_sach_chi_giam_may_yeu_va_tang_theo_ram_may_manh():
    low = viewer_session_budget_policy(4 * 1024, 2 * 1024)
    medium = viewer_session_budget_policy(12 * 1024, 8 * 1024)
    strong = viewer_session_budget_policy(32 * 1024, 16 * 1024)
    stronger = viewer_session_budget_policy(64 * 1024, 32 * 1024)

    assert low.desired_cache_mb < medium.desired_cache_mb
    assert strong.total_pool_mb > medium.total_pool_mb
    assert stronger.total_pool_mb > strong.total_pool_mb
    assert stronger.desired_cache_mb > strong.desired_cache_mb


@pytest.mark.asyncio
async def test_hai_owner_cung_revision_dung_mot_session_va_generation_noi_bo():
    factory = _FakeFactory()
    manager = _manager(factory)
    identity = _identity()

    await manager.bind_owner(identity, owner_id="tab-a", purpose="interactive")
    await manager.bind_owner(identity, owner_id="tab-b", purpose="background")

    first = await manager.render_lease(
        identity,
        owner_id="tab-a",
        purpose="interactive",
    )
    assert first.native_generation == 1
    native_owner = first.native_owner_id
    await first.release()

    second = await manager.render_lease(
        identity,
        owner_id="tab-b",
        purpose="interactive",
    )
    assert second.native_owner_id == native_owner
    assert second.native_generation == 2
    await second.release()

    assert len(factory.calls) == 1
    assert await manager.release_owner("tab-a") is True
    assert factory.sessions[0].close_calls == 0
    assert await manager.release_owner("tab-b") is True
    assert factory.sessions[0].close_calls == 1


@pytest.mark.asyncio
async def test_release_owner_cuoi_khong_dong_session_giua_render():
    factory = _FakeFactory()
    manager = _manager(factory)
    identity = _identity()

    lease = await manager.render_lease(
        identity,
        owner_id="tab-a",
        purpose="interactive",
    )
    assert await manager.release_owner("tab-a") is True
    assert factory.sessions[0].close_calls == 0

    await lease.release()
    assert factory.sessions[0].close_calls == 1
    assert manager.snapshot()["documents"] == 0


@pytest.mark.asyncio
async def test_interactive_vuot_background_dang_cho_cung_tai_lieu():
    factory = _FakeFactory()
    manager = _manager(factory)
    identity = _identity()
    for owner in ("current", "prefetch", "viewport"):
        await manager.bind_owner(identity, owner_id=owner, purpose="interactive")

    current = await manager.render_lease(
        identity,
        owner_id="current",
        purpose="interactive",
    )
    background_task = asyncio.create_task(
        manager.render_lease(
            identity,
            owner_id="prefetch",
            purpose="background",
        )
    )
    await asyncio.sleep(0)
    interactive_task = asyncio.create_task(
        manager.render_lease(
            identity,
            owner_id="viewport",
            purpose="interactive",
        )
    )
    await asyncio.sleep(0)

    await current.release()
    interactive = await asyncio.wait_for(interactive_task, timeout=1)
    assert interactive.native_generation == 2
    assert not background_task.done()

    await interactive.release()
    background = await asyncio.wait_for(background_task, timeout=1)
    assert background.native_generation == 3
    await background.release()
    await manager.close_all()


@pytest.mark.asyncio
async def test_interactive_den_luc_dang_evict_khong_bi_defer_theo_background():
    close_entered = threading.Event()
    allow_close = threading.Event()
    low_memory = False
    sessions: list[_FakeSession] = []

    class BlockingCloseSession(_FakeSession):
        def close(self, owner_id: str) -> bool:
            close_entered.set()
            assert allow_close.wait(timeout=2)
            return super().close(owner_id)

    def factory(_pdf_path: str, **kwargs):
        session = (
            BlockingCloseSession(kwargs["owner_id"])
            if not sessions
            else _FakeSession(kwargs["owner_id"])
        )
        sessions.append(session)
        return session

    def memory_status():
        return (4096.0, 1024.0) if low_memory else (32768.0, 24576.0)

    manager = PpeViewerSessionManager(
        open_session=factory,
        memory_status=memory_status,
        identity_is_current=lambda _identity: True,
        session_overhead_mb=200,
        policy_refresh_seconds=0,
    )
    idle = await manager.render_lease(
        _identity("idle"),
        owner_id="idle-owner",
        purpose="interactive",
    )
    await idle.release()
    low_memory = True
    target = _identity("target")
    background_task = asyncio.create_task(
        manager.render_lease(
            target,
            owner_id="background-owner",
            purpose="background",
        )
    )
    assert await asyncio.to_thread(close_entered.wait, 1)
    interactive_task = asyncio.create_task(
        manager.render_lease(
            target,
            owner_id="interactive-owner",
            purpose="interactive",
        )
    )
    await asyncio.sleep(0)
    allow_close.set()

    interactive = await asyncio.wait_for(interactive_task, timeout=2)
    assert interactive.native_generation == 1
    await interactive.release()
    background = await asyncio.wait_for(background_task, timeout=2)
    assert background.native_generation == 2
    await background.release()
    assert len(sessions) == 2
    await manager.close_all()


@pytest.mark.asyncio
async def test_eviction_giu_ram_pending_va_khong_reopen_victim_truoc_close():
    close_entered = threading.Event()
    allow_close = threading.Event()
    low_memory = False
    sessions: list[_FakeSession] = []

    class BlockingCloseSession(_FakeSession):
        def close(self, owner_id: str) -> bool:
            close_entered.set()
            assert allow_close.wait(timeout=2)
            return super().close(owner_id)

    def factory(_pdf_path: str, **kwargs):
        session = (
            BlockingCloseSession(kwargs["owner_id"])
            if not sessions
            else _FakeSession(kwargs["owner_id"])
        )
        sessions.append(session)
        return session

    def memory_status():
        return (4096.0, 1024.0) if low_memory else (32768.0, 24576.0)

    manager = PpeViewerSessionManager(
        open_session=factory,
        memory_status=memory_status,
        identity_is_current=lambda _identity: True,
        session_overhead_mb=64,
        policy_refresh_seconds=0,
    )
    victim_identity = _identity("victim")
    victim = await manager.render_lease(
        victim_identity,
        owner_id="victim-owner",
        purpose="interactive",
    )
    await victim.release()
    low_memory = True

    target_identity = _identity("target-after-eviction")
    target_task = asyncio.create_task(
        manager.render_lease(
            target_identity,
            owner_id="target-owner",
            purpose="background",
        )
    )
    assert await asyncio.to_thread(close_entered.wait, 1)
    # Request quay lại victim phải đợi wrapper cũ close xong; không
    # mở hai native document/cache cùng revision đồng thời.
    reopen_task = asyncio.create_task(
        manager.render_lease(
            victim_identity,
            owner_id="victim-owner",
            purpose="interactive",
        )
    )
    await asyncio.sleep(0.02)
    assert len(sessions) == 1
    assert not reopen_task.done()
    assert manager.snapshot()["reserved_mb"] >= 64

    # Opener thứ ba vẫn thấy RAM của victim đang close; background
    # không được lách pool rồi tạo peak double-residency.
    with pytest.raises(ViewerBackgroundSessionDeferred):
        await manager.render_lease(
            _identity("third"),
            owner_id="third-owner",
            purpose="background",
        )
    assert len(sessions) == 1

    allow_close.set()
    reopened = await asyncio.wait_for(reopen_task, timeout=2)
    target = await asyncio.wait_for(target_task, timeout=2)
    await reopened.release()
    await target.release()
    assert len(sessions) == 3
    await manager.close_all()


@pytest.mark.asyncio
async def test_cancel_caller_close_van_giu_reservation_den_khi_native_dong_xong():
    close_entered = threading.Event()
    allow_close = threading.Event()
    sessions: list[_FakeSession] = []

    class BlockingCloseSession(_FakeSession):
        def close(self, owner_id: str) -> bool:
            close_entered.set()
            assert allow_close.wait(timeout=2)
            return super().close(owner_id)

    def factory(_pdf_path: str, **kwargs):
        session = (
            BlockingCloseSession(kwargs["owner_id"])
            if not sessions
            else _FakeSession(kwargs["owner_id"])
        )
        sessions.append(session)
        return session

    manager = _manager(factory)
    identity = _identity("cancel-close")
    lease = await manager.render_lease(
        identity,
        owner_id="tab-old",
        purpose="interactive",
    )
    await lease.release()

    release_task = asyncio.create_task(manager.release_owner("tab-old"))
    assert await asyncio.to_thread(close_entered.wait, 1)
    release_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await release_task
    assert manager.snapshot()["reserved_mb"] > 0

    reopen_task = asyncio.create_task(
        manager.render_lease(
            identity,
            owner_id="tab-new",
            purpose="interactive",
        )
    )
    await asyncio.sleep(0.02)
    assert len(sessions) == 1
    assert not reopen_task.done()

    allow_close.set()
    reopened = await asyncio.wait_for(reopen_task, timeout=2)
    await reopened.release()
    assert len(sessions) == 2
    await manager.close_all()
    assert manager.snapshot()["reserved_mb"] == 0


@pytest.mark.asyncio
async def test_delete_vuot_post_chi_chan_generation_cu_khong_pha_strict_mode():
    factory = _FakeFactory()
    manager = _manager(factory)
    identity = _identity("release-watermark")

    # StrictMode cleanup trước request đầu gửi watermark 0; generation 1
    # của setup kế tiếp vẫn phải được phép.
    assert await manager.release_owner(
        "tab-a",
        through_generation=0,
    ) is False
    await manager.bind_owner(
        identity,
        owner_id="tab-a",
        purpose="interactive",
        owner_generation=1,
    )
    assert await manager.release_owner(
        "tab-a",
        through_generation=1,
    ) is True

    # POST generation 1 đến muộn sau DELETE không được hồi sinh owner.
    with pytest.raises(ViewerSessionSuperseded, match="release tới generation 1"):
        await manager.bind_owner(
            identity,
            owner_id="tab-a",
            purpose="interactive",
            owner_generation=1,
        )

    # Setup/request thật sự mới có generation cao hơn vẫn dùng lại
    # owner trong dev StrictMode mà không bị tombstone vĩnh viễn.
    await manager.bind_owner(
        identity,
        owner_id="tab-a",
        purpose="interactive",
        owner_generation=2,
    )
    # Hai HTTP request cùng revision có thể tới đảo thứ tự do
    # bước ký request bất đồng bộ. g2 vẫn hợp lệ sau g3 và
    # không được hạ latest watermark của binding xuống dưới g3.
    await manager.bind_owner(
        identity,
        owner_id="tab-a",
        purpose="background",
        owner_generation=3,
    )
    await manager.bind_owner(
        identity,
        owner_id="tab-a",
        purpose="interactive",
        owner_generation=2,
    )
    with pytest.raises(ViewerSessionSuperseded, match="không khớp revision"):
        await manager.bind_owner(
            _identity("revision-khac"),
            owner_id="tab-a",
            purpose="interactive",
            owner_generation=3,
        )
    lease = await manager.render_lease(
        identity,
        owner_id="tab-a",
        purpose="interactive",
        owner_generation=2,
    )
    await lease.release()
    assert len(factory.sessions) == 1
    # DELETE cũ đến sau setup g3 không được đóng binding;
    # sau watermark này, POST g2 mới đến sẽ bị loại như chủ đích.
    assert await manager.release_owner(
        "tab-a",
        through_generation=2,
    ) is False
    assert await manager.release_owner(
        "tab-a",
        through_generation=3,
    ) is True
    await manager.close_all()


@pytest.mark.asyncio
async def test_request_het_waiter_khong_di_tiep_sang_native_render():
    factory = _FakeFactory()
    manager = _manager(factory)
    identity = _identity()

    with pytest.raises(ViewerSessionSuperseded):
        await manager.render_lease(
            identity,
            owner_id="tab-a",
            purpose="interactive",
            still_interested=lambda: False,
        )

    assert len(factory.calls) == 1
    assert manager.snapshot()["active_renders"] == 0
    await manager.close_all()


@pytest.mark.asyncio
async def test_checkpoint_loi_van_nha_lane_cho_request_ke_tiep():
    factory = _FakeFactory()
    manager = _manager(factory)
    identity = _identity()

    def broken_checkpoint() -> bool:
        raise RuntimeError("checkpoint broken")

    with pytest.raises(RuntimeError, match="checkpoint broken"):
        await manager.render_lease(
            identity,
            owner_id="tab-a",
            purpose="interactive",
            still_interested=broken_checkpoint,
        )

    assert manager.snapshot()["active_renders"] == 0
    next_lease = await asyncio.wait_for(
        manager.render_lease(
            identity,
            owner_id="tab-a",
            purpose="interactive",
        ),
        timeout=1,
    )
    await next_lease.release()
    await manager.close_all()


@pytest.mark.asyncio
async def test_owner_huy_luc_open_khong_lam_ro_ri_session_mo_muon():
    entered = threading.Event()
    proceed = threading.Event()
    sessions: list[_FakeSession] = []

    def slow_open(_pdf_path: str, **kwargs):
        entered.set()
        assert proceed.wait(timeout=2)
        session = _FakeSession(kwargs["owner_id"])
        sessions.append(session)
        return session

    manager = _manager(slow_open)
    identity = _identity()
    task = asyncio.create_task(
        manager.render_lease(
            identity,
            owner_id="tab-a",
            purpose="interactive",
        )
    )
    assert await asyncio.to_thread(entered.wait, 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await manager.release_owner("tab-a") is True
    proceed.set()

    for _ in range(100):
        if sessions and sessions[0].close_calls:
            break
        await asyncio.sleep(0.01)
    assert len(sessions) == 1
    assert sessions[0].close_calls == 1
    assert manager.snapshot()["documents"] == 0


@pytest.mark.asyncio
async def test_owner_huy_roi_open_loi_khong_de_lai_entry_mo_coi():
    entered = threading.Event()
    proceed = threading.Event()

    def slow_failure(_pdf_path: str, **_kwargs):
        entered.set()
        assert proceed.wait(timeout=2)
        raise RuntimeError("open failed")

    manager = _manager(slow_failure)
    identity = _identity()
    task = asyncio.create_task(
        manager.render_lease(
            identity,
            owner_id="tab-a",
            purpose="interactive",
        )
    )
    assert await asyncio.to_thread(entered.wait, 1)
    assert await manager.release_owner("tab-a") is True
    with pytest.raises(ViewerSessionSuperseded):
        await task
    proceed.set()

    for _ in range(100):
        if manager.snapshot()["documents"] == 0:
            break
        await asyncio.sleep(0.01)
    assert manager.snapshot() == {
        "documents": 0,
        "owners": 0,
        "open_sessions": 0,
        "active_renders": 0,
        "queued_renders": 0,
        "reserved_mb": 0,
        "cache_budget_mb": 0,
    }


@pytest.mark.asyncio
async def test_identity_doi_trong_luc_open_dong_session_va_fail_closed():
    factory = _FakeFactory()
    manager = _manager(factory, identity_is_current=lambda _identity: False)

    with pytest.raises(ViewerSessionSuperseded):
        await manager.render_lease(
            _identity(),
            owner_id="tab-a",
            purpose="interactive",
        )

    assert len(factory.sessions) == 1
    await manager.close_all()
    assert factory.sessions[0].close_calls == 1

"""Gate vòng đời và hàng đợi của PPE ViewerSession dùng chung."""

from __future__ import annotations

import asyncio
import threading

import pytest

from app.core import icc_profiles
from app.core.print_engine import facade as ppe_facade
from app.core.print_engine.facade import PpeUnavailable
from app.core.ppe_viewer_session import (
    PPE_VIEWER_SESSION_IDENTITY_VERSION,
    PpeViewerSessionManager,
    ViewerBackgroundSessionDeferred,
    ViewerFileStamp,
    ViewerSessionIdentity,
    ViewerSessionSuperseded,
    viewer_session_budget_policy,
)


def _pdf(objects: list[bytes], root_id: int = 1) -> bytes:
    """Ghi PDF fixture tối thiểu có xref chuẩn và byte ổn định."""
    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for object_id, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{object_id} 0 obj\n".encode("ascii"))
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root {root_id} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def _stream(dictionary: bytes, content: bytes) -> bytes:
    return (
        b"<< "
        + dictionary
        + f" /Length {len(content)} >>\nstream\n".encode("ascii")
        + content
        + b"\nendstream"
    )


def _viewer_fixture_bytes() -> dict[str, bytes]:
    """Hai artifact phân biệt trực tiếp Print/View và annotation off/on."""
    ocg_content = b"q /OC /Layer BDC 0.10 0.60 0.90 rg 20 20 160 160 re f EMC Q"
    ocg = _pdf(
        [
            (
                b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] "
                b"/D << /Order [5 0 R] /ON [5 0 R] /OFF [] "
                b"/AS [<< /Event /View /Category [/View] /OCGs [5 0 R] >> "
                b"<< /Event /Print /Category [/Print] /OCGs [5 0 R] >>] >> >> >>"
            ),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            (
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
                b"/Resources << /Properties << /Layer 5 0 R >> >> /Contents 4 0 R >>"
            ),
            _stream(b"", ocg_content),
            (
                b"<< /Type /OCG /Name (Viewer Layer) /Usage << "
                b"/View << /ViewState /ON >> /Print << /PrintState /OFF >> >> >>"
            ),
        ]
    )

    appearance = b"0.90 0.20 0.20 rg 0 0 160 60 re f"
    annotation = _pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            (
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] "
                b"/Resources << >> /Contents 4 0 R /Annots [5 0 R] >>"
            ),
            _stream(b"", b"q Q"),
            (
                b"<< /Type /Annot /Subtype /Widget /Rect [20 20 180 80] /F 4 "
                b"/AP << /N 6 0 R >> >>"
            ),
            _stream(
                b"/Type /XObject /Subtype /Form /BBox [0 0 160 60] /Resources << >>",
                appearance,
            ),
        ]
    )
    return {"ocg_view.pdf": ocg, "annotation_ap.pdf": annotation}


def _dark_pixel_count(rgb: bytes) -> int:
    assert len(rgb) % 3 == 0
    return sum(
        1
        for offset in range(0, len(rgb), 3)
        if min(rgb[offset : offset + 3]) < 245
    )


class _FakeSoftproofNative:
    def __init__(self, caps: dict[str, object] | None = None) -> None:
        self.caps = dict(caps or {})
        self.capability_calls = 0
        self.softproof_calls: list[dict[str, object]] = []

    def ppe_capabilities(self) -> dict[str, object]:
        self.capability_calls += 1
        return dict(self.caps)

    def ppe_softproof(self, pdf_path: str, **kwargs) -> dict[str, object]:
        self.softproof_calls.append({"pdf_path": pdf_path, **kwargs})
        return {
            "width": 1,
            "height": 1,
            "rgb": b"\xff\xff\xff",
            "degraded": False,
            "ink_unsound": False,
        }


def _install_fake_softproof_native(monkeypatch, native: _FakeSoftproofNative) -> None:
    monkeypatch.setattr(ppe_facade, "_native", lambda: native)
    monkeypatch.setattr(ppe_facade, "_memory_budget_mb", lambda: 512)
    monkeypatch.setattr(ppe_facade, "_fallback_font_path", lambda: None)
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id: "C:/profiles/FOGRA39.icc",
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: "C:/profiles/sRGB.icc",
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
    assert factory.calls[0]["optional_content_usage"] == "view"
    assert factory.calls[0]["render_annotations"] is True
    assert identity.engine_version == "ppe-viewer-session-v2-view-annotations"
    assert identity.engine_version == PPE_VIEWER_SESSION_IDENTITY_VERSION
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


def test_facade_mac_dinh_khong_gui_keyword_moi_cho_native_cu(monkeypatch):
    native = _FakeSoftproofNative()
    _install_fake_softproof_native(monkeypatch, native)

    ppe_facade.softproof("C:/fixtures/default-policy.pdf", 1)

    assert native.capability_calls == 0
    assert len(native.softproof_calls) == 1
    kwargs = native.softproof_calls[0]
    assert "optional_content_usage" not in kwargs
    assert "render_annotations" not in kwargs


def test_facade_gui_policy_viewer_khi_binding_khai_capability(monkeypatch):
    native = _FakeSoftproofNative(
        {
            "softproof_optional_content_usage_option": True,
            "softproof_render_annotations_option": True,
        }
    )
    _install_fake_softproof_native(monkeypatch, native)

    ppe_facade.softproof(
        "C:/fixtures/viewer-policy.pdf",
        1,
        optional_content_usage=" ViEw ",
        render_annotations=True,
    )

    assert native.capability_calls == 1
    assert len(native.softproof_calls) == 1
    kwargs = native.softproof_calls[0]
    assert kwargs["optional_content_usage"] == "view"
    assert kwargs["render_annotations"] is True


@pytest.mark.parametrize(
    "missing_capability",
    [
        "softproof_optional_content_usage_option",
        "softproof_render_annotations_option",
    ],
)
def test_facade_thieu_capability_viewer_phai_fail_truoc_native_call(
    monkeypatch,
    missing_capability,
):
    caps = {
        "softproof_optional_content_usage_option": True,
        "softproof_render_annotations_option": True,
    }
    caps.pop(missing_capability)
    native = _FakeSoftproofNative(caps)
    _install_fake_softproof_native(monkeypatch, native)

    with pytest.raises(PpeUnavailable, match="pdfcompare_native chưa hỗ trợ"):
        ppe_facade.softproof(
            "C:/fixtures/missing-capability.pdf",
            1,
            optional_content_usage="view",
            render_annotations=True,
        )

    assert native.capability_calls == 1
    assert native.softproof_calls == []


def test_session_stateless_fallback_giu_nguyen_policy_viewer(monkeypatch):
    captured: dict[str, object] = {}

    def fake_softproof(*_args, **kwargs):
        captured.update(kwargs)
        return {
            "width": 1,
            "height": 1,
            "rgb": b"\xff\xff\xff",
            "degraded": False,
            "ink_unsound": False,
        }

    monkeypatch.setattr(ppe_facade, "softproof", fake_softproof)
    session = ppe_facade.PpeSoftproofSession(
        pdf_path="C:/fixtures/session-fallback.pdf",
        owner_id="viewer-owner",
        cmyk_profile_id="fogra39",
        render_intent=1,
        native_session=None,
        open_info={"engine": "ppe", "valid": True},
        optional_content_usage="view",
        render_annotations=True,
    )

    result = session.render(
        owner_id="viewer-owner",
        request_generation=1,
        pdf_path="C:/fixtures/session-fallback.pdf",
        cmyk_profile_id="fogra39",
        render_intent=1,
        page_num=1,
    )

    assert captured["optional_content_usage"] == "view"
    assert captured["render_annotations"] is True
    assert result["session_mode"] == "stateless_fallback"


@pytest.mark.parametrize("fixture_name", ["ocg_view.pdf", "annotation_ap.pdf"])
def test_artifact_viewer_stateless_va_session_dung_cung_policy(
    tmp_path,
    fixture_name,
):
    try:
        caps = ppe_facade.capabilities()
    except (PpeUnavailable, AttributeError):
        pytest.skip("cần build pdfcompare_native có PPE")
    required = (
        "softproof_optional_content_usage_option",
        "softproof_render_annotations_option",
        "render_session",
    )
    if not all(caps.get(name) for name in required):
        pytest.skip("native hiện tại chưa có contract Viewer Lô B")
    if not icc_profiles.resolve_cmyk_profile_path("fogra39"):
        pytest.skip("thiếu profile FOGRA39 để kiểm artifact soft-proof")

    pdf_path = tmp_path / fixture_name
    pdf_path.write_bytes(_viewer_fixture_bytes()[fixture_name])
    default_result = ppe_facade.softproof(
        str(pdf_path),
        1,
        dpi=72,
        simulate_overprint=False,
    )
    stateless_result = ppe_facade.softproof(
        str(pdf_path),
        1,
        dpi=72,
        simulate_overprint=False,
        optional_content_usage="view",
        render_annotations=True,
    )

    owner_id = f"artifact-{fixture_name}"
    session = ppe_facade.open_softproof_session(
        str(pdf_path),
        owner_id=owner_id,
        cmyk_profile_id="fogra39",
        render_intent=1,
        resource_cache_budget_mb=16,
        optional_content_usage="view",
        render_annotations=True,
    )
    if not session.uses_native_session:
        session.close(owner_id)
        pytest.skip("native hiện tại chưa có PpeRenderSession")
    try:
        session_result = session.render(
            owner_id=owner_id,
            request_generation=1,
            pdf_path=str(pdf_path),
            cmyk_profile_id="fogra39",
            render_intent=1,
            page_num=1,
            dpi=72,
            simulate_overprint=False,
        )
    finally:
        session.close(owner_id)

    assert _dark_pixel_count(default_result["rgb"]) == 0
    assert _dark_pixel_count(stateless_result["rgb"]) > 0
    assert (stateless_result["width"], stateless_result["height"]) == (
        session_result["width"],
        session_result["height"],
    )
    assert stateless_result["rgb"] == session_result["rgb"]

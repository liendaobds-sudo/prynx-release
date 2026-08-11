"""Regression cho cache PNG chuẩn màu của Viewer."""

import asyncio
import base64
import struct
import threading
import zlib

import pytest

from app.core import ppe_viewer_session
from app.core import viewer_accurate_cache as cache


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _png_chunk(chunk_type: bytes, data: bytes = b"") -> bytes:
    crc = zlib.crc32(chunk_type)
    crc = zlib.crc32(data, crc) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def test_cache_version_da_loai_bo_artifact_unsound_cu():
    assert cache.VIEWER_ACCURATE_CACHE_VERSION == "ppe-viewer-accurate-v5-output-preview"


def _prepare_profiles(tmp_path, monkeypatch):
    cmyk = tmp_path / "FOGRA39.icc"
    rgb = tmp_path / "sRGB.icm"
    cmyk.write_bytes(b"cmyk-profile")
    rgb.write_bytes(b"rgb-profile")
    monkeypatch.setattr(
        ppe_viewer_session,
        "resolve_cmyk_profile_path",
        lambda _profile: str(cmyk),
    )
    monkeypatch.setattr(
        ppe_viewer_session,
        "resolve_srgb_profile_path",
        lambda: str(rgb),
    )


def test_render_concurrency_only_caps_low_memory_machines():
    assert cache.render_concurrency_for_total_ram(None) is None
    assert cache.render_concurrency_for_total_ram(4 * 1024) == 1
    assert cache.render_concurrency_for_total_ram(8 * 1024) == 2
    assert cache.render_concurrency_for_total_ram(15 * 1024) == 2
    assert cache.render_concurrency_for_total_ram(16 * 1024) is None
    assert cache.render_concurrency_for_total_ram(64 * 1024) is None


def test_cache_key_invalidates_when_pdf_or_profile_changes(tmp_path, monkeypatch):
    _prepare_profiles(tmp_path, monkeypatch)
    pdf = tmp_path / "job.pdf"
    pdf.write_bytes(b"pdf-v1")

    first = cache.build_accurate_cache_key(
        str(pdf), page=1, dpi=96, profile_id="fogra39", intent="relative"
    )
    pdf.write_bytes(b"pdf-version-two")
    second = cache.build_accurate_cache_key(
        str(pdf), page=1, dpi=96, profile_id="fogra39", intent="relative"
    )

    assert first != second
    assert second != cache.build_accurate_cache_key(
        str(pdf), page=2, dpi=96, profile_id="fogra39", intent="relative"
    )
    assert second != cache.build_accurate_cache_key(
        str(pdf), page=1, dpi=144, profile_id="fogra39", intent="relative"
    )
    full_page = cache.build_accurate_cache_key(
        str(pdf), page=1, dpi=96, profile_id="fogra39", intent="relative"
    )
    tile_a = cache.build_accurate_cache_key(
        str(pdf),
        page=1,
        dpi=96,
        profile_id="fogra39",
        intent="relative",
        clip=(0, 0, 512, 512),
    )
    tile_b = cache.build_accurate_cache_key(
        str(pdf),
        page=1,
        dpi=96,
        profile_id="fogra39",
        intent="relative",
        clip=(256, 0, 512, 512),
    )
    assert len({full_page, tile_a, tile_b}) == 3

    proof_variants = {
        cache.build_accurate_cache_key(
            str(pdf), page=1, dpi=96, profile_id="fogra39", intent="relative"
        ),
        cache.build_accurate_cache_key(
            str(pdf),
            page=1,
            dpi=96,
            profile_id="fogra39",
            intent="relative",
            output_preview_filter="images",
        ),
        cache.build_accurate_cache_key(
            str(pdf),
            page=1,
            dpi=96,
            profile_id="fogra39",
            intent="relative",
            simulate_paper_color=True,
        ),
        cache.build_accurate_cache_key(
            str(pdf),
            page=1,
            dpi=96,
            profile_id="fogra39",
            intent="relative",
            simulate_black_ink=True,
        ),
        cache.build_accurate_cache_key(
            str(pdf),
            page=1,
            dpi=96,
            profile_id="fogra39",
            intent="relative",
            page_background_rgb=(214, 190, 142),
        ),
    }
    assert len(proof_variants) == 5


def test_request_scope_tach_owner_nhung_giu_on_dinh_khi_save_over(tmp_path):
    pdf = tmp_path / "scope.pdf"
    pdf.write_bytes(b"v1")
    owner_a = cache.build_accurate_request_scope(str(pdf), "viewer-a")
    owner_b = cache.build_accurate_request_scope(str(pdf), "viewer-b")
    pdf.write_bytes(b"version-two")
    owner_a_v2 = cache.build_accurate_request_scope(str(pdf), "viewer-a")

    assert owner_a != owner_b
    assert owner_a_v2 == owner_a


def test_cache_roundtrip_rejects_corrupt_png(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    key = "a" * 64

    cache.write_cached_png(key, PNG)
    assert cache.read_cached_png(key) == PNG

    path = tmp_path / "viewer_accurate_cache" / f"{key}.png"
    path.write_bytes(cache.PNG_SIGNATURE + b"truncated")
    assert cache.read_cached_png(key) is None
    assert not path.exists()

    with pytest.raises(ValueError, match="không phải PNG"):
        cache.write_cached_png(key, cache.PNG_SIGNATURE + b"truncated")

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    png_without_idat = (
        cache.PNG_SIGNATURE + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IEND")
    )
    assert cache._is_complete_png(png_without_idat) is False
    with pytest.raises(ValueError, match="không phải PNG"):
        cache.write_cached_png(key, png_without_idat)


@pytest.mark.asyncio
async def test_same_key_renders_once_then_hits_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    key = "b" * 64
    calls = 0

    async def renderer():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.02)
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    first, second = await asyncio.gather(
        cache.get_or_render_accurate_png(key, renderer),
        cache.get_or_render_accurate_png(key, renderer),
    )

    assert calls == 1
    assert {first.status, second.status} == {"miss", "shared"}
    assert first.rendered.data == second.rendered.data == PNG

    async def must_not_render():
        raise AssertionError("cache hit không được render lại")

    third = await cache.get_or_render_accurate_png(key, must_not_render)
    assert third.status == "disk-hit"
    assert third.rendered.engine == "persistent-cache"


@pytest.mark.asyncio
async def test_miss_cu_khong_render_lai_sau_khi_owner_truoc_vua_ghi_xong(monkeypatch):
    """Khóa khe disk-miss → inflight-done từng làm cùng key dựng PPE hai lần."""
    key = "0" * 64
    stored: bytes | None = None
    read_count = 0
    write_count = 0
    state_guard = threading.Lock()
    sampled_old_miss = threading.Event()
    allow_old_miss_return = threading.Event()

    def fake_read(_key: str) -> bytes | None:
        nonlocal read_count
        with state_guard:
            read_count += 1
            current = stored
            should_pause = read_count == 3
        if should_pause:
            sampled_old_miss.set()
            if not allow_old_miss_return.wait(2):
                raise RuntimeError("test chờ disk miss quá hạn")
        return current

    def fake_write(_key: str, data: bytes) -> None:
        nonlocal stored, write_count
        with state_guard:
            stored = data
            write_count += 1

    monkeypatch.setattr(cache, "read_cached_png", fake_read)
    monkeypatch.setattr(cache, "write_cached_png", fake_write)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: None)
    renderer_calls = 0
    first_started = asyncio.Event()
    release_first = asyncio.Event()

    async def renderer():
        nonlocal renderer_calls
        renderer_calls += 1
        if renderer_calls == 1:
            first_started.set()
            await release_first.wait()
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    first = asyncio.create_task(cache.get_or_render_accurate_png(key, renderer))
    await asyncio.wait_for(first_started.wait(), timeout=1)
    second = asyncio.create_task(cache.get_or_render_accurate_png(key, renderer))
    for _ in range(100):
        if sampled_old_miss.is_set():
            break
        await asyncio.sleep(0.001)
    assert sampled_old_miss.is_set()

    release_first.set()
    first_result = await asyncio.wait_for(first, timeout=1)
    for _ in range(100):
        if key not in cache._inflight:
            break
        await asyncio.sleep(0)
    allow_old_miss_return.set()
    second_result = await asyncio.wait_for(second, timeout=1)

    assert renderer_calls == 1
    assert write_count == 1
    assert first_result.status == "miss"
    assert second_result.status == "disk-hit"


@pytest.mark.asyncio
async def test_loi_ghi_disk_cache_khong_lam_mat_anh_da_render(monkeypatch):
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)

    def fail_write(_key: str, _data: bytes) -> None:
        raise OSError("ổ đĩa chỉ đọc")

    monkeypatch.setattr(cache, "write_cached_png", fail_write)

    async def renderer():
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    result = await cache.get_or_render_accurate_png("1" * 64, renderer)

    assert result.rendered.data == PNG
    assert result.status == "miss"


@pytest.mark.asyncio
async def test_inaccurate_result_is_never_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    key = "c" * 64

    async def renderer():
        return cache.RenderedAccuratePng(PNG, engine="fallback", accuracy="approximate")

    with pytest.raises(RuntimeError, match="PPE/RIP"):
        await cache.get_or_render_accurate_png(key, renderer)
    assert cache.read_cached_png(key) is None


@pytest.mark.asyncio
async def test_low_memory_gate_serializes_different_pages(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    gate = asyncio.Semaphore(1)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: gate)
    active = 0
    peak = 0

    async def renderer():
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    await asyncio.gather(
        cache.get_or_render_accurate_png("d" * 64, renderer),
        cache.get_or_render_accurate_png("e" * 64, renderer),
    )

    assert peak == 1


@pytest.mark.asyncio
async def test_abort_waiter_cuoi_huy_task_con_dang_cho_quota(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    gate = asyncio.Semaphore(0)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: gate)
    calls = 0

    async def renderer():
        nonlocal calls
        calls += 1
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    waiter = asyncio.create_task(
        cache.get_or_render_accurate_png("1" * 64, renderer)
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if "1" * 64 in cache._inflight:
            break
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    await asyncio.sleep(0)

    assert calls == 0
    assert "1" * 64 not in cache._inflight


@pytest.mark.asyncio
async def test_generation_moi_loai_request_cu_truoc_khi_ppe_chay(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    gate = asyncio.Semaphore(0)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: gate)
    old_calls = 0
    new_calls = 0
    scope = f"generation:{tmp_path}"

    async def old_renderer():
        nonlocal old_calls
        old_calls += 1
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    async def new_renderer():
        nonlocal new_calls
        new_calls += 1
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    old_waiter = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "2" * 64,
            old_renderer,
            interest=cache.AccurateRenderInterest(scope, generation=1, request_id="old"),
        )
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if "2" * 64 in cache._inflight:
            break
    new_waiter = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "3" * 64,
            new_renderer,
            interest=cache.AccurateRenderInterest(scope, generation=2, request_id="new"),
        )
    )

    with pytest.raises(cache.AccurateRequestSuperseded):
        await asyncio.wait_for(old_waiter, timeout=1)
    gate.release()
    result = await asyncio.wait_for(new_waiter, timeout=1)

    assert result.rendered.data == PNG
    assert old_calls == 0
    assert new_calls == 1
    assert cache.read_cached_png("2" * 64) is None


@pytest.mark.asyncio
async def test_interactive_cung_generation_loai_background_con_cho(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    gate = asyncio.Semaphore(0)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: gate)
    scope = f"purpose:{tmp_path}"
    background_calls = 0

    async def background_renderer():
        nonlocal background_calls
        background_calls += 1
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    async def interactive_renderer():
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    background = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "4" * 64,
            background_renderer,
            interest=cache.AccurateRenderInterest(scope, 7, purpose="background"),
        )
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if "4" * 64 in cache._inflight:
            break
    interactive = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "5" * 64,
            interactive_renderer,
            interest=cache.AccurateRenderInterest(scope, 7, purpose="interactive"),
        )
    )

    with pytest.raises(cache.AccurateRequestSuperseded):
        await asyncio.wait_for(background, timeout=1)
    gate.release()
    assert (await asyncio.wait_for(interactive, timeout=1)).rendered.data == PNG
    assert background_calls == 0


@pytest.mark.asyncio
async def test_task_da_vao_ppe_giu_gate_nhung_khong_ghi_cache_khi_stale(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: None)
    scope = f"running:{tmp_path}"
    started = asyncio.Event()
    release = asyncio.Event()

    async def old_renderer():
        started.set()
        await release.wait()
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    async def new_renderer():
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    old_waiter = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "6" * 64,
            old_renderer,
            interest=cache.AccurateRenderInterest(scope, 1),
        )
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    old_entry_task = cache._inflight["6" * 64].task
    new_waiter = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "7" * 64,
            new_renderer,
            interest=cache.AccurateRenderInterest(scope, 2),
        )
    )
    with pytest.raises(cache.AccurateRequestSuperseded):
        await old_waiter

    # PPE native cũ không thể dừng giữa thread, nhưng request mới không được chạy
    # chồng lên và tạo backlog/RAM spike cho cùng một tab.
    await asyncio.sleep(0)
    assert not new_waiter.done()
    release.set()
    assert old_entry_task is not None
    await asyncio.wait_for(old_entry_task, timeout=1)
    new_result = await asyncio.wait_for(new_waiter, timeout=1)

    assert new_result.rendered.data == PNG
    assert cache.read_cached_png("6" * 64) is None


@pytest.mark.asyncio
async def test_zoom_nhanh_chi_giu_job_dang_chay_va_the_he_cuoi(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: None)
    scope = f"rapid:{tmp_path}"
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    calls: list[int] = []
    active = 0
    peak = 0

    def renderer_for(generation: int):
        async def renderer():
            nonlocal active, peak
            calls.append(generation)
            active += 1
            peak = max(peak, active)
            if generation == 1:
                first_started.set()
                await release_first.wait()
            active -= 1
            return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

        return renderer

    first = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "a" * 64,
            renderer_for(1),
            interest=cache.AccurateRenderInterest(scope, 1),
        )
    )
    await asyncio.wait_for(first_started.wait(), timeout=1)
    middle = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "b" * 64,
            renderer_for(2),
            interest=cache.AccurateRenderInterest(scope, 2),
        )
    )
    await asyncio.sleep(0)
    latest = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "c" * 64,
            renderer_for(3),
            interest=cache.AccurateRenderInterest(scope, 3),
        )
    )

    with pytest.raises(cache.AccurateRequestSuperseded):
        await first
    with pytest.raises(cache.AccurateRequestSuperseded):
        await middle
    release_first.set()
    await asyncio.wait_for(latest, timeout=1)

    assert calls == [1, 3]
    assert peak == 1


@pytest.mark.asyncio
async def test_interactive_vuot_background_dang_chay_tren_may_du_ram(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: None)
    scope = f"priority:{tmp_path}"
    background_started = asyncio.Event()
    release_background = asyncio.Event()

    async def background_renderer():
        background_started.set()
        await release_background.wait()
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    background = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "d" * 64,
            background_renderer,
            interest=cache.AccurateRenderInterest(scope, 1, purpose="background"),
        )
    )
    await asyncio.wait_for(background_started.wait(), timeout=1)
    background_task = cache._inflight["d" * 64].task

    interactive = await asyncio.wait_for(
        cache.get_or_render_accurate_png(
            "e" * 64,
            lambda: asyncio.sleep(
                0, result=cache.RenderedAccuratePng(PNG, engine="ppe+lcms")
            ),
            interest=cache.AccurateRenderInterest(scope, 2, purpose="interactive"),
        ),
        timeout=1,
    )
    with pytest.raises(cache.AccurateRequestSuperseded):
        await background
    release_background.set()
    assert background_task is not None
    await asyncio.wait_for(background_task, timeout=1)

    assert interactive.rendered.data == PNG


@pytest.mark.asyncio
async def test_waiter_owner_khac_giu_single_flight_khi_owner_cu_bi_thay_the(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(cache, "read_cached_png", lambda _key: None)
    monkeypatch.setattr(cache, "_render_gate_for_current_loop", lambda: None)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def shared_renderer():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return cache.RenderedAccuratePng(PNG, engine="ppe+lcms")

    owner_a = f"owner-a:{tmp_path}"
    owner_b = f"owner-b:{tmp_path}"
    waiter_a = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "8" * 64,
            shared_renderer,
            interest=cache.AccurateRenderInterest(owner_a, 1),
        )
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    waiter_b = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "8" * 64,
            shared_renderer,
            interest=cache.AccurateRenderInterest(owner_b, 1),
        )
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if cache._inflight["8" * 64].waiters == 2:
            break

    replacement_waiter = asyncio.create_task(
        cache.get_or_render_accurate_png(
            "9" * 64,
            lambda: asyncio.sleep(
                0, result=cache.RenderedAccuratePng(PNG, engine="ppe+lcms")
            ),
            interest=cache.AccurateRenderInterest(owner_a, 2),
        )
    )
    await asyncio.sleep(0)
    with pytest.raises(cache.AccurateRequestSuperseded):
        await waiter_a
    assert not replacement_waiter.done()
    release.set()
    shared = await asyncio.wait_for(waiter_b, timeout=1)
    replacement = await asyncio.wait_for(replacement_waiter, timeout=1)

    assert replacement.rendered.data == shared.rendered.data == PNG
    assert calls == 1
    assert cache._cache_path("8" * 64).read_bytes() == PNG

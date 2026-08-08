"""Regression cho cache PNG chuẩn màu của Viewer."""

import asyncio

import pytest

from app.core import viewer_accurate_cache as cache


PNG = cache.PNG_SIGNATURE + b"prynx-test"


def _prepare_profiles(tmp_path, monkeypatch):
    cmyk = tmp_path / "FOGRA39.icc"
    rgb = tmp_path / "sRGB.icm"
    cmyk.write_bytes(b"cmyk-profile")
    rgb.write_bytes(b"rgb-profile")
    monkeypatch.setattr(cache, "resolve_cmyk_profile_path", lambda _profile: str(cmyk))
    monkeypatch.setattr(cache, "resolve_srgb_profile_path", lambda: str(rgb))


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


def test_cache_roundtrip_rejects_corrupt_png(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.settings, "RESULTS_DIR", str(tmp_path))
    key = "a" * 64

    cache.write_cached_png(key, PNG)
    assert cache.read_cached_png(key) == PNG

    path = tmp_path / "viewer_accurate_cache" / f"{key}.png"
    path.write_bytes(b"not-a-png")
    assert cache.read_cached_png(key) is None
    assert not path.exists()


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

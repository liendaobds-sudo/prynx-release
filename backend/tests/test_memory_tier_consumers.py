"""PERF (audit 2026-09-28 §PERF28.03): tier lắp đặt khác ngân sách RAM thật."""

import math
import re

import pikepdf
from PIL import Image
import pytest

from app.core import system_memory as memory
from app.core.pdfium_lock import PDFIUM_PY_LOCK
from app.workers import sticker_engine as sticker
from app.workers import sticker_source_pipeline as source


@pytest.mark.parametrize("installed,usable,inventory,nesting", [
    (8192, 7952, 12, 3),
    (16384, 16144, 32, 6),
    (32768, 32528, 63, 7),
    (65536, 65296, 127, 15),
    (6144, 5904, 4, 1),
    (None, 16144, 12, 3),
    (4096, 16144, 12, 3),
    (16384, None, 8, 2),
    (16384, 0, 8, 2),
])
def test_metadata_cache_runtime_tier_keeps_usable_capacity(
    ram_snapshot, installed, usable, inventory, nesting,
):
    from app.core import ink_manager, nesting_preview_session

    ram_snapshot(installed, usable, 512)
    assert ink_manager._inventory_cache_capacity() == inventory
    assert nesting_preview_session._default_capacity() == nesting


@pytest.mark.parametrize("tier,inventory,nesting", [
    (None, 12, 3), (4096, 12, 3), (16384, 32, 6),
])
def test_metadata_cache_pure_tier_never_reads_host(monkeypatch, tier, inventory, nesting):
    from app.core import ink_manager, nesting_preview_session

    def must_not_read():
        pytest.fail("Policy cache thuần không được đọc phần cứng host.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    assert ink_manager.inventory_cache_capacity_for_ram(16144, tier_ram_mb=tier) == inventory
    assert nesting_preview_session.preview_session_capacity_for_ram(16144, tier_ram_mb=tier) == nesting
    assert ink_manager.inventory_cache_capacity_for_ram(32528) == 63
    assert nesting_preview_session.preview_session_capacity_for_ram(32528) == 7


@pytest.mark.parametrize("installed,usable,available,budget,limit", [
    (8192, 7952, 6000, 180, 8),
    (16384, 16144, 12000, 600, None),
    (16384, 16144, None, 807.2, None),
    (32768, 32528, 18000, 900, None),
    (65536, 65296, 30000, 1500, None),
    (6144, 5904, 4000, 80, 2),
    (None, 16144, 12000, 256, 8),
    (4096, 16144, 12000, 256, 8),
    (16384, None, 12000, 64, None),
    (16384, 0, 12000, 64, 2),
    (16384, 16144, 512, 256, None),
])
def test_cut_cache_runtime_tier_keeps_real_budget(
    ram_snapshot, monkeypatch, installed, usable, available, budget, limit,
):
    from app.workers import sticker_cutline_preview as preview
    from app.workers.cut_export import inspect_proof as proof

    ram_snapshot(installed, usable, available)
    monkeypatch.setattr(proof, "read_memory_status_mb", lambda: (usable, available))
    monkeypatch.setattr(preview, "read_memory_status_mb", lambda: (usable, available))
    assert proof._current_proof_store_budget_bytes() == int(budget * 1024 * 1024)
    assert preview._preview_cache_limit() == limit


@pytest.mark.parametrize("tier,expected", [
    (None, 256), (4096, 256), (float("inf"), 256),
    (float("nan"), 256), ("bad", 256), (16384, 600),
])
def test_cut_proof_cache_pure_tier_preserves_sanitization(monkeypatch, tier, expected):
    from app.workers.cut_export import inspect_proof as proof

    def must_not_read():
        pytest.fail("Policy proof thuần không được đọc phần cứng host.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    assert proof._proof_store_budget_bytes(16144, 12000, tier_ram_mb=tier) == expected * 1024 * 1024
    assert proof._proof_store_budget_bytes(16144, 12000) == 256 * 1024 * 1024
    assert proof._proof_store_budget_bytes(float("nan"), 12000, tier_ram_mb=tier) == 64 * 1024 * 1024


@pytest.fixture
def ram_snapshot(monkeypatch):
    """Giả lập snapshot ở biên runtime; policy và reader tier vẫn chạy thật."""
    monkeypatch.delenv("STICKER_MAX_WORKERS", raising=False)
    monkeypatch.delenv("STICKER_STICKY_SEQ_SEC", raising=False)
    monkeypatch.delenv("STICKER_FORCE_SEQUENTIAL", raising=False)
    monkeypatch.setattr(sticker.os, "cpu_count", lambda: 16)
    monkeypatch.setattr(sticker, "_hw_profile_cache", None)
    monkeypatch.setattr(sticker, "_hw_profile_logged", False)
    monkeypatch.setattr(sticker, "_sticky_sequential_until", 0.0)

    def set_snapshot(installed_mb, usable_mb, available_mb):
        monkeypatch.setattr(memory, "read_installed_memory_mb", lambda: installed_mb)
        monkeypatch.setattr(memory, "read_memory_status_mb", lambda: (usable_mb, available_mb))
        monkeypatch.setattr(source, "read_memory_status_mb", lambda: (usable_mb, available_mb))

    return set_snapshot


@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "workers", "tier", "sticky"),
    [
        (8192, 7952, 4, "mid", 600),
        (16384, 16144, 15, "full", 0),
        (16384, 14336, 15, "full", 0),
        (6144, 5904, 1, "low", 900),
        (12288, 12048, 4, "mid", 600),
        (32768, 32528, 15, "full", 0),
        (None, 16144, 4, "mid", 600),
        (4096, 16144, 4, "mid", 600),
        (16384, None, 4, "mid", 600),
    ],
)
def test_sticker_auto_profile_uses_installed_tier(
    ram_snapshot, installed_mb, usable_mb, workers, tier, sticky
):
    ram_snapshot(installed_mb, usable_mb, 4000)
    profile = sticker.get_sticker_hw_profile(refresh=True)

    assert (profile["max_workers"], profile["tier"], profile["sticky_seq_sec"]) == (
        workers, tier, sticky
    )
    assert sticker._read_memory_status() == (usable_mb, 4000)
    assert sticker._total_ram_mb() == usable_mb
    assert sticker._available_ram_mb() == 4000


def test_sticker_explicit_policy_does_not_read_host(ram_snapshot, monkeypatch):
    ram_snapshot(32768, 32528, 24000)

    def must_not_read():
        pytest.fail("Policy nhận RAM tường minh không được đọc RAM máy chạy.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    profile = sticker._auto_sticker_hw_profile(total_ram_mb=6144, cpu_count=16)
    assert (profile["max_workers"], profile["tier"]) == (1, "low")


def test_sticker_full_tier_keeps_large_page_parallel_threshold(ram_snapshot):
    ram_snapshot(16384, 16144, 12000)
    sticker.get_sticker_hw_profile(refresh=True)
    assert sticker._n_pages_should_parallelize(2, page_area_pt2=sticker._STICKER_LARGE_PAGE_PT2)
    assert not sticker._n_pages_should_parallelize(2)


def test_sticker_installed_tier_keeps_env_override(ram_snapshot, monkeypatch):
    ram_snapshot(8192, 7952, 512)
    monkeypatch.setenv("STICKER_MAX_WORKERS", "7")
    monkeypatch.setenv("STICKER_STICKY_SEQ_SEC", "20")
    profile = sticker.get_sticker_hw_profile(refresh=True)
    assert (profile["max_workers"], profile["sticky_seq_sec"]) == (7, 20)
    assert sticker._cap_sticker_workers(7, 100, "fixture.pdf") == 7


@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "available_mb", "expected"),
    [(16384, 16144, 512, 15), (8192, 7952, 512, 1), (12288, 12048, 512, 1)],
)
def test_sticker_secondary_gate_uses_tier_but_keeps_weak_pressure(
    ram_snapshot, installed_mb, usable_mb, available_mb, expected
):
    ram_snapshot(installed_mb, usable_mb, available_mb)
    assert sticker._cap_sticker_workers(15, 100, "fixture.pdf") == expected


def test_sticker_full_tier_still_requires_actual_pool_memory(ram_snapshot):
    from app.core.heavy_job_scheduler import process_pool_admission

    ram_snapshot(16384, 16144, 512)
    planned = sticker._cap_sticker_workers(15, 100, "fixture.pdf")
    assert planned == 15
    assert memory.process_pool_budget_mb() == pytest.approx(307.2)
    with process_pool_admission("test-tier-sticker", planned, 256) as admitted:
        assert admitted == 1


@pytest.fixture
def fake_pdfium(monkeypatch):
    """Native giả kiểm khóa/lifecycle; bitmap nhỏ để ca policy không tốn RAM."""
    import pypdfium2

    def install(*, fail_at=None, check_lock=True, raster_limit=None):
        state = {"operations": [], "scales": []}
        borrowed = Image.new("RGB", (2, 2), (100, 120, 140))

        def native(operation):
            state["operations"].append(operation)
            if check_lock:
                assert PDFIUM_PY_LOCK._is_owned(), operation
            if operation == fail_at:
                raise RuntimeError(operation)

        class BorrowedImage:
            def copy(self):
                native("copy")
                return borrowed.copy()

        class Bitmap:
            def to_pil(self):
                native("to_pil")
                return BorrowedImage()

            def close(self):
                native("bitmap.close")
                # Bản sao trả ra phải độc lập với buffer đã đóng của native.
                borrowed.paste((0, 0, 0), (0, 0, 2, 2))

        class Page:
            def get_size(self):
                native("get_size")
                return 1600.0, 800.0

            def render(self, *, scale, rev_byteorder, fill_color):
                native("render")
                assert rev_byteorder is True
                assert fill_color == (255, 255, 255, 0)
                state["scales"].append(scale)
                return Bitmap()

            def close(self):
                native("page.close")

        class Document:
            def __len__(self):
                native("len")
                return 1

            def __getitem__(self, _index):
                native("get_page")
                return Page()

            def close(self):
                native("document.close")

        def open_document(_path):
            native("open")
            return Document()

        monkeypatch.setattr(pypdfium2, "PdfDocument", open_document)
        monkeypatch.setattr(source, "_full_page_raster_scale_limit", lambda *_: raster_limit)
        return state

    return install


_PHYSICAL_MM = (1600 * 25.4 / 72, 800 * 25.4 / 72)


@pytest.mark.parametrize(
    ("installed_mb", "usable_mb", "available_mb", "expected_scale"),
    [
        (8192, 7952, 4000, 6000 / 1600),
        (16384, 16144, 12000, 300 / 72),
        (16384, 14336, 12000, 300 / 72),
        (6144, 5904, 4000, 3000 / 1600),
        (32768, 32528, 12000, 300 / 72),
        (None, 16144, 12000, 6000 / 1600),
        (16384, 16144, 50, math.sqrt(50 * 0.55 * 1024**2 / 20 / (1600 * 800))),
    ],
)
def test_sticker_source_scale_tier_and_actual_pressure(
    ram_snapshot, fake_pdfium, installed_mb, usable_mb, available_mb, expected_scale
):
    ram_snapshot(installed_mb, usable_mb, available_mb)
    # Tách ca tier khỏi ca lifecycle bên dưới để thấy đúng nguyên nhân đỏ.
    state = fake_pdfium(check_lock=False)
    source._render_pdf_page("fixture.pdf", 0, _PHYSICAL_MM)
    assert state["scales"] == pytest.approx([expected_scale])


def test_sticker_source_native_raster_limit_is_preserved(ram_snapshot, fake_pdfium):
    ram_snapshot(16384, 16144, 12000)
    state = fake_pdfium(check_lock=False, raster_limit=0.5)
    source._render_pdf_page("fixture.pdf", 0, _PHYSICAL_MM)
    assert state["scales"] == [0.5]


def test_sticker_source_lifecycle_locked_copy_detached_convert_unlocked(
    ram_snapshot, fake_pdfium, monkeypatch
):
    ram_snapshot(16384, 16144, 12000)
    state = fake_pdfium()
    original_convert = Image.Image.convert

    def convert(image, *args, **kwargs):
        assert not PDFIUM_PY_LOCK._is_owned(), "PIL convert phải nằm ngoài khóa PDFium."
        return original_convert(image, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "convert", convert)
    image, _dpi = source._render_pdf_page("fixture.pdf", 0, _PHYSICAL_MM)
    assert image.mode == "RGBA"
    assert image.getpixel((0, 0)) == (100, 120, 140, 255)
    assert state["operations"] == [
        "open", "len", "get_page", "get_size", "render", "to_pil", "copy",
        "bitmap.close", "page.close", "document.close",
    ]
    assert not PDFIUM_PY_LOCK._is_owned()


@pytest.mark.parametrize(
    "fail_at",
    ["open", "len", "get_page", "get_size", "render", "to_pil", "copy",
     "bitmap.close", "page.close", "document.close"],
)
def test_sticker_source_errors_close_native_under_lock(ram_snapshot, fake_pdfium, fail_at):
    ram_snapshot(16384, 16144, 12000)
    state = fake_pdfium(fail_at=fail_at)
    with pytest.raises(RuntimeError, match=re.escape(fail_at)):
        source._render_pdf_page("fixture.pdf", 0, _PHYSICAL_MM)
    operations = state["operations"]
    if fail_at != "open":
        assert "document.close" in operations
    if fail_at not in {"open", "len", "get_page"}:
        assert "page.close" in operations
    if fail_at in {"to_pil", "copy", "bitmap.close", "page.close", "document.close"}:
        assert "bitmap.close" in operations
    assert not PDFIUM_PY_LOCK._is_owned()


def test_sticker_source_invalid_index_closes_document_under_lock(ram_snapshot, fake_pdfium):
    ram_snapshot(16384, 16144, 12000)
    state = fake_pdfium()
    with pytest.raises(source.StickerSourcePipelineError):
        source._render_pdf_page("fixture.pdf", 2, _PHYSICAL_MM)
    assert state["operations"] == ["open", "len", "document.close"]
    assert not PDFIUM_PY_LOCK._is_owned()


def test_sticker_real_pdf_pixels_dpi_unchanged_across_full_tiers(ram_snapshot, tmp_path):
    path = tmp_path / "tier-source.pdf"
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(72, 48))
        page.Contents = pdf.make_stream(b"1 0 0 rg 0 0 30 48 re f\n0 0 1 rg 30 0 42 48 re f\n")
        pdf.save(path)
    physical_mm = (25.4, 48 * 25.4 / 72)
    ram_snapshot(16384, 16144, 12000)
    boundary_image, boundary_dpi = source._render_pdf_page(str(path), 0, physical_mm)
    ram_snapshot(32768, 32528, 12000)
    strong_image, strong_dpi = source._render_pdf_page(str(path), 0, physical_mm)

    assert boundary_image.size == strong_image.size == (300, 200)
    assert boundary_dpi == pytest.approx((300, 300))
    assert boundary_dpi == strong_dpi
    assert boundary_image.tobytes() == strong_image.tobytes()


@pytest.mark.parametrize(
    "installed,usable,expected", [(8192, 7952, 4), (16384, 16144, 9),
    (16384, 14336, 9), (6144, 5904, 2), (12288, 12048, 4),
    (32768, 32528, 9), (None, 16144, 4), (4096, 16144, 4), (16384, None, 9)],
)
def test_nup_preparation_runtime_tier(ram_snapshot, monkeypatch, installed, usable, expected):
    from app.api.routes import imposition

    ram_snapshot(installed, usable, 4000)
    monkeypatch.delenv("PRYNX_NUP_PREP_WORKERS", raising=False)
    monkeypatch.setattr(imposition, "_NUP_MAX_CONCURRENT_JOBS", 1)
    monkeypatch.setattr(imposition, "_NUP_MAX_QUEUED_JOBS", 8)
    assert imposition._nup_preparation_worker_count() == expected


@pytest.mark.parametrize(
    "installed,usable,expected", [(8192, 7952, 1), (16384, 16144, 3000),
    (16384, 14336, 3000), (6144, 5904, 1), (12288, 12048, 1),
    (32768, 32528, 3000), (None, 16144, 1), (4096, 16144, 1), (16384, None, 3000)],
)
def test_step_repeat_search_runtime_tier(ram_snapshot, monkeypatch, installed, usable, expected):
    from app.workers import nup_true_shape_nesting as nesting

    ram_snapshot(installed, usable, 4000)
    monkeypatch.delenv("PRYNX_NEST_AUTOFILL_SEARCH_MS", raising=False)
    assert nesting._time_budget_ms("step_repeat_single_sheet") == expected
    assert nesting._time_budget_ms("autofill") == nesting.DEFAULT_TIME_BUDGET_MS


def test_nup_and_nesting_explicit_overrides_still_win(ram_snapshot, monkeypatch):
    from app.api.routes import imposition
    from app.workers import nup_true_shape_nesting as nesting

    ram_snapshot(8192, 7952, 512)
    monkeypatch.setenv("PRYNX_NUP_PREP_WORKERS", "7")
    monkeypatch.setenv("PRYNX_NEST_AUTOFILL_SEARCH_MS", "51")
    assert imposition._nup_preparation_worker_count() == 7
    assert nesting._step_repeat_time_budget_ms() == 51

    def must_not_read():
        pytest.fail("Policy thuần N-up không được đọc hardware.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    assert imposition.nup_preparation_workers_for_ram(6144, cpu_count=16, admitted_jobs=20) == 2


@pytest.mark.parametrize(
    "installed,usable,expected", [(8192, 7952, 1536), (16384, 16144, 2048),
    (6144, 5904, 1024), (12288, 12048, 1536), (32768, 32528, 2048),
    (None, 16144, 1536), (4096, 16144, 1536), (16384, None, 2048)],
)
def test_compare_tile_runtime_tier(ram_snapshot, monkeypatch, installed, usable, expected):
    from app.core import comparison_engine as compare

    ram_snapshot(installed, usable, 512)
    monkeypatch.delenv("PRYNX_COMPARE_TILE_SIZE", raising=False)
    assert compare._compare_tile_size() == expected
    monkeypatch.setenv("PRYNX_COMPARE_TILE_SIZE", "700")
    assert compare._compare_tile_size() == 700


@pytest.fixture
def manifest_policy(monkeypatch, ram_snapshot, tmp_path):
    from dataclasses import fields
    from types import SimpleNamespace
    from app.workers import pdf_manifest_engine as manifest

    monkeypatch.delenv("PRYNX_MANIFEST_MAX_PAGES", raising=False)
    monkeypatch.setattr(manifest, "max_active_heavy_jobs", lambda: 1)
    monkeypatch.setattr(manifest.shutil, "disk_usage", lambda _: SimpleNamespace(free=10**12))

    def check(installed, usable, available, pages, *, peak_mb=0):
        ram_snapshot(installed, usable, available)
        monkeypatch.setattr(manifest, "read_memory_status_mb", lambda: (usable, available))
        values = dict.fromkeys((field.name for field in fields(manifest.ManifestResourceEstimate)), 0)
        values.update(expanded_pages=pages, estimated_peak_ram_bytes=peak_mb * 1024**2)
        manifest._enforce_manifest_admission(manifest.ManifestResourceEstimate(**values), str(tmp_path / "out.pdf"))

    return check


@pytest.mark.parametrize(
    "installed,usable,pages,allowed", [(8192, 7952, 4001, True),
    (16384, 16144, 10001, True), (32768, 32528, 10001, True),
    (6144, 5904, 4001, False), (12288, 12048, 10001, False),
    (None, 16144, 10001, False), (4096, 16144, 10001, False)],
)
def test_manifest_page_cap_runtime_tier(manifest_policy, installed, usable, pages, allowed):
    if allowed:
        manifest_policy(installed, usable, 4000, pages)
    else:
        with pytest.raises(ValueError, match="trang"):
            manifest_policy(installed, usable, 4000, pages)


def test_manifest_tier_does_not_change_real_memory_budget(manifest_policy, monkeypatch):
    manifest_policy(16384, 16144, 12000, 1, peak_mb=7000)
    with pytest.raises(ValueError, match="RAM"):
        manifest_policy(16384, 16144, 12000, 1, peak_mb=7200)
    with pytest.raises(ValueError, match="RAM"):
        manifest_policy(16384, 16144, 512, 1, peak_mb=1)
    monkeypatch.setenv("PRYNX_MANIFEST_MAX_PAGES", "4")
    with pytest.raises(ValueError, match="PRYNX_MANIFEST_MAX_PAGES"):
        manifest_policy(16384, 16144, 12000, 5)


@pytest.mark.parametrize("installed,usable,budget_mb", [
    (8192, 7952, 64), (16384, 16144, None), (6144, 5904, 16),
    (12288, 12048, 64), (32768, 32528, None), (None, 16144, 64),
])
@pytest.mark.parametrize("seeded", [False, True])
def test_local_simplify_memo_runtime_tier(ram_snapshot, monkeypatch, installed, usable, budget_mb, seeded):
    from contextlib import contextmanager
    from app.workers import cutline_simplify_memo as memo

    ram_snapshot(installed, usable, 4000)
    budgets = []
    original_scope = memo.simplify_memo_scope

    @contextmanager
    def capture_scope(*args, **kwargs):
        budgets.append(kwargs["budget_bytes"])
        with original_scope(*args, **kwargs) as scope:
            yield scope

    monkeypatch.setattr(memo, "simplify_memo_scope", capture_scope)
    @memo.with_simplify_memo
    def job():
        return memo.current_simplify_memo()

    assert job(**({"_simplify_memo": {}} if seeded else {})) == {}
    assert budgets == [None if budget_mb is None else budget_mb * 1024**2]
    # Hàm thuần vẫn dùng đúng input minh thị, không bị installed của host lấn át.
    assert memo._memo_budget_bytes(6144) == 16 * 1024**2


@pytest.mark.parametrize("installed,usable", [(8192, 7952), (16384, 16144)])
def test_sticker_pool_passes_tier_to_shared_memo(ram_snapshot, monkeypatch, tmp_path, installed, usable):
    from contextlib import contextmanager

    ram_snapshot(installed, usable, 4000)
    path = tmp_path / "shared-tier.pdf"
    with pikepdf.Pdf.new() as pdf:
        for _ in range(6):
            pdf.add_blank_page(page_size=(72, 72))
        pdf.save(path)
    observed = []

    class CapturedPolicy(Exception):
        pass

    @contextmanager
    def capture_shared(*, enabled, records, total_ram_mb):
        observed.append((enabled, total_ram_mb))
        raise CapturedPolicy()
        yield  # pragma: no cover — dừng trước khi dựng pool thật.

    monkeypatch.setattr(sticker, "shared_simplify_job", capture_shared)
    monkeypatch.setattr(sticker, "_cap_sticker_workers", lambda *_a, **_k: 4)
    with pytest.raises(CapturedPolicy):
        sticker.StickerEngine()._process_parallel(
            input_path=str(path), output_path=str(tmp_path / "out.pdf"),
            cut_mode="original", offset_mm=0., corner_style="preserve", cut_color=(0, 1, 0, 0),
            bleed_mm=0., fill_holes=True, remove_white_bg=False, bleed_color_type="solid",
            solid_bleed_color=(255, 255, 255), draw_cut_contour=True, rectangle_mode=False,
            edge_bite_mm=0., cut_first_page_only=False, cutline_simplify_auto=True,
        )
    assert observed == [(True, installed)]
    assert sticker._total_ram_mb() == usable


@pytest.mark.parametrize("installed,usable,lanes,tile", [
    (8192, 7952, 2, 384), (16384, 16144, 2, 512), (6144, 5904, 1, 256),
    (12288, 12048, 2, 384), (32768, 32528, 2, 512), (None, 7952, 1, 256),
    (4096, 16144, 2, 384), (16384, None, 2, 512),
])
def test_resize_and_upscale_runtime_tiers(ram_snapshot, monkeypatch, installed, usable, lanes, tile):
    from app.workers import resize_background_engine as resize
    from app.workers import realesrgan_engine as upscale

    ram_snapshot(installed, usable, 4000)
    monkeypatch.setattr(resize, "read_memory_status_mb", lambda: (usable, 4000))
    monkeypatch.delenv("PRYNX_RESIZE_ZLIB_LANES", raising=False)
    monkeypatch.delenv("PRYNX_UPSCALE_TILE", raising=False)
    assert resize._background_zlib_lane_count() == lanes
    assert upscale._default_tile_size() == tile
    monkeypatch.setenv("PRYNX_RESIZE_ZLIB_LANES", "1")
    monkeypatch.setenv("PRYNX_UPSCALE_TILE", "800")
    assert resize._background_zlib_lane_count() == 1
    assert upscale._default_tile_size() == 800
    assert resize._plan_background_zlib_lanes(6144, 16) == 1
    assert resize._plan_background_zlib_lanes(32768, 1) == 1


@pytest.mark.parametrize("installed,usable,short_side,palette_pixels", [
    (8192, 7952, 900, 4_000_000), (16384, 16144, 1200, 16_000_000),
    (6144, 5904, 600, 1_000_000), (12288, 12048, 900, 4_000_000),
    (32768, 32528, 1200, 16_000_000), (None, 16144, 900, 4_000_000),
    (16384, None, 1200, 1_000_000),
])
def test_logo_quality_runtime_tier(ram_snapshot, monkeypatch, installed, usable, short_side, palette_pixels):
    from app.workers import logo_rebuild as logo

    ram_snapshot(installed, usable, 4000)
    monkeypatch.setattr(logo, "read_memory_status_mb", lambda: (usable, 4000))
    assert logo._upscale_target_dimensions(300, 150) == (2 * short_side, short_side)
    assert logo._accent_grid_pixel_budget() == palette_pixels


@pytest.mark.parametrize("installed,usable,full", [
    (16384, 16144, True), (32768, 32528, True),
    (12288, 12048, False), (6144, 5904, False),
])
def test_logo_background_pressure_keeps_full_tier_contract(ram_snapshot, monkeypatch, installed, usable, full):
    from app.api.routes import pdf_tools
    from app.workers import logo_rebuild as logo
    from fastapi import HTTPException

    ram_snapshot(installed, usable, 1500)
    monkeypatch.setattr(logo, "read_memory_status_mb", lambda: (usable, 1500))
    monkeypatch.setattr(logo, "_RESERVED_LOGO_MEMORY_MB", 0.0)
    if full:
        with pytest.raises(logo.LogoInputError, match="RAM"):
            logo._plan_work_size(5000, 5000)
        with pytest.raises(logo.LogoInputError, match="RAM"):
            with logo._reserve_logo_work_size(5000, 5000):
                pytest.fail("Không được cấp ảnh vượt ngân sách thật.")
        with pytest.raises(HTTPException) as error:
            pdf_tools._plan_background_work_size(5000, 5000)
        assert error.value.status_code == 422
    else:
        assert logo._plan_work_size(5000, 5000)[0][0] < 5000
        with logo._reserve_logo_work_size(5000, 5000) as (size, warnings):
            assert size[0] < 5000 and warnings
        assert pdf_tools._plan_background_work_size(5000, 5000)[0][0] < 5000
    assert logo._RESERVED_LOGO_MEMORY_MB == 0.0


def test_logo_budget_still_uses_real_memory(ram_snapshot, monkeypatch):
    from app.workers import logo_rebuild as logo

    ram_snapshot(16384, 16144, 12000)
    monkeypatch.setattr(logo, "read_memory_status_mb", lambda: (16144, 12000))
    assert logo.logo_memory_budget_mb() == pytest.approx((12000 - 1024) * 0.65)
    assert logo._plan_work_size(1000, 1000) == ((1000, 1000), [])
    size, warnings = logo._plan_work_size_for_budget(5000, 5000, 6144, 512)
    assert size[0] < 5000 and warnings


# PERF (audit 2026-09-28 §PERF28.03 B2h): installed chỉ chọn hạng PPE;
# các số ngân sách bên dưới vẫn tính từ usable/available của cùng snapshot.
_PPE_RAM_CASES = [
    (8192, 7952, 4000, 1024, 256, (400, 200, 180.0)),
    (16384, 16144, 12000, 9000, 1500, (1500, 375, 300.0)),
    (16384, 16144, None, 8072, 2018, (2018, 504, 300.0)),
    (16384, 16144, 512, 512, 256, (512, 256, 300.0)),
    (16384, 16144, 0, 8072, 2018, (2018, 504, 300.0)),
    (16384, 16144, -1, 8072, 2018, (2018, 504, 300.0)),
    (6144, 5904, 4000, 640, 96, (256, 96, 90.0)),
    (12288, 12048, 8000, 1024, 256, (768, 256, 180.0)),
    (32768, 32528, 24000, 18000, 3000, (3000, 750, 300.0)),
    (65536, 65296, 48000, 36000, 6000, (6000, 1500, 300.0)),
    (None, 16144, 12000, 1024, 256, (768, 256, 180.0)),
    (4096, 16144, 12000, 1024, 256, (768, 256, 180.0)),
    (16384, None, 12000, 512, 128, (256, 128, 120.0)),
    (16384, 0, 12000, 512, 128, (256, 128, 120.0)),
]


@pytest.mark.parametrize("installed,usable,available,render,cache,viewer", _PPE_RAM_CASES)
def test_ppe_facade_runtime_tier_keeps_real_budget(
    ram_snapshot, monkeypatch, installed, usable, available, render, cache, viewer
):
    from app.config import settings
    from app.core import heavy_job_scheduler as scheduler
    from app.core.print_engine import facade

    ram_snapshot(installed, usable, available)
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", None)
    monkeypatch.setattr(scheduler, "max_active_heavy_jobs", lambda: 1)
    assert facade._memory_budget_mb() == render
    assert facade._session_cache_budget_mb() == cache


@pytest.mark.asyncio
@pytest.mark.parametrize("installed,usable,available,render,cache,viewer", _PPE_RAM_CASES)
async def test_ppe_viewer_default_runtime_tier_keeps_real_budget(
    ram_snapshot, monkeypatch, installed, usable, available, render, cache, viewer
):
    from app.core import ppe_viewer_session as sessions

    ram_snapshot(installed, usable, available)
    monkeypatch.setattr(sessions, "read_memory_status_mb", lambda: (usable, available))
    manager = sessions.PpeViewerSessionManager()
    # Constructor cũ giữ reader tại lúc import; cố định cùng snapshot trước/sau
    # để baseline đo sai tier, không vô tình đọc RAM thật của máy chạy test.
    monkeypatch.setattr(manager, "_memory_status", lambda: (usable, available))
    try:
        assert await manager._policy() == sessions.ViewerSessionBudgetPolicy(*viewer)
    finally:
        await manager.close_all()


@pytest.mark.parametrize("tier,render,cache,viewer", [
    (None, 1024, 256, (768, 256, 180.0)),
    (4096, 1024, 256, (768, 256, 180.0)),
    (16384, 9000, 1500, (1500, 375, 300.0)),
])
def test_ppe_pure_policies_never_read_host(monkeypatch, tier, render, cache, viewer):
    from app.core import ppe_viewer_session as sessions
    from app.core.print_engine import facade

    def must_not_read():
        pytest.fail("Policy thuần PPE không được đọc hardware.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    assert facade._auto_memory_budget_mb(16144, 12000, tier_ram_mb=tier) == render
    assert facade._auto_session_cache_budget_mb(16144, 12000, tier_ram_mb=tier) == cache
    assert sessions.viewer_session_budget_policy(
        16144, 12000, tier_ram_mb=tier
    ) == sessions.ViewerSessionBudgetPolicy(*viewer)
    # Caller cũ không truyền tier vẫn chỉ dùng input minh thị.
    assert facade._auto_memory_budget_mb(6144, 4000) == 640
    assert facade._auto_session_cache_budget_mb(6144, 4000) == 96
    assert sessions.viewer_session_budget_policy(
        6144, 4000
    ) == sessions.ViewerSessionBudgetPolicy(256, 96, 90.0)


def test_ppe_runtime_preserves_slot_sharing_and_override(ram_snapshot, monkeypatch):
    from app.config import settings
    from app.core import heavy_job_scheduler as scheduler
    from app.core.print_engine import facade

    ram_snapshot(16384, 16144, 12000)
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", None)
    monkeypatch.setattr(scheduler, "max_active_heavy_jobs", lambda: 4)
    assert facade._memory_budget_mb() == 2250

    def must_not_read():
        pytest.fail("Override PPE phải thắng mà không đọc hardware.")

    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", 1536)
    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    monkeypatch.setattr(memory, "read_memory_status_mb", must_not_read)
    assert facade._memory_budget_mb() == 1536


@pytest.mark.asyncio
@pytest.mark.parametrize("usable,available,expected", [
    (4096, 1024, (128, 51, 90.0)),
    (16144, 12000, (768, 256, 180.0)),
])
async def test_ppe_viewer_custom_memory_reader_is_host_independent(
    monkeypatch, usable, available, expected
):
    from app.core import ppe_viewer_session as sessions

    def must_not_read():
        pytest.fail("Callback RAM tùy biến không được trộn installed của host.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    manager = sessions.PpeViewerSessionManager(memory_status=lambda: (usable, available))
    try:
        assert await manager._policy() == sessions.ViewerSessionBudgetPolicy(*expected)
    finally:
        await manager.close_all()


@pytest.mark.asyncio
async def test_ppe_viewer_explicit_tier_reader_runs_off_loop_and_keeps_cache():
    import threading
    from app.core import ppe_viewer_session as sessions

    loop_thread = threading.get_ident()
    reads = []
    now = [0.0]

    def snapshot():
        reads.append(("memory", threading.get_ident()))
        return 16144, None

    def tier_reader(usable):
        assert usable == 16144
        reads.append(("tier", threading.get_ident()))
        return 16384

    manager = sessions.PpeViewerSessionManager(
        memory_status=snapshot, tier_reader=tier_reader, clock=lambda: now[0],
    )
    expected = sessions.ViewerSessionBudgetPolicy(2018, 504, 300.0)
    try:
        assert await manager._policy() == expected
        assert await manager._policy() == expected
        assert [kind for kind, _thread in reads] == ["memory", "tier"]
        assert all(thread != loop_thread for _kind, thread in reads)
        now[0] = 3.0
        assert await manager._policy() == expected
        assert [kind for kind, _thread in reads] == ["memory", "tier", "memory", "tier"]
        assert all(thread != loop_thread for _kind, thread in reads)
    finally:
        await manager.close_all()


@pytest.mark.asyncio
async def test_ppe_viewer_default_readers_are_resolved_without_snapshot_override(monkeypatch):
    import threading
    from app.core import ppe_viewer_session as sessions

    loop_thread = threading.get_ident()
    reads = []

    def snapshot():
        reads.append(("memory", threading.get_ident()))
        return 16144, None

    def installed():
        reads.append(("installed", threading.get_ident()))
        return 16384

    monkeypatch.setattr(sessions, "read_memory_status_mb", snapshot)
    monkeypatch.setattr(memory, "read_installed_memory_mb", installed)
    manager = sessions.PpeViewerSessionManager()
    try:
        assert await manager._policy() == sessions.ViewerSessionBudgetPolicy(2018, 504, 300.0)
        assert [kind for kind, _thread in reads] == ["memory", "installed"]
        assert all(thread != loop_thread for _kind, thread in reads)
    finally:
        await manager.close_all()


@pytest.mark.asyncio
@pytest.mark.parametrize("installed,usable,limit", [
    (8192, 7952, 2), (16384, 16144, None), (6144, 5904, 1),
    (12288, 12048, 2), (32768, 32528, None), (65536, 65296, None),
    (None, 16144, 2), (4096, 16144, 2), (16384, None, None),
    (16384, 0, None), (16384, -1, None),
])
async def test_accurate_preview_runtime_gate_uses_installed_tier(
    ram_snapshot, monkeypatch, installed, usable, limit
):
    from app.core import viewer_accurate_cache as cache

    ram_snapshot(installed, usable, 512)
    monkeypatch.setattr(cache, "read_memory_status_mb", lambda: (usable, 512))
    monkeypatch.setattr(cache, "_render_gate_loop", None)
    monkeypatch.setattr(cache, "_render_gate_limit", None)
    monkeypatch.setattr(cache, "_render_gate", None)
    gate = cache._render_gate_for_current_loop()
    if limit is None:
        assert gate is None
    else:
        assert gate is not None and gate._value == limit
        assert cache._render_gate_for_current_loop() is gate


@pytest.mark.skipif(memory.os.name != "nt", reason="Kiểm reader Windows thật qua API giả lập.")
@pytest.mark.parametrize("installed,usable,cap", [
    (8192, 7952, 100), (16384, 16144, None), (6144, 5904, 72),
    (12288, 12048, 100), (32768, 32528, None), (65536, 65296, None),
    (None, 16144, 100), (4096, 16144, 100), (16384, None, None),
    (16384, 0, 100),
])
def test_color_preview_default_runtime_uses_installed_tier(
    ram_snapshot, monkeypatch, installed, usable, cap
):
    import ctypes
    from app.core import color_conversion_preview as preview

    ram_snapshot(installed, usable, 512)

    def snapshot(pointer):
        if usable is None:
            raise OSError("Giả lập không đọc được RAM OS.")
        pointer._obj.ullTotalPhys = usable * 1024 * 1024
        pointer._obj.ullAvailPhys = 512 * 1024 * 1024
        return 1

    # PERF (audit 2026-09-28 §PERF28.03 B2i): reader default cũ bind lúc
    # import; stub API để cùng snapshot trước/sau, không lẫn phần cứng host.
    monkeypatch.setattr(ctypes.windll.kernel32, "GlobalMemoryStatusEx", snapshot)
    monkeypatch.setattr(preview, "read_memory_status_mb", lambda: (usable, 512))
    for requested in (60, 150, 240):
        expected = requested if cap is None else min(requested, cap)
        assert preview.effective_preview_dpi(requested) == expected


@pytest.mark.parametrize("usable,expected", [
    (None, 150), (0, 100), (-1, 100), (4096, 72), (16144, 100), (32768, 150),
])
def test_color_preview_custom_reader_ignores_strong_host(monkeypatch, usable, expected):
    from app.core import color_conversion_preview as preview

    calls = []

    def installed():
        calls.append(True)
        return 65536

    monkeypatch.setattr(memory, "read_installed_memory_mb", installed)
    assert preview.effective_preview_dpi(150, lambda: (usable, 512)) == expected
    assert calls == []


@pytest.mark.parametrize("installed,usable,expected", [
    (8192, 7952, 100), (16384, 16144, 150), (None, 16144, 100),
    (4096, 16144, 100), (16384, None, 150), (16384, 0, 100), (16384, -1, 100),
])
def test_color_preview_explicit_tier_reader_is_deterministic(
    monkeypatch, installed, usable, expected
):
    from app.core import color_conversion_preview as preview

    def must_not_read():
        pytest.fail("Reader RAM minh thị không được đọc hardware host.")

    observed = []

    def tier_reader(total):
        observed.append(total)
        return installed

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    assert preview.effective_preview_dpi(
        150, lambda: (usable, 512), tier_reader=tier_reader,
    ) == expected
    assert observed == [usable]


def test_accurate_preview_pure_gate_keeps_unknown_policy(monkeypatch):
    from app.core import viewer_accurate_cache as cache

    def must_not_read():
        pytest.fail("Gate thuần không được tự đọc hardware.")

    monkeypatch.setattr(memory, "read_installed_memory_mb", must_not_read)
    for usable, expected in [(None, None), (0, None), (-1, None), (7952, 1), (16144, 2)]:
        assert cache.render_concurrency_for_total_ram(usable) == expected

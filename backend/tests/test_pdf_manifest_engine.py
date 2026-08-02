from contextlib import ExitStack
import json
from pathlib import Path
from types import SimpleNamespace

import pikepdf
import pytest
from PIL import Image

from app.workers import pdf_manifest_engine as manifest_engine
from app.workers.pdf_manifest_engine import ManifestResourceEstimate, merge_manifest


SRGB_PROFILE = (Path(__file__).resolve().parents[1] / "app/assets/icc/sRGB.icc").read_bytes()


def _make_pdf(
    path: Path,
    count: int = 2,
    *,
    width_base: int = 200,
    height_base: int = 300,
) -> None:
    pdf = pikepdf.Pdf.new()
    for index in range(count):
        page = pdf.add_blank_page(
            page_size=(width_base + index, height_base + index)
        )
        page.obj["/Rotate"] = index * 90
    pdf.save(path)


def _make_png(path: Path, size: tuple[int, int] = (20, 30), dpi: tuple[int, int] = (30, 30)) -> None:
    Image.new('RGBA', size, (255, 255, 255, 128)).save(path, format='PNG', dpi=dpi)


def _make_jpeg(path: Path, size: tuple[int, int] = (300, 600), dpi: tuple[int, int] = (150, 300)) -> None:
    Image.new("RGB", size, (240, 230, 220)).save(path, format="JPEG", dpi=dpi, quality=90)


def _make_png_16bit(path: Path) -> None:
    Image.new("I;16", (2, 1), 32768).save(path, format="PNG")


def _make_png_with_icc(path: Path) -> None:
    Image.new("RGB", (2, 1), (10, 20, 30)).save(
        path,
        format="PNG",
        icc_profile=SRGB_PROFILE,
    )


def _make_apng(path: Path, size: tuple[int, int] = (20, 30)) -> None:
    first = Image.new("RGBA", size, (255, 0, 0, 255))
    second = Image.new("RGBA", size, (0, 0, 255, 128))
    first.save(
        path,
        format="PNG",
        save_all=True,
        append_images=[second],
        duration=[100, 100],
        loop=0,
    )


def _make_jpeg_with_icc(path: Path) -> None:
    Image.new("RGB", (2, 1), (10, 20, 30)).save(
        path,
        format="JPEG",
        quality=90,
        icc_profile=SRGB_PROFILE,
    )


def _first_image_xobject(page):
    xobjects = page.obj["/Resources"]["/XObject"]
    return next(obj for _name, obj in xobjects.items() if obj.get("/Subtype") == "/Image")


def _estimate_resources(file_paths: list[str], manifest: list[dict]) -> ManifestResourceEstimate:
    with ExitStack() as stack:
        sources: dict[int, pikepdf.Pdf] = {}
        image_infos = {}
        manifest_engine._validate_source_extensions(file_paths)
        return manifest_engine._estimate_manifest_resources(
            file_paths,
            manifest,
            sources,
            stack,
            image_infos,
        )


def _synthetic_estimate(
    pages: int,
    *,
    peak_ram_mb: int = 256,
    output_mb: int = 128,
    working_disk_mb: int = 256,
) -> ManifestResourceEstimate:
    mib = 1024 * 1024
    return ManifestResourceEstimate(
        expanded_pages=pages,
        blank_pages=0,
        pdf_page_occurrences=pages,
        image_page_occurrences=0,
        unique_image_pixels=0,
        expanded_image_pixels=0,
        largest_image_pixels=0,
        used_source_bytes=0,
        estimated_output_bytes=output_mb * mib,
        estimated_peak_ram_bytes=peak_ram_mb * mib,
        estimated_working_disk_bytes=working_disk_mb * mib,
    )


def _set_resource_snapshot(
    monkeypatch,
    *,
    total_mb: float,
    available_mb: float,
    free_disk_gb: float = 100,
    slots: int = 1,
) -> None:
    monkeypatch.delenv("PRYNX_MANIFEST_MAX_PAGES", raising=False)
    monkeypatch.delenv("PRYNX_MANIFEST_MAX_OUTPUT_MB", raising=False)
    monkeypatch.setattr(
        manifest_engine,
        "read_memory_status_mb",
        lambda: (total_mb, available_mb),
    )
    monkeypatch.setattr(manifest_engine, "max_active_heavy_jobs", lambda: slots)
    monkeypatch.setattr(
        manifest_engine.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=int(free_disk_gb * 1024 ** 3)),
    )


def test_merge_manifest_selects_pages_blanks_and_composes_rotation(tmp_path: Path):
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source)

    merge_manifest(
        [str(source)],
        [
            {"file_index": 0, "page_index": 1, "rotation": 90},
            {"blank": True, "width": 400, "height": 500},
            {"file_index": 0, "page_index": 0},
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 3
        assert int(pdf.pages[0].obj.get("/Rotate", 0)) % 360 == 180
        assert tuple(float(v) for v in pdf.pages[1].mediabox) == (0.0, 0.0, 400.0, 500.0)
        assert int(pdf.pages[2].obj.get("/Rotate", 0)) == 0


def test_merge_manifest_interleave_round_robins_all_sources(tmp_path: Path):
    source_a = tmp_path / "a.pdf"
    source_b = tmp_path / "b.pdf"
    output = tmp_path / "interleaved.pdf"
    progress: list[tuple[str, int, int]] = []
    completed_sources: list[int] = []
    _make_pdf(source_a, count=3, width_base=100, height_base=200)
    _make_pdf(source_b, count=2, width_base=400, height_base=500)

    merge_manifest(
        [str(source_a), str(source_b)],
        [{"file_index": 0}, {"file_index": 1}],
        str(output),
        order_mode="interleave",
        progress_callback=lambda phase, completed, total: progress.append(
            (phase, completed, total)
        ),
        source_completed_callback=completed_sources.append,
    )

    with pikepdf.Pdf.open(output) as pdf:
        widths = [float(page.mediabox[2] - page.mediabox[0]) for page in pdf.pages]
    assert widths == [100.0, 400.0, 101.0, 401.0, 102.0]
    assert ("saving", 5, 5) in progress
    assert completed_sources == [1, 0]


def test_merge_manifest_rejects_bad_page_reference(tmp_path: Path):
    source = tmp_path / "source.pdf"
    _make_pdf(source, count=1)
    with pytest.raises(ValueError, match="page index"):
        merge_manifest([str(source)], [{"file_index": 0, "page_index": 9}], str(tmp_path / "out.pdf"))


def test_merge_manifest_missing_page_index_appends_whole_file(tmp_path: Path):
    # A non-expanded multi-page PDF node omits page_index. It must expand to ALL
    # pages, not silently collapse to page 0 (the data-loss regression).
    source_a = tmp_path / "a.pdf"
    source_b = tmp_path / "b.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source_a, count=3)
    _make_pdf(source_b, count=2)

    merge_manifest(
        [str(source_a), str(source_b)],
        [
            {"file_index": 0},              # whole 3-page file
            {"file_index": 1, "page_index": 1},  # single page
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 4  # 3 + 1, not 1 + 1

        # Missing page_index expands every source page without changing order.
        assert [int(page.obj.get("/Rotate", 0)) % 360 for page in pdf.pages[:3]] == [0, 90, 180]


def test_merge_manifest_blank_without_size_inherits_first_page(tmp_path: Path):
    # A blank with no explicit dimensions mirrors the old frontend behavior:
    # it takes the size of the first output page.
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source, count=1)  # first page is 200x300

    merge_manifest(
        [str(source)],
        [
            {"file_index": 0, "page_index": 0},
            {"blank": True},  # no width/height → inherit 200x300
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        assert tuple(float(v) for v in pdf.pages[1].mediabox) == (0.0, 0.0, 200.0, 300.0)


def test_merge_manifest_rotated_blank_uses_visible_first_page_size(tmp_path: Path):
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source, count=2)

    # Source page 1 has MediaBox 201x301 and /Rotate=90, so its visible size is
    # 301x201. The blank starts at that visible size and then rotates by 90.
    merge_manifest(
        [str(source)],
        [
            {"file_index": 0, "page_index": 1},
            {"blank": True, "rotation": 90},
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        assert tuple(float(v) for v in pdf.pages[1].mediabox) == (0.0, 0.0, 301.0, 201.0)
        assert int(pdf.pages[1].obj.get("/Rotate", 0)) % 360 == 90

def test_merge_manifest_accepts_png_preserves_dpi_and_rotation(tmp_path: Path):
    source_pdf = tmp_path / "source.pdf"
    source_png = tmp_path / "source.png"
    output = tmp_path / "output.pdf"
    _make_pdf(source_pdf, count=2)
    _make_png(source_png)

    merge_manifest(
        [str(source_pdf), str(source_png)],
        [
            {"file_index": 0},
            {"file_index": 1, "rotation": 90},
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 3
        image_page = pdf.pages[2]
        width = float(image_page.mediabox[2])
        height = float(image_page.mediabox[3])
        assert width == pytest.approx((20 / 30) * 72, abs=0.1)
        assert height == pytest.approx((30 / 30) * 72, abs=0.1)
        assert int(image_page.obj.get("/Rotate", 0)) % 360 == 90
        assert "/SMask" in _first_image_xobject(image_page)


def test_merge_manifest_accepts_jpeg_preserves_jfif_dpi_and_dct(tmp_path: Path):
    source = tmp_path / "source.jpg"
    output = tmp_path / "output.pdf"
    _make_jpeg(source)

    merge_manifest([str(source)], [{"file_index": 0}], str(output))

    with pikepdf.Pdf.open(output) as pdf:
        page = pdf.pages[0]
        assert float(page.mediabox[2]) == pytest.approx(144, abs=0.1)
        assert float(page.mediabox[3]) == pytest.approx(144, abs=0.1)
        filters = _first_image_xobject(page).get("/Filter")
        assert "/DCTDecode" in (
            [str(filters)]
            if not isinstance(filters, pikepdf.Array)
            else [str(value) for value in filters]
        )


@pytest.mark.parametrize(
    ("name", "maker"),
    [
        ("source-16bit.png", _make_png_16bit),
        ("source-icc.png", _make_png_with_icc),
        ("source-icc.jpg", _make_jpeg_with_icc),
        ("source-apng.png", _make_apng),
    ],
)
def test_merge_manifest_routes_quality_sensitive_images_to_native(
    monkeypatch,
    tmp_path: Path,
    name: str,
    maker,
):
    source = tmp_path / name
    output = tmp_path / "lossless.pdf"
    maker(source)
    captured: dict[str, object] = {}

    def fake_native(request_json, output_path, _workers, progress, _cancelled):
        request = json.loads(request_json)
        captured["request"] = request
        progress(0)
        with pikepdf.Pdf.new() as pdf:
            pdf.add_blank_page(page_size=(10, 10))
            pdf.save(output_path)
        return output_path

    monkeypatch.setattr(manifest_engine, "_load_native_image_merger", lambda: fake_native)

    merge_manifest([str(source)], [{"file_index": 0}], str(output))

    assert output.exists()
    assert captured["request"]["sources"][0]["path"] == str(source)


@pytest.mark.parametrize(
    ("name", "maker"),
    [
        ("source-16bit.png", _make_png_16bit),
        ("source-apng.png", _make_apng),
    ],
)
def test_merge_manifest_fails_closed_when_required_native_is_unavailable(
    monkeypatch,
    tmp_path: Path,
    name: str,
    maker,
):
    source = tmp_path / name
    output = tmp_path / "must-not-exist.pdf"
    maker(source)
    monkeypatch.setattr(manifest_engine, "_load_native_image_merger", lambda: None)

    with pytest.raises(manifest_engine.ImageQualityGuardError, match="native lossless"):
        merge_manifest([str(source)], [{"file_index": 0}], str(output))

    assert not output.exists()


def test_apng_native_expands_frames_and_uses_working_pixel_budget(
    monkeypatch,
    tmp_path: Path,
):
    source = tmp_path / "source-apng.png"
    output = tmp_path / "apng.pdf"
    _make_apng(source)
    captured: dict[str, object] = {}

    def fake_plan_worker_count(**kwargs):
        captured["worker_plan"] = kwargs
        return 8, "test"

    def fake_native(request_json, output_path, workers, progress, _cancelled):
        request = json.loads(request_json)
        captured["request"] = request
        captured["workers"] = workers
        progress(0)
        with pikepdf.Pdf.new() as pdf:
            pdf.add_blank_page(page_size=(20, 30))
            pdf.add_blank_page(page_size=(20, 30))
            pdf.save(output_path)
        return output_path

    monkeypatch.setattr(manifest_engine, "plan_worker_count", fake_plan_worker_count)
    monkeypatch.setattr(manifest_engine, "_load_native_image_merger", lambda: fake_native)

    merge_manifest([str(source)], [{"file_index": 0}], str(output))

    info = manifest_engine._inspect_image_source(str(source))
    assert info.frame_count == 2
    assert info.requires_native_lossless is True
    assert info.working_pixels == info.pixels * 2
    assert captured["worker_plan"]["per_worker_mb"] == pytest.approx(
        max(64.0, info.working_pixels * 8 / (1024 * 1024) + 64)
    )
    assert captured["workers"] == 1
    assert len(captured["request"]["pages"]) == 1
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2


def test_apng_single_frame_selection_fails_closed(monkeypatch, tmp_path: Path):
    source = tmp_path / "source-apng.png"
    output = tmp_path / "must-not-exist.pdf"
    _make_apng(source)

    def should_not_call_native(*_args, **_kwargs):
        pytest.fail("Không được gọi native với hợp đồng chọn frame sai")

    monkeypatch.setattr(
        manifest_engine,
        "_load_native_image_merger",
        lambda: should_not_call_native,
    )

    with pytest.raises(manifest_engine.ImageQualityGuardError, match="native lossless"):
        merge_manifest(
            [str(source)],
            [{"file_index": 0, "page_index": 0}],
            str(output),
        )

    assert not output.exists()


def test_native_image_fast_path_maps_completed_sources(monkeypatch, tmp_path: Path):
    source_a = tmp_path / "a.png"
    source_b = tmp_path / "b.png"
    output = tmp_path / "native.pdf"
    _make_png(source_a, size=(10, 20))
    _make_png(source_b, size=(30, 40))
    completed_sources: list[int] = []
    captured: dict[str, object] = {}

    def fake_native(request_json, output_path, workers, progress, cancelled):
        request = json.loads(request_json)
        captured["request"] = request
        captured["workers"] = workers
        assert cancelled() is False
        progress(1)
        progress(0)
        with pikepdf.Pdf.new() as pdf:
            for page in request["pages"]:
                if page.get("blank"):
                    width = page.get("width", 595.28)
                    height = page.get("height", 841.89)
                else:
                    source = request["sources"][page["file_index"]]
                    width = source["width_pt"]
                    height = source["height_pt"]
                pdf.add_blank_page(page_size=(width, height))
            pdf.save(output_path)
        return output_path

    monkeypatch.setattr(
        manifest_engine,
        "_load_native_image_merger",
        lambda: fake_native,
    )
    monkeypatch.setattr(
        manifest_engine,
        "plan_worker_count",
        lambda **_kwargs: (16, "test"),
    )

    merge_manifest(
        [str(source_a), str(source_b)],
        [
            {"file_index": 0},
            {"blank": True, "width": 100, "height": 200},
            {"file_index": 1, "rotation": 90},
        ],
        str(output),
        source_completed_callback=completed_sources.append,
    )

    assert completed_sources == [1, 0]
    assert captured["workers"] == 2
    request = captured["request"]
    assert isinstance(request, dict)
    assert len(request["sources"]) == 2
    assert [page.get("file_index") for page in request["pages"]] == [0, None, 1]
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 3


def test_native_unsupported_falls_back_without_duplicate_source_event(
    monkeypatch,
    tmp_path: Path,
):
    source = tmp_path / "icc.png"
    output = tmp_path / "fallback.pdf"
    _make_png(source)
    completed_sources: list[int] = []

    def unsupported(*_args, **_kwargs):
        raise NotImplementedError("ICC cần fallback")

    monkeypatch.setattr(
        manifest_engine,
        "_load_native_image_merger",
        lambda: unsupported,
    )
    monkeypatch.setattr(
        manifest_engine,
        "plan_worker_count",
        lambda **_kwargs: (4, "test"),
    )

    merge_manifest(
        [str(source)],
        [{"file_index": 0}, {"file_index": 0}],
        str(output),
        source_completed_callback=completed_sources.append,
    )

    assert completed_sources == [0]
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2


def test_merge_manifest_rejects_extension_content_mismatch(tmp_path: Path):
    source = tmp_path / "spoofed.png"
    _make_jpeg(source)

    with pytest.raises(ValueError, match="ảnh"):
        merge_manifest([str(source)], [{"file_index": 0}], str(tmp_path / "out.pdf"))


def test_merge_manifest_rejects_decompression_bomb_warning(monkeypatch, tmp_path: Path):
    source = tmp_path / "large.png"
    _make_png(source, size=(20, 20))
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 300)

    with pytest.raises(ValueError, match="ảnh"):
        merge_manifest([str(source)], [{"file_index": 0}], str(tmp_path / "out.pdf"))


def test_merge_manifest_does_not_decode_unreferenced_image(tmp_path: Path):
    source_pdf = tmp_path / "source.pdf"
    unused_image = tmp_path / "unused.png"
    output = tmp_path / "output.pdf"
    _make_pdf(source_pdf, count=1)
    unused_image.write_bytes(b"not-an-image")

    merge_manifest(
        [str(source_pdf), str(unused_image)],
        [{"file_index": 0}],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 1


def test_merge_manifest_rejects_corrupt_image(tmp_path: Path):
    source = tmp_path / "broken.png"
    source.write_bytes(b"not-an-image")

    with pytest.raises(ValueError, match="ảnh"):
        merge_manifest([str(source)], [{"file_index": 0}], str(tmp_path / "out.pdf"))
def test_resource_estimate_counts_whole_file_repeats_and_image_pixels(tmp_path: Path):
    source_pdf = tmp_path / "source.pdf"
    source_png = tmp_path / "source.png"
    _make_pdf(source_pdf, count=3)
    _make_png(source_png, size=(20, 30))

    estimate = _estimate_resources(
        [str(source_pdf), str(source_png)],
        [
            {"file_index": 0},
            {"file_index": 0},
            {"file_index": 0, "page_index": 1},
            {"file_index": 1},
            {"file_index": 1, "page_index": 0},
            {"blank": True},
        ],
    )

    assert estimate.expanded_pages == 10
    assert estimate.pdf_page_occurrences == 7
    assert estimate.image_page_occurrences == 2
    assert estimate.blank_pages == 1
    assert estimate.unique_image_pixels == 600
    assert estimate.expanded_image_pixels == 1_200
    assert estimate.largest_image_pixels == 600
    assert estimate.estimated_output_bytes > estimate.used_source_bytes
    assert estimate.estimated_working_disk_bytes > estimate.estimated_output_bytes


def test_resource_estimate_expands_all_apng_frames(tmp_path: Path):
    source = tmp_path / "source-apng.png"
    _make_apng(source, size=(20, 30))

    estimate = _estimate_resources([str(source)], [{"file_index": 0}])

    assert estimate.expanded_pages == 2
    assert estimate.image_page_occurrences == 2
    assert estimate.unique_image_pixels == 1_200
    assert estimate.expanded_image_pixels == 1_200
    assert estimate.largest_image_pixels == 1_200


@pytest.mark.parametrize(
    ("total_mb", "pages", "expected_cap"),
    [
        (6 * 1024.0, manifest_engine.LOW_RAM_MAX_EXPANDED_PAGES + 1, "4,000"),
        (12 * 1024.0, manifest_engine.MID_RAM_MAX_EXPANDED_PAGES + 1, "10,000"),
    ],
)
def test_admission_caps_expanded_pages_only_on_low_memory_tiers(
    monkeypatch,
    tmp_path: Path,
    total_mb: float,
    pages: int,
    expected_cap: str,
):
    _set_resource_snapshot(
        monkeypatch,
        total_mb=total_mb,
        available_mb=total_mb * 0.75,
    )

    with pytest.raises(ValueError, match=expected_cap):
        manifest_engine._enforce_manifest_admission(
            _synthetic_estimate(pages),
            str(tmp_path / "out.pdf"),
        )


def test_admission_has_no_default_page_cap_on_strong_machine(monkeypatch, tmp_path: Path):
    _set_resource_snapshot(
        monkeypatch,
        total_mb=32 * 1024.0,
        available_mb=24 * 1024.0,
    )

    manifest_engine._enforce_manifest_admission(
        _synthetic_estimate(50_000),
        str(tmp_path / "out.pdf"),
    )


def test_explicit_page_override_wins_both_directions(monkeypatch, tmp_path: Path):
    _set_resource_snapshot(
        monkeypatch,
        total_mb=6 * 1024.0,
        available_mb=5 * 1024.0,
    )
    monkeypatch.setenv("PRYNX_MANIFEST_MAX_PAGES", "50_000")
    manifest_engine._enforce_manifest_admission(
        _synthetic_estimate(4_001),
        str(tmp_path / "out.pdf"),
    )

    monkeypatch.setattr(
        manifest_engine,
        "read_memory_status_mb",
        lambda: (32 * 1024.0, 24 * 1024.0),
    )
    monkeypatch.setenv("PRYNX_MANIFEST_MAX_PAGES", "3")
    with pytest.raises(ValueError, match="PRYNX_MANIFEST_MAX_PAGES"):
        manifest_engine._enforce_manifest_admission(
            _synthetic_estimate(4),
            str(tmp_path / "out.pdf"),
        )


def test_strong_machine_is_rejected_only_when_physical_ram_is_insufficient(
    monkeypatch,
    tmp_path: Path,
):
    _set_resource_snapshot(
        monkeypatch,
        total_mb=32 * 1024.0,
        available_mb=2 * 1024.0,
    )

    with pytest.raises(ValueError, match="RAM"):
        manifest_engine._enforce_manifest_admission(
            _synthetic_estimate(2_000, peak_ram_mb=1_024),
            str(tmp_path / "out.pdf"),
        )


def test_admission_rejects_when_working_disk_budget_is_insufficient(
    monkeypatch,
    tmp_path: Path,
):
    _set_resource_snapshot(
        monkeypatch,
        total_mb=32 * 1024.0,
        available_mb=24 * 1024.0,
        free_disk_gb=1,
    )

    with pytest.raises(ValueError, match="đĩa tạm"):
        manifest_engine._enforce_manifest_admission(
            _synthetic_estimate(2_000, working_disk_mb=1_024),
            str(tmp_path / "out.pdf"),
        )

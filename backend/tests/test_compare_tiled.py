"""Parity comparator tile cho trang lớn (PERF audit 2026-08-19 §CL.2)."""

import cv2
import numpy as np
import pytest
from PIL import Image

from app.config import settings
from app.core.comparison_engine import (
    _aligned_tiled_reader,
    _comparison_size_strategy,
    _normalize_tiled_previews,
    _prepare_tiled_size_readers,
)
from app.core.highlight_renderer import HighlightRenderer
from app.core.image_comparator import ImageComparator


def _base_image(width: int = 257, height: int = 193) -> np.ndarray:
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (18, 22), (105, 78), (20, 60, 120), -1)
    cv2.circle(image, (174, 66), 31, (80, 180, 30), -1)
    cv2.line(image, (24, 142), (225, 118), (10, 10, 10), 4)
    cv2.putText(
        image,
        "PrynX",
        (112, 172),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (30, 30, 30),
        2,
        cv2.LINE_AA,
    )
    return image


def _reader(image: np.ndarray):
    def read(x: int, y: int, width: int, height: int) -> np.ndarray:
        return image[y:y + height, x:x + width].copy()

    return read


def _region_boxes(result) -> list[tuple[int, int, int, int]]:
    return sorted(
        (region.x, region.y, region.width, region.height)
        for region in result.diff_regions
    )


def _assert_full_tile_parity(
    image_a: np.ndarray,
    image_b: np.ndarray,
    tolerance: str,
) -> None:
    comparator = ImageComparator()
    config = {"dpi": 150}
    full = comparator.compare(
        image_a,
        image_b,
        tolerance=tolerance,
        config=config,
    )
    tiled = comparator.compare_tiled(
        _reader(image_a),
        _reader(image_b),
        image_a.shape[1],
        image_a.shape[0],
        tolerance=tolerance,
        config=config,
        tile_size=64,
        preview_img1=image_a,
        preview_img2=image_b,
        collect_diff_mask=True,
    )

    assert tiled.diff_count == full.diff_count
    assert tiled.diff_pixel_percentage == full.diff_pixel_percentage
    assert _region_boxes(tiled) == _region_boxes(full)
    assert np.array_equal(tiled.diff_mask, full.diff_mask)


@pytest.mark.parametrize("tolerance", ["STRICT", "NORMAL", "LOOSE"])
def test_tiled_identical_page_matches_full_frame(tolerance: str):
    image = _base_image()
    _assert_full_tile_parity(image, image.copy(), tolerance)


@pytest.mark.parametrize("tolerance", ["STRICT", "NORMAL", "LOOSE"])
def test_tiled_regions_on_corner_and_across_seams_match_full_frame(tolerance: str):
    image_a = _base_image()
    image_b = image_a.copy()
    # Vùng đầu tiên cắt qua cả biên dọc x=64 và biên ngang y=64.
    cv2.rectangle(image_b, (58, 57), (76, 73), (255, 0, 180), -1)
    # Vùng thứ hai nằm sát góc phải-dưới của tile cuối không đủ kích thước.
    cv2.rectangle(image_b, (249, 185), (256, 192), (0, 0, 0), -1)
    _assert_full_tile_parity(image_a, image_b, tolerance)


def test_tiled_strict_preserves_one_pixel_stroke_across_tile_seam():
    image_a = _base_image()
    image_b = image_a.copy()
    cv2.line(image_b, (41, 128), (91, 128), (0, 0, 0), 1)
    _assert_full_tile_parity(image_a, image_b, "STRICT")


@pytest.mark.parametrize("tolerance", ["NORMAL", "LOOSE"])
def test_tiled_uses_one_global_translation_for_all_tiles(tolerance: str):
    image_a = _base_image()
    height, width = image_a.shape[:2]
    image_b = cv2.warpAffine(
        image_a,
        np.float32([[1, 0, 2], [0, 1, -1]]),
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    _assert_full_tile_parity(image_a, image_b, tolerance)


def test_tiled_downscaled_preview_keeps_integer_translation_parity():
    image_a = cv2.resize(_base_image(), (1600, 1200), interpolation=cv2.INTER_CUBIC)
    height, width = image_a.shape[:2]
    image_b = cv2.warpAffine(
        image_a,
        np.float32([[1, 0, 2], [0, 1, -1]]),
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    preview_size = (1200, 900)
    preview_a = cv2.resize(image_a, preview_size, interpolation=cv2.INTER_AREA)
    preview_b = cv2.resize(image_b, preview_size, interpolation=cv2.INTER_AREA)
    comparator = ImageComparator()
    full = comparator.compare(
        image_a, image_b, tolerance="NORMAL", config={"dpi": 150}
    )
    tiled = comparator.compare_tiled(
        _reader(image_a),
        _reader(image_b),
        width,
        height,
        tolerance="NORMAL",
        config={"dpi": 150},
        tile_size=256,
        preview_img1=preview_a,
        preview_img2=preview_b,
        collect_diff_mask=True,
    )

    assert np.array_equal(tiled.diff_mask, full.diff_mask)
    assert _region_boxes(tiled) == _region_boxes(full)


def test_tiled_can_skip_full_page_mask_allocation():
    image_a = _base_image()
    image_b = image_a.copy()
    cv2.rectangle(image_b, (61, 90), (72, 110), (0, 0, 0), -1)

    result = ImageComparator().compare_tiled(
        _reader(image_a),
        _reader(image_b),
        image_a.shape[1],
        image_a.shape[0],
        tolerance="NORMAL",
        tile_size=64,
        preview_img1=image_a,
        preview_img2=image_b,
        collect_diff_mask=False,
    )

    assert result.diff_count == 1
    assert result.diff_mask is None


def test_tiled_highlight_png_matches_full_frame_pixels(tmp_path, monkeypatch):
    image_a = _base_image()
    image_b = image_a.copy()
    cv2.rectangle(image_b, (63, 61), (75, 78), (0, 0, 0), -1)
    comparator = ImageComparator()
    result = comparator.compare(image_a, image_b, tolerance="STRICT")
    assert result.highlighted_image is not None

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    renderer = HighlightRenderer()
    renderer.save_tiled_highlight_image(
        _reader(image_b),
        result.diff_regions,
        image_b.shape[1],
        image_b.shape[0],
        "job-tile",
        1,
        stripe_height=31,
        sign_url=False,
    )

    tiled = cv2.imread(
        str(tmp_path / "job-tile" / "page_1_diff.png"),
        cv2.IMREAD_COLOR,
    )
    expected = cv2.cvtColor(result.highlighted_image, cv2.COLOR_RGB2BGR)
    assert np.array_equal(tiled, expected)


def test_tiled_cmyk_reads_only_final_rois_and_matches_full_frame(tmp_path, monkeypatch):
    """CMYK tile giữ nguyên vùng, channel delta, mô tả và artifact của đường cũ."""
    image_a = _base_image()
    image_b = image_a.copy()
    cv2.rectangle(image_b, (61, 58), (82, 79), (230, 10, 170), -1)
    cmyk_a = np.array(Image.fromarray(image_a).convert("CMYK"))
    cmyk_b = np.array(Image.fromarray(image_b).convert("CMYK"))
    comparator = ImageComparator()

    full = comparator.compare_cmyk(
        cmyk_a,
        cmyk_b,
        tolerance="STRICT",
        rgb_a=image_a,
        rgb_b=image_b,
        config={"dpi": 150},
    )
    tiled = comparator.compare_tiled(
        _reader(image_a),
        _reader(image_b),
        image_a.shape[1],
        image_a.shape[0],
        tolerance="STRICT",
        config={"dpi": 150},
        tile_size=64,
        preview_img1=image_a,
        preview_img2=image_b,
        collect_diff_mask=True,
    )
    roi_calls = []

    def read_cmyk(image):
        def read(x: int, y: int, width: int, height: int):
            roi_calls.append((x, y, width, height))
            return image[y:y + height, x:x + width].copy()

        return read

    comparator.augment_cmyk_regions(
        tiled,
        read_cmyk(cmyk_a),
        read_cmyk(cmyk_b),
        image_a.shape[1],
        image_a.shape[0],
    )

    assert np.array_equal(tiled.diff_mask, full.diff_mask)
    assert _region_boxes(tiled) == _region_boxes(full)
    assert [region.type for region in tiled.diff_regions] == [
        region.type for region in full.diff_regions
    ]
    assert [region.description for region in tiled.diff_regions] == [
        region.description for region in full.diff_regions
    ]
    assert all(region.type == "cmyk" for region in tiled.diff_regions)
    expected_roi_calls = []
    for region in tiled.diff_regions:
        expected_roi_calls.extend([
            (region.x, region.y, region.width, region.height),
            (region.x, region.y, region.width, region.height),
        ])
    assert roi_calls == expected_roi_calls

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    HighlightRenderer().save_tiled_highlight_image(
        _reader(image_b),
        tiled.diff_regions,
        image_b.shape[1],
        image_b.shape[0],
        "job-cmyk-tile",
        1,
        stripe_height=31,
        sign_url=False,
    )
    artifact = cv2.imread(
        str(tmp_path / "job-cmyk-tile" / "page_1_diff.png"),
        cv2.IMREAD_COLOR,
    )
    expected = cv2.cvtColor(full.highlighted_image, cv2.COLOR_RGB2BGR)
    assert np.array_equal(artifact, expected)


@pytest.mark.parametrize("strategy", ["pad", "scale"])
def test_tiled_different_sizes_match_full_frame_mask_regions_and_artifact(
    strategy, tmp_path, monkeypatch
):
    image_a = _base_image()
    if strategy == "pad":
        image_b = image_a[:167, :180].copy()
        cv2.rectangle(image_b, (61, 58), (82, 79), (230, 10, 170), -1)
    else:
        image_b = cv2.resize(image_a, (213, 160), interpolation=cv2.INTER_AREA)
        cv2.rectangle(image_b, (51, 48), (68, 66), (230, 10, 170), -1)

    comparator = ImageComparator()
    full = comparator.compare(
        image_a,
        image_b,
        tolerance="STRICT",
        config={"dpi": 150},
    )
    size_a = (image_a.shape[1], image_a.shape[0])
    size_b = (image_b.shape[1], image_b.shape[0])
    assert _comparison_size_strategy(size_a, size_b) == strategy
    target_size, read_a, read_b, read_base_b, close_staging = (
        _prepare_tiled_size_readers(
            _reader(image_a),
            _reader(image_b),
            size_a,
            size_b,
            strategy,
            tile_size=64,
            staging_dir=str(tmp_path),
        )
    )
    preview_a, preview_b = _normalize_tiled_previews(
        image_a.copy(), image_b.copy(), strategy
    )
    try:
        tiled = comparator.compare_tiled(
            read_a,
            read_b,
            target_size[0],
            target_size[1],
            tolerance="STRICT",
            config={"dpi": 150},
            tile_size=64,
            preview_img1=preview_a,
            preview_img2=preview_b,
            collect_diff_mask=True,
        )

        assert np.array_equal(tiled.diff_mask, full.diff_mask)
        assert tiled.diff_pixel_percentage == full.diff_pixel_percentage
        assert _region_boxes(tiled) == _region_boxes(full)

        monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
        HighlightRenderer().save_tiled_highlight_image(
            _aligned_tiled_reader(
                read_base_b,
                comparator,
                target_size,
                tiled.translation_x,
                tiled.translation_y,
            ),
            tiled.diff_regions,
            target_size[0],
            target_size[1],
            f"job-{strategy}-tile",
            1,
            stripe_height=31,
            sign_url=False,
        )
        artifact = cv2.imread(
            str(tmp_path / f"job-{strategy}-tile" / "page_1_diff.png"),
            cv2.IMREAD_COLOR,
        )
        expected = cv2.cvtColor(full.highlighted_image, cv2.COLOR_RGB2BGR)
        assert np.array_equal(artifact, expected)
    finally:
        close_staging()


def test_resize_staging_closes_files_when_cancelled(tmp_path):
    image = _base_image(213, 160)

    with pytest.raises(InterruptedError, match="Đã hủy"):
        _prepare_tiled_size_readers(
            _reader(image),
            _reader(_base_image()),
            (image.shape[1], image.shape[0]),
            (257, 193),
            "scale",
            tile_size=64,
            staging_dir=str(tmp_path),
            cancel_check=lambda: True,
        )

    assert list(tmp_path.iterdir()) == []


def test_tiled_worker_can_write_artifact_without_sidecar_token(tmp_path, monkeypatch):
    """Process spawn chỉ ghi path thô; process chính chịu trách nhiệm ký URL."""
    import app.core.highlight_renderer as highlight_module

    image = _base_image()
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(
        highlight_module,
        "result_access_url",
        lambda _path: (_ for _ in ()).throw(RuntimeError("không có token")),
    )

    path = HighlightRenderer().save_tiled_highlight_image(
        _reader(image),
        [],
        image.shape[1],
        image.shape[0],
        "worker-job",
        1,
        stripe_height=31,
        sign_url=False,
    )

    assert path == "/results/worker-job/page_1_diff.png"
    assert (tmp_path / "worker-job" / "page_1_diff.png").is_file()


def test_tiled_highlight_cancel_removes_partial_file(tmp_path, monkeypatch):
    image = _base_image()
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    renderer = HighlightRenderer()

    with pytest.raises(InterruptedError, match="Đã hủy"):
        renderer.save_tiled_highlight_image(
            _reader(image),
            [],
            image.shape[1],
            image.shape[0],
            "cancel-job",
            1,
            stripe_height=31,
            cancel_check=lambda: True,
            sign_url=False,
        )

    output_dir = tmp_path / "cancel-job"
    assert not (output_dir / "page_1_diff.png").exists()
    assert not (output_dir / "page_1_diff.png.part").exists()

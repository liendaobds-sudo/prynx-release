"""Test hạ mẫu ảnh khổ lớn (downsample-image endpoint)."""
import os
import pytest
from PIL import Image, ImageCms
from fastapi import UploadFile
from starlette.datastructures import Headers

from app.api.routes.pdf_tools import downsample_image


@pytest.fixture
def test_image_600dpi(tmp_path):
    """Tạo file ảnh PNG 600 DPI 1200x1800 px kèm ICC profile."""
    img_path = str(tmp_path / "test_poster_600dpi.png")
    img = Image.new("RGBA", (1200, 1800), color=(255, 100, 50, 255))
    srgb = ImageCms.createProfile("sRGB")
    icc_bytes = ImageCms.ImageCmsProfile(srgb).tobytes()
    img.save(img_path, "PNG", dpi=(600, 600), icc_profile=icc_bytes)
    return img_path


@pytest.mark.asyncio
async def test_downsample_image_from_600_to_150_dpi(test_image_600dpi):
    """Hạ mẫu ảnh từ 600 DPI về 150 DPI: kích thước giảm 4 lần (1200x1800 -> 300x450)."""
    resp = await downsample_image(
        source_path=test_image_600dpi,
        target_dpi=150,
    )
    assert resp["success"] is True
    assert resp["original_size"] == [1200, 1800]
    assert resp["resampled_size"] == [300, 450]
    assert resp["original_dpi"] == 600.0
    assert resp["resampled_dpi"] == 150.0
    assert resp["has_icc"] is True
    assert os.path.exists(resp["output_path"])
    assert resp.get("pdf_path") is not None
    assert os.path.exists(resp["pdf_path"])

    # Đọc lại file kết quả bằng Pillow để xác minh
    with Image.open(resp["output_path"]) as result_img:
        assert result_img.size == (300, 450)
        dpi = result_img.info.get("dpi")
        assert dpi is not None
        assert round(dpi[0]) == 150
        assert round(dpi[1]) == 150
        assert "icc_profile" in result_img.info


@pytest.mark.asyncio
async def test_downsample_image_already_small(tmp_path):
    """Ảnh đã có DPI nhỏ hơn hoặc bằng target_dpi thì không bị resize."""
    small_path = str(tmp_path / "small.png")
    img = Image.new("RGB", (400, 400), color=(100, 200, 100))
    img.save(small_path, "PNG", dpi=(150, 150))

    resp = await downsample_image(
        source_path=small_path,
        target_dpi=150,
    )
    assert resp["success"] is True
    assert resp["original_size"] == [400, 400]
    assert resp["resampled_size"] == [400, 400]
    assert resp.get("pdf_path") is not None
    assert os.path.exists(resp["pdf_path"])


@pytest.mark.asyncio
async def test_downsample_image_upload_file(tmp_path):
    """Hạ mẫu ảnh truyền qua UploadFile."""
    from io import BytesIO

    buf = BytesIO()
    img = Image.new("RGB", (800, 1200), color=(50, 150, 250))
    img.save(buf, "PNG", dpi=(300, 300))
    buf.seek(0)

    upload = UploadFile(
        file=buf,
        filename="test_upload.png",
        headers=Headers({"content-type": "image/png"}),
    )

    resp = await downsample_image(
        file=upload,
        target_dpi=150,
    )
    assert resp["success"] is True
    assert resp["original_size"] == [800, 1200]
    assert resp["resampled_size"] == [400, 600]
    assert resp.get("pdf_path") is not None
    assert os.path.exists(resp["pdf_path"])

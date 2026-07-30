"""Regression guard cho chuỗi cung ứng checkpoint Real-ESRGAN."""

from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "convert_realesrgan_onnx.py"


def test_checkpoints_have_reviewed_sha256() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    expected_hashes = {
        "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
        "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca",
        "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
    }

    assert "CHECKPOINT_SHA256" in source
    assert all(checksum in source for checksum in expected_hashes)
    assert "if _sha256(dst) != expected_sha256" in source
    assert "actual_sha256 = _sha256(temp_path)" in source


def test_torch_load_is_restricted_to_weights() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert 'torch.load(pth_path, map_location="cpu", weights_only=True)' in source
    assert 'torch.load(pth_path, map_location="cpu")' not in source


def test_download_is_atomic() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert "tempfile.mkstemp" in source
    assert "os.replace(temp_path, dst)" in source

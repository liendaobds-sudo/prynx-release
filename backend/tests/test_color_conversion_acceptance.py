"""Corpus nghiệm thu định lượng cho policy RGB → CMYK mặc định của PrynX.

Đây là gate LittleCMS + artifact, không phải mô phỏng máy in vật lý. Ngưỡng được
khóa theo bundle FOGRA39 và baseline audit 2026-08-20 để một thay đổi profile,
intent hoặc cờ BPC không thể âm thầm làm toàn bộ file tối hơn.
"""

from __future__ import annotations

import base64
import hashlib
import struct
import zlib
from io import BytesIO
from pathlib import Path

import numpy as np
import pikepdf
import pytest
from PIL import Image, ImageCms
from skimage.color import deltaE_ciede2000

from app.core import pdf_actions_native


FOGRA39_SHA256 = "da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77"

# Profile Adobe RGB cũ từng bị bundle nhầm dưới tên sRGB. Giữ byte profile ở
# test để chứng minh engine dùng ICC nhúng, không phụ thuộc ICC của Windows/CI.
ADOBE_RGB_1998_ICC = base64.b64decode(
    "AAACMEFEQkUCEAAAbW50clJHQiBYWVogB9AACAALABMAMwA7YWNzcEFQUEwAAAAAbm9uZQAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1BREJFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKY3BydAAAAPwAAAAyZGVzYwAAATAAAABrd3RwdAAAAZwAAAAUYmtwdAAAAbAAAAAUclRSQwAAAcQAAAAOZ1RSQwAAAdQAAAAOYlRSQwAAAeQAAAAOclhZWgAAAfQAAAAUZ1hZWgAAAggAAAAUYlhZWgAAAhwAAAAUdGV4dAAAAABDb3B5cmlnaHQgMjAwMCBBZG9iZSBTeXN0ZW1zIEluY29ycG9yYXRlZAAAAGRlc2MAAAAAAAAAEUFkb2JlIFJHQiAoMTk5OCkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAADzUQABAAAAARbMWFlaIAAAAAAAAAAAAAAAAAAAAABjdXJ2AAAAAAAAAAECMwAAY3VydgAAAAAAAAABAjMAAGN1cnYAAAAAAAAAAQIzAABYWVogAAAAAAAAnBgAAE+lAAAE/FhZWiAAAAAAAAA0jQAAoCwAAA+VWFlaIAAAAAAAACYxAAAQLwAAvpw="
)
ADOBE_RGB_SHA256 = "304f569a83c1e5eddaddac54e99ed03339333db013738bb499ab64f049887e28"
DISPLAY_P3_SHA256 = "62d770d4ec45596ce4a90d061ba6cf499e3944b57189b2c5037d12109d208225"

PATCHES = [
    ("paper_white", (255, 255, 255), 0.10),
    ("light_gray", (224, 224, 224), 1.00),
    ("skin", (214, 154, 123), 1.00),
    ("orange", (255, 128, 0), 4.00),
    ("cyan", (0, 200, 255), 4.00),
    ("blue", (0, 80, 255), 6.00),
    ("green", (0, 200, 80), 9.00),
    ("black_text", (0, 0, 0), None),
]


def _profile_paths() -> tuple[str, str]:
    # Neo thẳng bundle để biến môi trường ICC_PROFILE_DIR hoặc profile OS không
    # làm thay corpus baseline. Registry/path resolution có suite riêng bảo vệ.
    profile_dir = Path(__file__).resolve().parents[1] / "app" / "assets" / "icc"
    cmyk = profile_dir / "FOGRA39.icc"
    srgb = profile_dir / "sRGB.icc"
    assert cmyk.is_file(), "Bundle FOGRA39 là dependency bắt buộc của Convert Colors"
    assert srgb.is_file(), "Bundle sRGB chuẩn bị thiếu"
    assert hashlib.sha256(Path(cmyk).read_bytes()).hexdigest() == FOGRA39_SHA256
    source_identity = " ".join(
        (
            ImageCms.getProfileName(ImageCms.getOpenProfile(str(srgb))),
            ImageCms.getProfileDescription(ImageCms.getOpenProfile(str(srgb))),
        )
    ).lower()
    assert "srgb" in source_identity and "adobe rgb" not in source_identity
    return str(cmyk), str(srgb)


def _display_p3_icc() -> bytes:
    """Dựng matrix-shaper Display P3 cố định từ TRC sRGB đã bundle.

    Display P3 dùng primaries P3-D65 và transfer curve sRGB. Colorant được
    Bradford-adapt về D50 theo PCS của ICC; tag mô tả cũng đổi thật, không đặt
    lại tên cho một profile sRGB.
    """
    _cmyk, srgb_path = _profile_paths()
    blob = bytearray(Path(srgb_path).read_bytes())
    tag_count = struct.unpack_from(">I", blob, 128)[0]
    tags = {
        bytes(blob[132 + i * 12 : 136 + i * 12]).decode("ascii"): struct.unpack_from(
            ">II", blob, 136 + i * 12
        )
        for i in range(tag_count)
    }

    primaries = ((0.68, 0.32), (0.265, 0.69), (0.15, 0.06))
    primary_matrix = np.asarray(
        [[x / y, 1.0, (1.0 - x - y) / y] for x, y in primaries], dtype=np.float64
    ).T
    d65 = np.asarray([0.3127 / 0.3290, 1.0, (1.0 - 0.3127 - 0.3290) / 0.3290])
    rgb_to_d65 = primary_matrix @ np.diag(np.linalg.solve(primary_matrix, d65))
    bradford = np.asarray(
        [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]]
    )
    d50 = np.asarray([0.34567 / 0.35850, 1.0, (1.0 - 0.34567 - 0.35850) / 0.35850])
    adaptation = (
        np.linalg.inv(bradford)
        @ np.diag((bradford @ d50) / (bradford @ d65))
        @ bradford
    )
    colorants = adaptation @ rgb_to_d65

    def fixed(value: float) -> int:
        return int(round(value * 65536.0))

    for signature, column in (("rXYZ", 0), ("gXYZ", 1), ("bXYZ", 2)):
        offset, size = tags[signature]
        assert size == 20
        blob[offset : offset + size] = b"XYZ " + bytes(4) + b"".join(
            struct.pack(">i", fixed(value)) for value in colorants[:, column]
        )

    offset, size = tags["chrm"]
    assert size == 36
    blob[offset : offset + size] = struct.pack(
        ">4sIHH6I",
        b"chrm",
        0,
        3,
        0,
        *(fixed(value) for xy in primaries for value in xy),
    )

    # Tag `desc` hiện là mluc một locale, vùng payload 26 byte đủ cho 10 ký tự.
    offset, size = tags["desc"]
    description = "Display P3".encode("utf-16-be")
    assert blob[offset : offset + 4] == b"mluc" and len(description) <= size - 28
    struct.pack_into(">I", blob, offset + 20, len(description))
    blob[offset + 28 : offset + size] = description + bytes(size - 28 - len(description))
    blob[84:100] = bytes(16)  # profile ID không còn đúng sau khi đổi tag.
    result = bytes(blob)
    identity = ImageCms.getProfileDescription(ImageCms.getOpenProfile(BytesIO(result))).strip()
    assert identity == "Display P3"
    return result


def _open_profile(profile):
    if isinstance(profile, (bytes, bytearray)):
        return ImageCms.getOpenProfile(BytesIO(bytes(profile)))
    if isinstance(profile, (str, Path)):
        return ImageCms.getOpenProfile(str(profile))
    return profile


def _transform_image(
    image: Image.Image,
    source_profile,
    destination_profile,
    source_mode: str,
    destination_mode: str,
    intent: ImageCms.Intent,
) -> Image.Image:
    transform = ImageCms.buildTransform(
        _open_profile(source_profile),
        _open_profile(destination_profile),
        source_mode,
        destination_mode,
        renderingIntent=intent,
        flags=pdf_actions_native._CMS_FLAGS(black_point_compensation=True),
    )
    return ImageCms.applyTransform(image, transform)


def _l_star(rgb: np.ndarray) -> np.ndarray:
    """CIELAB L* từ sRGB D65; cùng metric đã dùng trong báo cáo audit."""
    normalized = rgb.astype(np.float64) / 255.0
    linear = np.where(
        normalized <= 0.04045,
        normalized / 12.92,
        ((normalized + 0.055) / 1.055) ** 2.4,
    )
    luminance = (
        linear[:, 0] * 0.2126
        + linear[:, 1] * 0.7152
        + linear[:, 2] * 0.0722
    )
    epsilon = (6.0 / 29.0) ** 3
    return np.where(
        luminance > epsilon,
        116.0 * np.cbrt(luminance) - 16.0,
        ((29.0 / 3.0) ** 3) * luminance,
    )


def _proof_rgb(rgb: np.ndarray, intent: ImageCms.Intent) -> np.ndarray:
    cmyk_path, srgb_path = _profile_paths()
    source = Image.fromarray(rgb.reshape(1, -1, 3), "RGB")
    separated = _transform_image(
        source, srgb_path, cmyk_path, "RGB", "CMYK", intent
    )
    proof = _transform_image(
        separated, cmyk_path, srgb_path, "CMYK", "RGB", intent
    )
    return np.asarray(proof, dtype=np.uint8).reshape(-1, 3)


def _build_patch_pdf(path: Path) -> None:
    content = bytearray()
    for index, (_name, rgb, _limit) in enumerate(PATCHES):
        r, g, b = (channel / 255.0 for channel in rgb)
        content.extend(
            f"{r:.8f} {g:.8f} {b:.8f} rg "
            f"{index * 12} 0 12 12 re f\n".encode("ascii")
        )

    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, len(PATCHES) * 12, 12],
        Resources=pikepdf.Dictionary(),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, bytes(content))),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(path)
    pdf.close()


def _build_rgb_image_pdf(
    path: Path,
    rgb: np.ndarray,
    width: int,
    height: int,
    source_icc: bytes | None = None,
) -> None:
    pdf = pikepdf.Pdf.new()
    if source_icc is None:
        colorspace = pikepdf.Name("/DeviceRGB")
    else:
        profile = pdf.make_stream(source_icc)
        profile["/N"] = 3
        colorspace = pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
    image = pikepdf.Stream(
        pdf,
        zlib.compress(rgb.astype(np.uint8).tobytes()),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=width,
        Height=height,
        BitsPerComponent=8,
        ColorSpace=colorspace,
        Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, width, height],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q\n".encode())
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(path)
    pdf.close()


def _build_adobe_like_calrgb_image_pdf(path: Path, rgb: np.ndarray) -> None:
    """CalRGB có calibration tương đương Adobe RGB 1998, không nhúng ICC."""
    pdf = pikepdf.Pdf.new()
    colorspace = pikepdf.Array(
        [
            pikepdf.Name("/CalRGB"),
            pikepdf.Dictionary(
                WhitePoint=[0.950455927, 1.0, 1.08905775],
                Gamma=[2.19921875, 2.19921875, 2.19921875],
                Matrix=[
                    0.5767309,
                    0.2973769,
                    0.0270343,
                    0.1855540,
                    0.6273491,
                    0.0706872,
                    0.1881852,
                    0.0752741,
                    0.9911085,
                ],
            ),
        ]
    )
    image = pikepdf.Stream(
        pdf,
        zlib.compress(rgb.astype(np.uint8).tobytes()),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=len(rgb),
        Height=1,
        BitsPerComponent=8,
        ColorSpace=colorspace,
        Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, len(rgb), 1],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, f"q {len(rgb)} 0 0 1 0 0 cm /Im0 Do Q\n".encode())
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(path)
    pdf.close()


def _build_rgb_alpha_image_pdf(
    path: Path,
    rgb: np.ndarray,
    alpha: np.ndarray,
    source_icc: bytes,
) -> None:
    """Tạo ảnh ICCBased RGB + SMask trong trang chỉ có một paint image.

    Đây là fixture nhỏ cho lane flatten cô lập; alpha được giữ ở dạng 8-bit
    DeviceGray để phép oracle có thể đối chiếu byte-for-byte với PDFium/CMM.
    """
    assert rgb.ndim == 2 and rgb.shape[1] == 3
    assert alpha.ndim == 1 and alpha.shape[0] == rgb.shape[0]
    width = int(rgb.shape[0])
    pdf = pikepdf.Pdf.new()
    profile = pdf.make_stream(source_icc)
    profile["/N"] = 3
    colorspace = pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
    )
    smask = pikepdf.Stream(
        pdf,
        zlib.compress(alpha.astype(np.uint8).tobytes()),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=width,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceGray"),
        Filter=pikepdf.Name("/FlateDecode"),
    )
    image = pikepdf.Stream(
        pdf,
        zlib.compress(rgb.astype(np.uint8).tobytes()),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=width,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=colorspace,
        SMask=pdf.make_indirect(smask),
        Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, width, 1],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, f"q {width} 0 0 1 0 0 cm /Im0 Do Q\n".encode())
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(path)
    pdf.close()


def _lab_d50(image: Image.Image, source_profile, source_mode: str) -> np.ndarray:
    """Lab D50 của Pillow; a/b là signed byte two's-complement, không offset 128."""
    lab_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("LAB"))
    converted = _transform_image(
        image,
        source_profile,
        lab_profile,
        source_mode,
        "LAB",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    raw = np.asarray(converted, dtype=np.uint8).reshape(-1, 3).astype(np.float64)
    ab = np.where(raw[:, 1:] > 127.0, raw[:, 1:] - 256.0, raw[:, 1:])
    return np.column_stack((raw[:, 0] * (100.0 / 255.0), ab))


def test_fogra39_relative_bpc_brightness_grid_does_not_regress(tmp_path):
    """Lưới ảnh 17³ qua artifact khóa độ sáng và TAC của Relative+BPC."""
    flags = pdf_actions_native._CMS_FLAGS(black_point_compensation=True)
    assert flags & ImageCms.Flags.NOOPTIMIZE
    assert flags & ImageCms.Flags.BLACKPOINTCOMPENSATION
    # Cố ý dùng 0,16,…,240,255 đúng corpus gốc; linspace làm đổi mẫu giữa.
    levels = np.asarray([*range(0, 256, 16), 255], dtype=np.uint8)
    rgb = np.asarray(
        [(r, g, b) for r in levels for g in levels for b in levels],
        dtype=np.uint8,
    )
    source_l = _l_star(rgb)

    cmyk_path, srgb_path = _profile_paths()
    source_path = tmp_path / "rgb-grid-17-cubed.pdf"
    output_path = tmp_path / "cmyk-grid-17-cubed.pdf"
    _build_rgb_image_pdf(source_path, rgb, width=17, height=17 * 17)
    result = pdf_actions_native.convert_to_cmyk(
        str(source_path),
        str(output_path),
        cmyk_path,
        srgb_path,
        rendering_intent="relative",
        black_point_compensation=True,
        preserve_black=True,
    )
    assert result["supported"] and result["images"] == 1, result
    assert result["postflight"]["passed"], result["postflight"]
    assert not pdf_actions_native.has_rgb_content(str(output_path))

    with pikepdf.open(output_path) as pdf:
        image = pdf.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        actual_cmyk = np.frombuffer(image.read_bytes(), dtype=np.uint8).reshape(-1, 4)

    expected_cmyk_image = _transform_image(
        Image.fromarray(rgb.reshape(1, -1, 3), "RGB"),
        srgb_path,
        cmyk_path,
        "RGB",
        "CMYK",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    expected_cmyk = np.asarray(expected_cmyk_image, dtype=np.uint8).reshape(-1, 4)
    assert actual_cmyk.shape == (17 ** 3, 4)
    assert np.max(
        np.abs(actual_cmyk.astype(np.int16) - expected_cmyk.astype(np.int16))
    ) <= 1

    actual_proof_image = _transform_image(
        Image.fromarray(actual_cmyk.reshape(1, -1, 4), "CMYK"),
        cmyk_path,
        srgb_path,
        "CMYK",
        "RGB",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    actual_proof = np.asarray(actual_proof_image, dtype=np.uint8).reshape(-1, 3)

    relative_delta = _l_star(actual_proof) - source_l
    perceptual_delta = _l_star(
        _proof_rgb(rgb, ImageCms.Intent.PERCEPTUAL)
    ) - source_l

    mean_abs = float(np.mean(np.abs(relative_delta)))
    mean_signed = float(np.mean(relative_delta))
    p95_abs = float(np.percentile(np.abs(relative_delta), 95))

    assert mean_abs <= 3.40, f"mean |ΔL*| hồi quy: {mean_abs:.4f}"
    assert mean_signed >= -2.90, f"toàn corpus bị tối thêm: {mean_signed:.4f}"
    assert p95_abs <= 14.25, f"P95 |ΔL*| hồi quy: {p95_abs:.4f}"
    assert mean_abs < float(np.mean(np.abs(perceptual_delta)))

    tac_percent = actual_cmyk.astype(np.float64).sum(axis=1) / 255.0 * 100.0
    assert float(np.mean(tac_percent)) <= 147.0
    assert float(np.percentile(tac_percent, 95)) <= 250.5
    assert float(np.max(tac_percent)) <= 330.5



def test_vibrance_grid_has_exact_direction_and_safe_artifact_metrics(tmp_path):
    """Vibrance phải đúng hướng trên lưới màu và không đổi rực bằng cách phá proof."""
    cmyk_path, srgb_path = _profile_paths()
    levels = np.asarray([0, 32, 64, 96, 128, 160, 192, 224, 255], dtype=np.uint8)
    rgb = np.asarray(
        [(red, green, blue) for red in levels for green in levels for blue in levels],
        dtype=np.uint8,
    )
    source_image = Image.fromarray(rgb.reshape(1, -1, 3), "RGB")
    source_lab = _lab_d50(source_image, srgb_path, "RGB")
    source_chroma = np.hypot(source_lab[:, 1], source_lab[:, 2])
    chromatic_mask = source_chroma > 3.0
    source_path = tmp_path / "rgb-vibrance-grid.pdf"
    _build_rgb_image_pdf(source_path, rgb, width=len(rgb), height=1)

    lab_by_vibrance: dict[int, np.ndarray] = {}
    cmyk_by_vibrance: dict[int, np.ndarray] = {}
    tac_by_vibrance: dict[int, np.ndarray] = {}
    delta_e_by_vibrance: dict[int, np.ndarray] = {}
    for vibrance in (-20, 0, 20):
        output_path = tmp_path / f"cmyk-vibrance-{vibrance:+d}.pdf"
        result = pdf_actions_native.convert_to_cmyk(
            str(source_path),
            str(output_path),
            cmyk_path,
            srgb_path,
            rendering_intent="relative",
            black_point_compensation=True,
            preserve_black=True,
            vibrance_percent=vibrance,
            adjustment_stage="post_cmyk",
        )
        assert result["supported"] and result["images"] == 1, result
        assert result["postflight"]["passed"], result["postflight"]
        assert result["postflight"]["residuals"] == []

        with pikepdf.open(output_path) as pdf:
            image = pdf.pages[0].Resources.XObject.Im0
            assert str(image.ColorSpace) == "/DeviceCMYK"
            actual_cmyk = np.frombuffer(
                image.read_bytes(), dtype=np.uint8
            ).reshape(-1, 4)
            intents = list(pdf.Root.OutputIntents)
            assert len(intents) == 1
            embedded = bytes(intents[0].DestOutputProfile.read_bytes())

        assert hashlib.sha256(embedded).hexdigest() == FOGRA39_SHA256
        actual_lab = _lab_d50(
            Image.fromarray(actual_cmyk.reshape(1, -1, 4), "CMYK"),
            cmyk_path,
            "CMYK",
        )
        tac = actual_cmyk.astype(np.float64).sum(axis=1) / 255.0 * 100.0
        assert float(np.max(tac)) <= 330.5

        cmyk_by_vibrance[vibrance] = actual_cmyk
        lab_by_vibrance[vibrance] = actual_lab
        tac_by_vibrance[vibrance] = tac
        delta_e_by_vibrance[vibrance] = deltaE_ciede2000(
            source_lab, actual_lab
        )

    chroma_by_vibrance = {
        vibrance: np.hypot(lab[:, 1], lab[:, 2])
        for vibrance, lab in lab_by_vibrance.items()
    }
    assert float(
        np.min(
            chroma_by_vibrance[20][chromatic_mask]
            - chroma_by_vibrance[-20][chromatic_mask]
        )
    ) >= 0.0
    assert (
        float(np.mean(chroma_by_vibrance[-20][chromatic_mask]))
        < float(np.mean(chroma_by_vibrance[0][chromatic_mask]))
        < float(np.mean(chroma_by_vibrance[20][chromatic_mask]))
    )

    changed = np.any(cmyk_by_vibrance[20] != cmyk_by_vibrance[-20], axis=1)
    assert float(np.mean(changed[chromatic_mask])) >= 0.90
    assert float(np.mean(delta_e_by_vibrance[20])) <= (
        float(np.mean(delta_e_by_vibrance[0])) + 0.75
    )
    assert float(np.mean(tac_by_vibrance[20])) <= (
        float(np.mean(tac_by_vibrance[0])) + 1.50
    )

    paper_white_baseline = int(
        np.count_nonzero(
            (lab_by_vibrance[0][:, 0] >= 100.0)
            & (chroma_by_vibrance[0] <= 0.5)
        )
    )
    paper_white_vibrant = int(
        np.count_nonzero(
            (lab_by_vibrance[20][:, 0] >= 100.0)
            & (chroma_by_vibrance[20] <= 0.5)
        )
    )
    assert paper_white_vibrant <= paper_white_baseline
def test_vector_patch_artifact_matches_brightness_black_and_output_policy(tmp_path):
    """Numerics PDF thật phải đạt cùng gate, K-only và OutputIntent đúng hash."""
    cmyk_path, srgb_path = _profile_paths()
    source_path = tmp_path / "rgb-brightness-corpus.pdf"
    output_path = tmp_path / "cmyk-brightness-corpus.pdf"
    _build_patch_pdf(source_path)

    result = pdf_actions_native.convert_to_cmyk(
        str(source_path),
        str(output_path),
        cmyk_path,
        srgb_path,
        rendering_intent="relative",
        black_point_compensation=True,
        preserve_black=True,
    )

    assert result["supported"], result
    assert result["postflight"]["passed"], result["postflight"]
    assert result["postflight"]["residuals"] == []
    assert result["blockers"] == []
    assert not pdf_actions_native.has_rgb_content(str(output_path))

    with pikepdf.open(output_path) as pdf:
        instructions = list(pikepdf.parse_content_stream(pdf.pages[0]))
        cmyk_values = np.asarray(
            [
                [float(value) for value in instruction.operands]
                for instruction in instructions
                if str(instruction.operator) == "k"
            ],
            dtype=np.float64,
        )
        intents = list(pdf.Root.get("/OutputIntents") or [])
        assert len(intents) == 1
        output_profile = intents[0]["/DestOutputProfile"]
        assert int(output_profile["/N"]) == 4
        embedded = bytes(output_profile.read_bytes())

    assert len(cmyk_values) == len(PATCHES)
    assert hashlib.sha256(embedded).digest() == hashlib.sha256(
        Path(cmyk_path).read_bytes()
    ).digest()

    cmyk_bytes = np.rint(np.clip(cmyk_values, 0.0, 1.0) * 255.0).astype(np.uint8)
    source_process_rgb = np.asarray(
        [rgb for _name, rgb, _limit in PATCHES[:-1]], dtype=np.uint8
    )
    expected_process = _transform_image(
        Image.fromarray(source_process_rgb.reshape(1, -1, 3), "RGB"),
        srgb_path,
        cmyk_path,
        "RGB",
        "CMYK",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    expected_cmyk_bytes = np.asarray(expected_process, dtype=np.uint8).reshape(-1, 4)
    assert np.max(
        np.abs(cmyk_bytes[:-1].astype(np.int16) - expected_cmyk_bytes.astype(np.int16))
    ) <= 1

    # Text/vector RGB black thuộc policy preserve-black, không đi qua rich black ICC.
    assert cmyk_bytes[-1].tolist() == [0, 0, 0, 255]
    tac_percent = cmyk_bytes[:-1].sum(axis=1) / 255.0 * 100.0
    assert float(tac_percent.max()) <= 200.0

    cmyk_image = Image.fromarray(cmyk_bytes.reshape(1, -1, 4), "CMYK")
    proof = _transform_image(
        cmyk_image,
        cmyk_path,
        srgb_path,
        "CMYK",
        "RGB",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    proof_rgb = np.asarray(proof, dtype=np.uint8).reshape(-1, 3)
    source_rgb = np.asarray([rgb for _name, rgb, _limit in PATCHES], dtype=np.uint8)
    delta_l = _l_star(proof_rgb) - _l_star(source_rgb)

    for index, (name, _rgb, limit) in enumerate(PATCHES):
        if limit is not None:
            assert abs(float(delta_l[index])) <= limit, (
                f"{name} vượt gate sáng: ΔL*={delta_l[index]:.3f}, ngưỡng={limit}"
            )


@pytest.mark.parametrize(
    ("profile_name", "source_icc", "expected_hash", "limits"),
    [
        (
            "adobe-rgb-1998",
            ADOBE_RGB_1998_ICC,
            ADOBE_RGB_SHA256,
            {"de_mean": 7.8, "de_p95": 21.0, "de_max": 28.0, "dl_abs": 6.2, "dl_mean": -5.5, "dl_p95": 23.0, "dl_min": -31.0},
        ),
        (
            "display-p3",
            _display_p3_icc(),
            DISPLAY_P3_SHA256,
            {"de_mean": 7.7, "de_p95": 20.0, "de_max": 25.0, "dl_abs": 5.7, "dl_mean": -4.9, "dl_p95": 22.0, "dl_min": -28.0},
        ),
    ],
)
def test_embedded_wide_gamut_icc_is_used_end_to_end(
    tmp_path, profile_name, source_icc, expected_hash, limits
):
    """AdobeRGB/P3 nhúng phải đi đúng CMM, có gate ΔE00/ΔL*/TAC artifact."""
    assert hashlib.sha256(source_icc).hexdigest() == expected_hash
    cmyk_path, srgb_path = _profile_paths()
    levels = np.asarray([0, 32, 64, 96, 128, 160, 192, 224, 255], dtype=np.uint8)
    rgb = np.asarray(
        [(r, g, b) for r in levels for g in levels for b in levels]
        + [(60, 200, 100)],  # discriminator: Adobe/P3 khác sRGB ít nhất 23/255.
        dtype=np.uint8,
    )
    source_image = Image.fromarray(rgb.reshape(1, -1, 3), "RGB")
    source_path = tmp_path / f"{profile_name}-source.pdf"
    output_path = tmp_path / f"{profile_name}-fogra39.pdf"
    _build_rgb_image_pdf(
        source_path,
        rgb,
        width=len(rgb),
        height=1,
        source_icc=source_icc,
    )

    result = pdf_actions_native.convert_to_cmyk(
        str(source_path),
        str(output_path),
        cmyk_path,
        srgb_path,
        rendering_intent="relative",
        black_point_compensation=True,
        preserve_black=True,
    )
    assert result["supported"] and result["images"] == 1, result
    assert result["postflight"]["passed"] and not result["blockers"]

    with pikepdf.open(output_path) as pdf:
        image = pdf.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        actual_cmyk = np.frombuffer(image.read_bytes(), dtype=np.uint8).reshape(-1, 4)
        intents = list(pdf.Root.OutputIntents)
        assert len(intents) == 1
        assert hashlib.sha256(intents[0].DestOutputProfile.read_bytes()).hexdigest() == FOGRA39_SHA256

    expected_image = _transform_image(
        source_image,
        source_icc,
        cmyk_path,
        "RGB",
        "CMYK",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    expected_cmyk = np.asarray(expected_image, dtype=np.uint8).reshape(-1, 4)
    assert np.max(np.abs(actual_cmyk.astype(np.int16) - expected_cmyk.astype(np.int16))) <= 1

    # Chứng minh embedded profile thật sự được dùng, không chỉ output “trông hợp lệ”.
    wrong_srgb = _transform_image(
        source_image,
        srgb_path,
        cmyk_path,
        "RGB",
        "CMYK",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    wrong_discriminator = np.asarray(wrong_srgb, dtype=np.uint8).reshape(-1, 4)[-1]
    assert np.max(
        np.abs(actual_cmyk[-1].astype(np.int16) - wrong_discriminator.astype(np.int16))
    ) >= 20

    actual_image = Image.fromarray(actual_cmyk.reshape(1, -1, 4), "CMYK")
    source_lab = _lab_d50(source_image, source_icc, "RGB")
    output_lab = _lab_d50(actual_image, cmyk_path, "CMYK")
    delta_e = deltaE_ciede2000(source_lab, output_lab)
    delta_l = output_lab[:, 0] - source_lab[:, 0]

    assert float(np.mean(delta_e)) <= limits["de_mean"]
    assert float(np.percentile(delta_e, 95)) <= limits["de_p95"]
    assert float(np.max(delta_e)) <= limits["de_max"]
    assert float(np.mean(np.abs(delta_l))) <= limits["dl_abs"]
    assert float(np.mean(delta_l)) >= limits["dl_mean"]
    assert float(np.percentile(np.abs(delta_l), 95)) <= limits["dl_p95"]
    assert float(np.min(delta_l)) >= limits["dl_min"]
    tac_percent = actual_cmyk.astype(np.float64).sum(axis=1) / 255.0 * 100.0
    assert float(np.max(tac_percent)) <= 330.5


def test_calrgb_matrix_gamma_matches_adobe_rgb_oracle_end_to_end(tmp_path):
    """CalRGB phẳng phải dùng WhitePoint/Gamma/Matrix, không ép thành sRGB."""
    cmyk_path, srgb_path = _profile_paths()
    levels = np.asarray([0, 32, 64, 96, 128, 160, 192, 224, 255], dtype=np.uint8)
    rgb = np.asarray(
        [(r, g, b) for r in levels for g in levels for b in levels]
        + [(60, 200, 100)],
        dtype=np.uint8,
    )
    source_image = Image.fromarray(rgb.reshape(1, -1, 3), "RGB")
    source_path = tmp_path / "calrgb-adobe-like-source.pdf"
    output_path = tmp_path / "calrgb-adobe-like-fogra39.pdf"
    _build_adobe_like_calrgb_image_pdf(source_path, rgb)

    result = pdf_actions_native.convert_to_cmyk(
        str(source_path),
        str(output_path),
        cmyk_path,
        srgb_path,
        rendering_intent="relative",
        black_point_compensation=True,
        preserve_black=True,
    )
    assert result["supported"] and result["images"] == 1, result
    assert result["postflight"]["passed"] and not result["blockers"]

    with pikepdf.open(output_path) as pdf:
        image = pdf.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        actual_cmyk = np.frombuffer(image.read_bytes(), dtype=np.uint8).reshape(-1, 4)
        intents = list(pdf.Root.OutputIntents)
        assert len(intents) == 1
        assert hashlib.sha256(
            intents[0].DestOutputProfile.read_bytes()
        ).hexdigest() == FOGRA39_SHA256

    # Oracle không dùng helper CalRGB của production: profile Adobe RGB 1998
    # độc lập mô tả cùng primaries/gamma và đã được pin hash ở đầu file.
    expected = _transform_image(
        source_image,
        ADOBE_RGB_1998_ICC,
        cmyk_path,
        "RGB",
        "CMYK",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    expected_cmyk = np.asarray(expected, dtype=np.uint8).reshape(-1, 4)
    assert np.max(
        np.abs(actual_cmyk.astype(np.int16) - expected_cmyk.astype(np.int16))
    ) <= 1
    assert actual_cmyk[-1].tolist() == [222, 0, 217, 0]

    wrong = _transform_image(
        source_image,
        srgb_path,
        cmyk_path,
        "RGB",
        "CMYK",
        ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )
    wrong_cmyk = np.asarray(wrong, dtype=np.uint8).reshape(-1, 4)
    assert np.max(
        np.abs(actual_cmyk[-1].astype(np.int16) - wrong_cmyk[-1].astype(np.int16))
    ) >= 20

    source_lab = _lab_d50(source_image, ADOBE_RGB_1998_ICC, "RGB")
    output_lab = _lab_d50(
        Image.fromarray(actual_cmyk.reshape(1, -1, 4), "CMYK"),
        cmyk_path,
        "CMYK",
    )
    delta_e = deltaE_ciede2000(source_lab, output_lab)
    delta_l = output_lab[:, 0] - source_lab[:, 0]
    assert float(np.mean(delta_e)) <= 7.8
    assert float(np.percentile(delta_e, 95)) <= 21.0
    assert float(np.max(delta_e)) <= 28.0
    assert float(np.mean(np.abs(delta_l))) <= 6.2
    assert float(np.mean(delta_l)) >= -5.5
    assert float(np.percentile(np.abs(delta_l), 95)) <= 23.0
    assert float(np.min(delta_l)) >= -31.0
    tac_percent = actual_cmyk.astype(np.float64).sum(axis=1) / 255.0 * 100.0
    assert float(np.max(tac_percent)) <= 330.5


def test_default_rgb_scope_is_local_to_form_pattern_and_appearance(tmp_path):
    """Form, Pattern và AP phải dùng DefaultRGB của chính stream."""
    cmyk_path, srgb_path = _profile_paths()
    pdf = pikepdf.Pdf.new()
    profile = pdf.make_stream(ADOBE_RGB_1998_ICC)
    profile["/N"] = 3
    adobe = pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
    )
    own_resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(DefaultRGB=adobe)
    )
    color = b"0.23529412 0.78431373 0.39215686 rg 0 0 10 10 re f\n"
    form = pikepdf.Stream(
        pdf,
        color,
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Form"),
        BBox=[0, 0, 10, 10],
        Resources=own_resources,
    )
    pattern = pikepdf.Stream(
        pdf,
        color,
        Type=pikepdf.Name("/Pattern"),
        PatternType=1,
        PaintType=1,
        TilingType=1,
        BBox=[0, 0, 10, 10],
        XStep=10,
        YStep=10,
        Resources=own_resources,
    )
    appearance = pikepdf.Stream(
        pdf,
        color,
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Form"),
        BBox=[0, 0, 10, 10],
        Resources=own_resources,
    )
    page_resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form)),
        Pattern=pikepdf.Dictionary(P0=pdf.make_indirect(pattern)),
    )
    annotation = pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"),
        Subtype=pikepdf.Name("/Stamp"),
        Rect=[0, 0, 10, 10],
        AP=pikepdf.Dictionary(N=pdf.make_indirect(appearance)),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=page_resources,
        Annots=pikepdf.Array([pdf.make_indirect(annotation)]),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/Fm0 Do /P0 scn 20 20 10 10 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    source = tmp_path / "default-rgb-nested-scopes.pdf"
    output = tmp_path / "default-rgb-nested-scopes-output.pdf"
    pdf.save(source)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(
        str(source), str(output), cmyk_path, srgb_path
    )
    assert result["supported"], result
    expected = np.asarray([222, 0, 217, 0], dtype=np.int16)
    with pikepdf.open(output) as opened:
        streams = [
            opened.pages[0].Resources.XObject.Fm0,
            opened.pages[0].Resources.Pattern.P0,
            opened.pages[0].Annots[0].AP.N,
        ]
        for stream in streams:
            values = [
                float(value)
                for instruction in pikepdf.parse_content_stream(stream)
                if str(instruction.operator) == "k"
                for value in instruction.operands
            ]
            actual = np.rint(np.asarray(values) * 255.0).astype(np.int16)
            assert np.max(np.abs(actual - expected)) <= 1



def test_default_rgb_icc_applies_to_vector_and_image_in_resource_scope(tmp_path):
    """DeviceRGB phải lấy AdobeRGB từ DefaultRGB cho cả rg và image."""
    cmyk_path, srgb_path = _profile_paths()
    sample = np.asarray([(60, 200, 100)], dtype=np.uint8)
    pdf = pikepdf.Pdf.new()
    profile = pdf.make_stream(ADOBE_RGB_1998_ICC)
    profile["/N"] = 3
    default_rgb = pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
    )
    image = pikepdf.Stream(
        pdf,
        sample.tobytes(),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"),
    )
    resources = pikepdf.Dictionary(
        ColorSpace=pikepdf.Dictionary(DefaultRGB=default_rgb),
        XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image)),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=resources,
        Contents=pdf.make_indirect(
            pikepdf.Stream(
                pdf,
                b"0.23529412 0.78431373 0.39215686 rg "
                b"0 0 40 40 re f /Im0 Do\n",
            )
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    source = tmp_path / "default-rgb-adobe.pdf"
    output = tmp_path / "default-rgb-adobe-fogra39.pdf"
    pdf.save(source)
    pdf.close()

    result = pdf_actions_native.convert_to_cmyk(
        str(source),
        str(output),
        cmyk_path,
        srgb_path,
        rendering_intent="relative",
        black_point_compensation=True,
    )
    assert result["supported"] and result["images"] == 1, result
    assert result["postflight"]["passed"]

    expected = np.asarray(
        _transform_image(
            Image.fromarray(sample.reshape(1, 1, 3), "RGB"),
            ADOBE_RGB_1998_ICC,
            cmyk_path,
            "RGB",
            "CMYK",
            ImageCms.Intent.RELATIVE_COLORIMETRIC,
        ),
        dtype=np.uint8,
    ).reshape(4)
    with pikepdf.open(output) as opened:
        actual_image = np.frombuffer(
            opened.pages[0].Resources.XObject.Im0.read_bytes(),
            dtype=np.uint8,
        )
        instructions = list(pikepdf.parse_content_stream(opened.pages[0]))
        actual_vector = np.rint(
            np.asarray(
                [
                    float(value)
                    for instruction in instructions
                    if str(instruction.operator) == "k"
                    for value in instruction.operands
                ],
                dtype=np.float64,
            )
            * 255.0
        ).astype(np.uint8)
    assert np.max(np.abs(actual_image.astype(np.int16) - expected.astype(np.int16))) <= 1
    assert np.max(np.abs(actual_vector.astype(np.int16) - expected.astype(np.int16))) <= 1
    assert actual_image.tolist() == [222, 0, 217, 0]


def test_default_rgb_invalid_and_shared_image_scope_fail_closed(tmp_path):
    """DefaultRGB sai hoặc một image dùng hai profile phải dừng trước write."""
    cmyk_path, srgb_path = _profile_paths()

    invalid_pdf = pikepdf.Pdf.new()
    invalid_page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(
                DefaultRGB=pikepdf.Array(
                    [
                        pikepdf.Name("/Lab"),
                        pikepdf.Dictionary(WhitePoint=[0.9505, 1.0, 1.089]),
                    ]
                )
            )
        ),
        Contents=invalid_pdf.make_indirect(
            pikepdf.Stream(invalid_pdf, b"0.2 0.4 0.8 rg 0 0 40 40 re f\n")
        ),
    )
    invalid_pdf.pages.append(
        pikepdf.Page(invalid_pdf.make_indirect(invalid_page))
    )
    invalid_source = tmp_path / "invalid-default-rgb.pdf"
    invalid_output = tmp_path / "invalid-default-rgb-output.pdf"
    invalid_pdf.save(invalid_source)
    invalid_pdf.close()

    invalid = pdf_actions_native.convert_to_cmyk(
        str(invalid_source), str(invalid_output), cmyk_path, srgb_path
    )
    assert not invalid["supported"], invalid
    assert any("DEFAULT_RGB" in blocker for blocker in invalid["blockers"])
    assert not invalid_output.exists()

    shared_pdf = pikepdf.Pdf.new()
    shared_image = shared_pdf.make_indirect(
        pikepdf.Stream(
            shared_pdf,
            bytes([60, 200, 100]),
            Type=pikepdf.Name("/XObject"),
            Subtype=pikepdf.Name("/Image"),
            Width=1,
            Height=1,
            BitsPerComponent=8,
            ColorSpace=pikepdf.Name("/DeviceRGB"),
        )
    )
    adobe_profile = shared_pdf.make_stream(ADOBE_RGB_1998_ICC)
    adobe_profile["/N"] = 3
    adobe = shared_pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), adobe_profile])
    )
    for index, default_rgb in enumerate((pikepdf.Name("/DeviceRGB"), adobe)):
        resources = pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(DefaultRGB=default_rgb),
            XObject=pikepdf.Dictionary(Im0=shared_image),
        )
        page = pikepdf.Dictionary(
            Type=pikepdf.Name("/Page"),
            MediaBox=[0, 0, 100, 100],
            Resources=resources,
            Contents=shared_pdf.make_indirect(
                pikepdf.Stream(shared_pdf, b"/Im0 Do\n")
            ),
        )
        shared_pdf.pages.append(pikepdf.Page(shared_pdf.make_indirect(page)))
    shared_source = tmp_path / "shared-default-rgb.pdf"
    shared_output = tmp_path / "shared-default-rgb-output.pdf"
    shared_pdf.save(shared_source)
    shared_pdf.close()

    shared = pdf_actions_native.convert_to_cmyk(
        str(shared_source), str(shared_output), cmyk_path, srgb_path
    )
    assert not shared["supported"], shared
    assert any(
        "DEFAULT_RGB_SHARED_SCOPE_CONFLICT" in blocker
        for blocker in shared["blockers"]
    )
    assert not shared_output.exists()



@pytest.mark.parametrize(
    ("profile_name", "source_icc"),
    [
        ("adobe-rgb-1998", ADOBE_RGB_1998_ICC),
        ("display-p3", _display_p3_icc()),
    ],
)
def test_wide_gamut_icc_alpha_flattens_in_device_rgb_before_cmyk(
    tmp_path, profile_name, source_icc
):
    """Alpha wide-gamut phải blend trong DeviceRGB, không blend raw ICC bytes.

    Nếu composite trực tiếp trong AdobeRGB/P3 rồi mới đổi profile, mép alpha
    sẽ lệch sáng rõ rệt. Oracle dưới đây khóa đúng thứ tự mà PDF transparency
    yêu cầu: source ICC → sRGB blend space → giấy trắng → FOGRA39.
    """
    cmyk_path, srgb_path = _profile_paths()
    source_rgb = np.asarray([(60, 200, 100), (230, 40, 210)], dtype=np.uint8)
    alpha = np.asarray([128, 192], dtype=np.uint8)
    source_path = tmp_path / f"{profile_name}-alpha-source.pdf"
    output_path = tmp_path / f"{profile_name}-alpha-cmyk.pdf"
    _build_rgb_alpha_image_pdf(source_path, source_rgb, alpha, source_icc)

    result = pdf_actions_native.convert_to_cmyk(
        str(source_path),
        str(output_path),
        cmyk_path,
        srgb_path,
        rendering_intent="relative",
        black_point_compensation=True,
        preserve_black=True,
    )
    assert result["supported"] and result["flattened_images"] == 1, result
    assert result["images"] == 1 and not result["blockers"], result
    assert result["postflight"]["passed"]
    assert result["postflight"]["residuals"] == []

    source_image = Image.fromarray(source_rgb.reshape(1, -1, 3), "RGB")
    source_handle = ImageCms.getOpenProfile(BytesIO(source_icc))
    blend_handle = ImageCms.getOpenProfile(srgb_path)
    to_blend = ImageCms.buildTransform(
        source_handle,
        blend_handle,
        "RGB",
        "RGB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        flags=pdf_actions_native._CMS_FLAGS(black_point_compensation=True),
    )
    blend_rgb = ImageCms.applyTransform(source_image, to_blend).convert("RGB")
    expected_rgb = Image.composite(
        blend_rgb,
        Image.new("RGB", source_image.size, (255, 255, 255)),
        Image.fromarray(alpha.reshape(1, -1), "L"),
    )
    expected_cmyk = pdf_actions_native._CmykTransform(
        srgb_path,
        cmyk_path,
        rendering_intent="relative",
        black_point_compensation=True,
    ).image(expected_rgb).tobytes()

    with pikepdf.open(output_path) as pdf:
        image = pdf.pages[0].Resources.XObject.Im0
        assert str(image.ColorSpace) == "/DeviceCMYK"
        assert image.get("/SMask") is None
        actual_cmyk = bytes(image.read_bytes())
        intents = list(pdf.Root.get("/OutputIntents") or [])
        assert len(intents) == 1
        assert int(intents[0]["/DestOutputProfile"]["/N"]) == 4
        assert hashlib.sha256(
            bytes(intents[0]["/DestOutputProfile"].read_bytes())
        ).hexdigest() == FOGRA39_SHA256

    assert actual_cmyk == expected_cmyk
    assert max(actual_cmyk) <= 255
    assert max(
        sum(actual_cmyk[offset : offset + 4]) / 255.0 * 100.0
        for offset in range(0, len(actual_cmyk), 4)
    ) <= 330.5

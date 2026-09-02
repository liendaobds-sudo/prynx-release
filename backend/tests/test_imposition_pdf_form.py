"""Artifact test cho raw PDF Form của nesting góc tự do."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pytest

from app.core.nesting_source_pin import _inspect_pdf
from app.workers.imposition_affine import (
    Affine2D,
    PoseMm,
    compose_render_ctm_mm,
    rigid_pose_affine_mm,
)
from app.workers.imposition_pdf_form import (
    MM_PER_PT,
    PT_PER_MM,
    ManifestPageBinding,
    ManifestPdfFormError,
    embed_manifest_page_form,
    paint_manifest_page_form,
)
from app.workers.nup_artwork import (
    ManifestArtworkContractError,
    manifest_artwork_render_ctm_mm,
    resolve_manifest_artwork_placement,
)
from app.workers.nup_clip_shape import (
    build_manifest_clip_rings,
    transform_manifest_polygon_rings,
)


MEDIA_RAW = (10.0, 20.0, 110.0, 80.0)
OUTPUT_MM = 300.0
OUTPUT_ORIGIN = (5.0, 7.0)
RENDER_BUNDLE_HASH = "sha256:" + "b" * 64
LOCATOR_ID = "11111111-1111-4111-8111-111111111111"
MARKERS = {
    "red": (22.0, 32.0),
    "green": (98.0, 32.0),
    "blue": (22.0, 68.0),
}


def _source_revision(path: Path) -> str:
    """Revision đúng contract: hash byte của snapshot source hiện tại."""

    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _source_pdf(path: Path, *, rotate: int, user_unit: float, full_black=False) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100.0, 60.0))
    page.obj["/MediaBox"] = pikepdf.Array(MEDIA_RAW)
    page.obj["/CropBox"] = pikepdf.Array([12.0, 22.0, 108.0, 78.0])
    page.obj["/TrimBox"] = pikepdf.Array([15.0, 25.0, 105.0, 75.0])
    page.obj["/Rotate"] = rotate
    page.obj["/UserUnit"] = user_unit

    ocg = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name="Artwork Layer")
    )
    pdf.Root["/OCProperties"] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([ocg]),
        D=pikepdf.Dictionary(
            Order=pikepdf.Array([ocg]), ON=pikepdf.Array([ocg]), OFF=pikepdf.Array([])
        ),
    )
    tint = pdf.make_indirect(
        pikepdf.Dictionary(
            FunctionType=2,
            Domain=pikepdf.Array([0, 1]),
            C0=pikepdf.Array([0, 0, 0, 0]),
            C1=pikepdf.Array([0, 1, 0, 0]),
            N=1,
        )
    )
    page.obj["/Resources"] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(
            F1=pikepdf.Dictionary(
                Type=pikepdf.Name.Font,
                Subtype=pikepdf.Name.Type1,
                BaseFont=pikepdf.Name.Helvetica,
            )
        ),
        ExtGState=pikepdf.Dictionary(
            GS1=pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, ca=0.5, CA=0.5)
        ),
        ColorSpace=pikepdf.Dictionary(
            Spot=pikepdf.Array(
                [pikepdf.Name.Separation, pikepdf.Name("/PANTONE_Test"), pikepdf.Name.DeviceCMYK, tint]
            )
        ),
        Properties=pikepdf.Dictionary(Layer=ocg),
    )
    if full_black:
        content = "0 0 0 rg 10 20 100 60 re f\n"
    else:
        content = (
            "/OC /Layer BDC\n"
            "1 0 0 rg 18 28 8 8 re f\n"
            "0 0.8 0 rg 94 28 8 8 re f\n"
            "0 0 1 rg 18 64 8 8 re f\n"
            "EMC\n"
            "q /GS1 gs /Spot cs 0.5 scn 50 45 8 8 re f Q\n"
            "0 0 0 rg BT /F1 8 Tf 55 55 Td (V) Tj ET\n"
        )
    page.obj["/Contents"] = pikepdf.Stream(pdf, content.encode("ascii"))
    pdf.save(path)
    pdf.close()


def _binding(path: Path) -> ManifestPageBinding:
    metadata = _inspect_pdf(path)[0].to_binding_metadata()
    metadata["sourceReferencePointMm"] = [0.0, 0.0]
    return ManifestPageBinding.from_mapping(metadata)


def _output_pdf(*, user_unit: float = 1.0):
    pdf = pikepdf.Pdf.new()
    side_points = OUTPUT_MM * PT_PER_MM / user_unit
    page = pdf.add_blank_page(page_size=(side_points, side_points))
    page.obj["/MediaBox"] = pikepdf.Array(
        [
            OUTPUT_ORIGIN[0],
            OUTPUT_ORIGIN[1],
            OUTPUT_ORIGIN[0] + side_points,
            OUTPUT_ORIGIN[1] + side_points,
        ]
    )
    page.obj["/UserUnit"] = user_unit
    return pdf, page


def _render_rgb(path: Path, scale=2.0):
    document = pdfium.PdfDocument(path)
    try:
        bitmap = document[0].render(scale=scale)
        return np.asarray(bitmap.to_pil().convert("RGB")), scale
    finally:
        document.close()


def _centroid(array: np.ndarray, color: str) -> tuple[float, float]:
    red = array[:, :, 0]
    green = array[:, :, 1]
    blue = array[:, :, 2]
    if color == "red":
        mask = (red > 150) & (green < 50) & (blue < 50)
    elif color == "green":
        mask = (green > 120) & (red < 50) & (blue < 50)
    else:
        mask = (blue > 150) & (red < 50) & (green < 50)
    y, x = np.nonzero(mask)
    assert len(x) > 10, f"không tìm thấy landmark {color}"
    return float(x.mean()), float(y.mean())


def _all_sheet_clip():
    return (((0.0, 0.0), (OUTPUT_MM, 0.0), (OUTPUT_MM, OUTPUT_MM), (0.0, OUTPUT_MM)),)


@pytest.mark.parametrize(
    "angle,rotate,user_unit",
    [
        *((17.0, rotate, unit) for rotate in (0, 90, 180, 270) for unit in (1.0, 2.0)),
        (123.456, 0, 1.0),
        (359.999, 270, 2.0),
    ],
)
def test_raw_form_landmark_arbitrary_angle_rotate_userunit(
    tmp_path: Path, angle: float, rotate: int, user_unit: float
) -> None:
    """Artifact thật giữ landmark ở góc lẻ, origin lẻ, Rotate và UserUnit."""

    source_path = tmp_path / f"source-{angle}-{rotate}-{user_unit}.pdf"
    output_path = tmp_path / "output.pdf"
    _source_pdf(source_path, rotate=rotate, user_unit=user_unit)
    binding = _binding(source_path)
    output, page = _output_pdf()
    pose = PoseMm(angle, 140.0, 130.0)
    reference = (20.0, 12.0)
    ctm = compose_render_ctm_mm(
        sheet_frame=Affine2D(1, 0, 0, 1, 0, 0),
        pose=pose,
        reference_point_mm=reference,
        source_page_to_canonical=binding.source_page_to_canonical,
    )
    painted = paint_manifest_page_form(
        output,
        page,
        source_path=source_path,
        locator_id=LOCATOR_ID,
        source_revision=_source_revision(source_path),
        binding=binding,
        form_variant="artwork-raw",
        render_ctm_mm=ctm,
        clip_rings_output_mm=_all_sheet_clip(),
    )
    assert painted.matrix_pdf.determinant == pytest.approx(user_unit**2)
    assert math.hypot(painted.matrix_pdf.a, painted.matrix_pdf.b) == pytest.approx(user_unit)
    assert math.hypot(painted.matrix_pdf.c, painted.matrix_pdf.d) == pytest.approx(user_unit)
    output.save(output_path)
    output.close()

    image, scale = _render_rgb(output_path)
    geometry = rigid_pose_affine_mm(pose, reference)
    for color, raw_point in MARKERS.items():
        physical = (raw_point[0] * user_unit * MM_PER_PT, raw_point[1] * user_unit * MM_PER_PT)
        canonical = binding.source_page_to_canonical.apply(physical)
        expected_mm = geometry.apply(canonical)
        expected_pixel = (
            expected_mm[0] * PT_PER_MM * scale,
            (OUTPUT_MM - expected_mm[1]) * PT_PER_MM * scale,
        )
        actual = _centroid(image, color)
        assert actual == pytest.approx(expected_pixel, abs=2.5)


def test_embed_once_variant_resource_ocg_va_source_bat_bien(tmp_path: Path) -> None:
    source_path = tmp_path / "resources.pdf"
    _source_pdf(source_path, rotate=90, user_unit=2.0)
    source_bytes = source_path.read_bytes()
    binding = _binding(source_path)
    source_revision = _source_revision(source_path)
    output_path = tmp_path / "resources-output.pdf"
    output, page = _output_pdf()
    ctm = Affine2D(0, -1, 1, 0, 50, 50)

    first = paint_manifest_page_form(
        output, page, source_path=source_path,
        locator_id=LOCATOR_ID, source_revision=source_revision,
        binding=binding, form_variant="artwork-raw", render_ctm_mm=ctm,
        clip_rings_output_mm=_all_sheet_clip(),
    )
    second = paint_manifest_page_form(
        output, page, source_path=source_path,
        locator_id=LOCATOR_ID, source_revision=source_revision,
        binding=binding, form_variant="artwork-raw", render_ctm_mm=ctm,
        clip_rings_output_mm=_all_sheet_clip(),
    )
    with pytest.raises(ManifestPdfFormError, match="formVariant"):
        paint_manifest_page_form(
            output, page, source_path=source_path,
            locator_id=LOCATOR_ID, source_revision=source_revision,
            binding=binding, form_variant="artwork-without-cut", render_ctm_mm=ctm,
            clip_rings_output_mm=_all_sheet_clip(),
        )
    assert first.cache_key == second.cache_key
    xobjects = page.obj["/Resources"]["/XObject"]
    assert len(xobjects) == 1
    for _name, form in xobjects.items():
        assert form.get("/Matrix") is None
        assert tuple(float(value) for value in form["/BBox"]) == MEDIA_RAW
        resources = form["/Resources"]
        assert {"/Font", "/ExtGState", "/ColorSpace", "/Properties"}.issubset(resources.keys())
    ocgs = output.Root["/OCProperties"]["/OCGs"]
    assert len(ocgs) == 1  # Các placement dùng chung OCG của raw Form đã nhúng.
    streams = page.obj["/Contents"]
    streams = streams if isinstance(streams, pikepdf.Array) else [streams]
    content = b"".join(stream.read_bytes() for stream in streams)
    assert content.count(b" Do") == 2
    output.save(output_path)
    output.close()
    with pikepdf.Pdf.open(output_path) as reopened:
        reopened_page = reopened.pages[0]
        reopened_xobjects = reopened_page.obj["/Resources"]["/XObject"]
        assert len(reopened_xobjects) == 1
        reopened_streams = reopened_page.obj["/Contents"]
        reopened_streams = (
            reopened_streams
            if isinstance(reopened_streams, pikepdf.Array)
            else [reopened_streams]
        )
        reopened_content = b"".join(stream.read_bytes() for stream in reopened_streams)
        assert reopened_content.count(b" Do") == 2
        assert len(reopened.Root["/OCProperties"]["/OCGs"]) == 1
    assert source_path.read_bytes() == source_bytes


def test_form_fail_closed_khi_page_matrix_ngoai_contract(tmp_path: Path) -> None:
    source_path = tmp_path / "matrix.pdf"
    _source_pdf(source_path, rotate=0, user_unit=1.0)
    binding = _binding(source_path)
    mutated_path = tmp_path / "matrix-mutated.pdf"
    with pikepdf.Pdf.open(source_path) as source:
        source.pages[0].obj["/Matrix"] = pikepdf.Array([1, 0, 0, 1, 2, 3])
        source.save(mutated_path)
    mutated_path.replace(source_path)
    output, _page = _output_pdf()
    with pytest.raises(ManifestPdfFormError, match="ngoài hợp đồng"):
        embed_manifest_page_form(
            output,
            source_path=source_path,
            locator_id=LOCATOR_ID,
            source_revision=_source_revision(source_path),
            binding=binding,
            form_variant="artwork-raw",
        )
    output.close()


def test_form_fail_closed_khi_source_revision_khong_khop(tmp_path: Path) -> None:
    source_path = tmp_path / "stale-source.pdf"
    _source_pdf(source_path, rotate=0, user_unit=1.0)
    binding = _binding(source_path)
    pinned_revision = _source_revision(source_path)
    source_path.write_bytes(source_path.read_bytes() + b"\n% source changed after pin\n")
    output, _page = _output_pdf()
    with pytest.raises(ManifestPdfFormError, match="sourceRevision"):
        embed_manifest_page_form(
            output,
            source_path=source_path,
            locator_id=LOCATOR_ID,
            source_revision=pinned_revision,
            binding=binding,
            form_variant="artwork-raw",
        )
    assert "/XObject" not in (output.pages[0].obj.get("/Resources") or {})
    output.close()


def test_manifest_artwork_seam_khoa_revision_va_ctm(tmp_path: Path) -> None:
    source_path = tmp_path / "manifest.pdf"
    _source_pdf(source_path, rotate=270, user_unit=2.0)
    metadata = _inspect_pdf(source_path)[0].to_binding_metadata()
    metadata["sourceReferencePointMm"] = [10.0, 5.0]
    source_revision = _source_revision(source_path)
    polygon = {"outer": [[0, 0], [40, 0], [40, 20], [0, 20]], "holes": []}
    part = {
        "partId": "part-a",
        "referencePointMm": [20.0, 10.0],
        "geometryHash": "sha256:" + "c" * 64,
        "packingFootprint": polygon,
        "cutContour": polygon,
        "artworkClipPath": polygon,
        "source": {
            "locatorId": LOCATOR_ID,
            "contentHash": source_revision,
            "byteSize": source_path.stat().st_size,
            "pageCount": 1,
            "revision": source_revision,
        },
        "pages": {"front": metadata, "back": metadata, "cut": metadata},
    }
    placement = {
        "instanceId": "part-a#0001",
        "partId": "part-a",
        "sheetIndex": 0,
        "pose": {"rotationDeg": 123.456, "translateXmm": 80.0, "translateYmm": 90.0},
        "sourceRevision": RENDER_BUNDLE_HASH,
    }
    resolved = resolve_manifest_artwork_placement(
        placement=placement,
        part=part,
        sheet_frame=[-1, 0, 0, 1, OUTPUT_MM, 0],
        side="back",
        render_bundle_hash=RENDER_BUNDLE_HASH,
    )
    ctm = manifest_artwork_render_ctm_mm(resolved)
    assert ctm.determinant == pytest.approx(-1.0)
    placement["sourceRevision"] = "sha256:" + "d" * 64
    with pytest.raises(ManifestArtworkContractError, match="renderBundleHash"):
        resolve_manifest_artwork_placement(
            placement=placement,
            part=part,
            sheet_frame=[1, 0, 0, 1, 0, 0],
            side="front",
            render_bundle_hash=RENDER_BUNDLE_HASH,
        )


@pytest.mark.parametrize(
    "sheet_frame,expected_sign",
    [
        ([1, 0, 0, 1, 0, 0], 1),
        ([-1, 0, 0, 1, OUTPUT_MM, 0], -1),
    ],
)
def test_clip_va_form_cung_sheetframe_g(sheet_frame, expected_sign) -> None:
    pose = PoseMm(17.0, 80.0, 90.0)
    reference = (5.0, 7.0)
    polygon = {
        "outer": [[0, 0], [20, 0], [20, 10], [0, 10]],
        "holes": [[[5, 3], [5, 7], [15, 7], [15, 3]]],
    }
    frame = Affine2D.from_sequence(sheet_frame)
    clip = build_manifest_clip_rings(
        polygon,
        sheet_frame=frame,
        pose=pose,
        reference_point_mm=reference,
    )
    ctm = compose_render_ctm_mm(
        sheet_frame=frame,
        pose=pose,
        reference_point_mm=reference,
        source_page_to_canonical=Affine2D(1, 0, 0, 1, 0, 0),
    )
    assert ctm.determinant == pytest.approx(float(expected_sign))
    assert clip[0][0] == pytest.approx(ctm.apply((0.0, 0.0)))
    # NESTING (audit 2026-08-28 §A1c): artwork clip chỉ mang vòng ngoài; lỗ đi
    # lớp CUT. Trước đây test này đọc clip[1] (vòng lỗ) để kiểm phép biến đổi,
    # nên kiểm luôn cả transform giữ lỗ để không mất độ phủ đó.
    assert len(clip) == 1
    cut_rings = transform_manifest_polygon_rings(
        polygon,
        sheet_frame=frame,
        pose=pose,
        reference_point_mm=reference,
    )
    assert len(cut_rings) == 2
    assert cut_rings[0] == clip[0]
    assert cut_rings[1][2] == pytest.approx(ctm.apply((15.0, 7.0)))

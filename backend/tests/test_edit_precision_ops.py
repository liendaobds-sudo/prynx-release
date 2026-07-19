from __future__ import annotations

import base64
import io
import os
import tempfile

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from app.core import edit_session as edit_session_core
from app.core.edit_session import _apply_op_to_pdf, _bbox_after_matrix
from app.core.geometry_reader import list_objects
from app.core.stream_editor import _build_image_xobject, _ensure_xobject_resource, add_image
from app.schemas.edit import EditOp


def _make_two_vector_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))
    page.Contents = pdf.make_stream(
        b"""
q
1 0 0 rg
20 20 30 30 re
f
Q
q
0 0 1 rg
100 100 20 20 re
f
Q
"""
    )
    pdf.save(path)
    pdf.close()


def test_edit_op_rejects_degenerate_affine():
    with pytest.raises(ValidationError):
        EditOp.model_validate({
            "page": 0,
            "kind": "affine",
            "targetIds": ["vector-0"],
            "affine": [1, 0, 0, 0, 0, 0],
        })


def test_bbox_after_affine_uses_all_four_corners():
    bbox = _bbox_after_matrix([10, 20, 30, 40], [0, 1, -1, 0, 100, 0])
    assert bbox == pytest.approx([60, 10, 80, 30])



def test_affine_scales_vector_about_page_space_anchor():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "vectors.pdf")
        out = os.path.join(td, "scaled.pdf")
        _make_two_vector_pdf(src)
        before = [obj for obj in list_objects(src, 0) if obj.type == "vector"]
        target = before[0]
        op = EditOp.model_validate({
            "page": 0,
            "kind": "affine",
            "targetIds": [target.id],
            "affine": [2, 0, 0, 2, -target.bbox[0], -target.bbox[1]],
        })

        with pikepdf.open(src) as pdf:
            _apply_op_to_pdf(pdf, op, {obj.id: obj for obj in before})
            pdf.save(out)

        after = [obj for obj in list_objects(out, 0) if obj.type == "vector"]
        transformed = {obj.drawIndex: obj for obj in after}[target.drawIndex]
        assert transformed.bbox[2] - transformed.bbox[0] == pytest.approx(
            2 * (target.bbox[2] - target.bbox[0]), abs=2.0
        )
        assert transformed.bbox[3] - transformed.bbox[1] == pytest.approx(
            2 * (target.bbox[3] - target.bbox[1]), abs=2.0
        )

def _solid_png(color: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(buffer, format="PNG")
    return buffer.getvalue()


def test_replace_image_preserves_bbox_and_changes_pixels():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "image.pdf")
        out = os.path.join(td, "replaced.pdf")

        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        add_image(page, _solid_png((240, 20, 20)), [50, 50, 150, 150], pdf)
        pdf.save(src)
        pdf.close()

        before = [obj for obj in list_objects(src, 0) if obj.type == "image"]
        assert len(before) == 1
        target = before[0]
        replacement = base64.b64encode(_solid_png((20, 40, 240))).decode("ascii")
        op = EditOp.model_validate({
            "page": 0,
            "kind": "replaceImage",
            "targetIds": [target.id],
            "image": {"dataRef": "data:image/png;base64," + replacement},
        })

        with pikepdf.open(src) as doc:
            result = _apply_op_to_pdf(doc, op, {target.id: target})
            assert result.bbox == pytest.approx(target.bbox)
            doc.save(out)

        after = [obj for obj in list_objects(out, 0) if obj.type == "image"]
        assert len(after) == 1
        assert after[0].bbox == pytest.approx(target.bbox, abs=1.0)

        render_doc = pdfium.PdfDocument(out)
        try:
            rendered = render_doc[0].render(scale=1).to_pil().convert("RGB")
        finally:
            render_doc.close()
        red, green, blue = rendered.getpixel((100, 200))
        assert blue > 200
        assert red < 80
        assert green < 100


def _masked_circle_png() -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((4, 4, 60, 60), fill=(240, 20, 20, 255))
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_replace_image_preserves_original_soft_mask():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "masked-image.pdf")
        out = os.path.join(td, "masked-image-replaced.pdf")

        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        add_image(page, _masked_circle_png(), [50, 50, 150, 150], pdf)
        pdf.save(src)
        pdf.close()

        target = [obj for obj in list_objects(src, 0) if obj.type == "image"][0]
        replacement = base64.b64encode(_solid_png((20, 40, 240))).decode("ascii")
        op = EditOp.model_validate({
            "page": 0,
            "kind": "replaceImage",
            "targetIds": [target.id],
            "image": {"dataRef": "data:image/png;base64," + replacement},
        })

        with pikepdf.open(src) as doc:
            result = _apply_op_to_pdf(doc, op, {target.id: target})
            resources = doc.pages[0].obj["/Resources"]["/XObject"]
            replaced = resources[pikepdf.Name("/" + result.new_resource_name)]
            assert "/SMask" in replaced
            assert int(replaced["/Width"]) == 64
            assert int(replaced["/Height"]) == 64
            doc.save(out)

        render_doc = pdfium.PdfDocument(out)
        try:
            rendered = render_doc[0].render(scale=2).to_pil().convert("RGB")
        finally:
            render_doc.close()
        center = rendered.getpixel((200, 400))
        clipped_corner = rendered.getpixel((108, 308))
        assert center[2] > 200 and center[0] < 80
        assert min(clipped_corner) > 240


def test_replace_image_preserves_page_clipping_path():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "path-clipped-image.pdf")
        out = os.path.join(td, "path-clipped-image-replaced.pdf")

        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        xobj, _, _ = _build_image_xobject(pdf, _solid_png((240, 20, 20)))
        name = _ensure_xobject_resource(page, xobj, "ClipImage")
        page.Contents = pdf.make_stream(
            (
                "q\n"
                "50 50 m 150 50 l 100 150 l h W n\n"
                f"100 0 0 100 50 50 cm /{name} Do\n"
                "Q\n"
            ).encode("ascii")
        )
        pdf.save(src)
        pdf.close()

        target = [obj for obj in list_objects(src, 0) if obj.type == "image"][0]
        replacement = base64.b64encode(_solid_png((20, 40, 240))).decode("ascii")
        op = EditOp.model_validate({
            "page": 0,
            "kind": "replaceImage",
            "targetIds": [target.id],
            "image": {"dataRef": "data:image/png;base64," + replacement},
        })
        with pikepdf.open(src) as doc:
            _apply_op_to_pdf(doc, op, {target.id: target})
            doc.save(out)

        render_doc = pdfium.PdfDocument(out)
        try:
            rendered = render_doc[0].render(scale=2).to_pil().convert("RGB")
        finally:
            render_doc.close()
        inside_triangle = rendered.getpixel((200, 400))
        outside_triangle = rendered.getpixel((112, 312))
        assert inside_triangle[2] > 200 and inside_triangle[0] < 80
        assert min(outside_triangle) > 240

def _render_rgb(path: str, scale: float = 1.0) -> Image.Image:
    render_doc = pdfium.PdfDocument(path)
    try:
        return render_doc[0].render(scale=scale).to_pil().convert("RGB")
    finally:
        render_doc.close()


def _make_image_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))
    add_image(page, _solid_png((240, 20, 20)), [50, 50, 150, 150], pdf)
    pdf.save(path)
    pdf.close()


@pytest.mark.parametrize(
    "shape",
    [
        "rectangle",
        "rounded",
        "circle",
        "ellipse",
        "triangle",
        "diamond",
        "pentagon",
        "hexagon",
        "octagon",
        "star",
        "heart",
        "cross",
    ],
)
def test_clip_image_supports_all_frame_shapes(shape: str):
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "frame-source.pdf")
        _make_image_pdf(src)
        target = [obj for obj in list_objects(src, 0) if obj.type == "image"][0]
        op = EditOp.model_validate({
            "page": 0,
            "kind": "clipImage",
            "targetIds": [target.id],
            "clip": {"shape": shape, "radius": 0.16},
        })

        with pikepdf.open(src) as doc:
            _apply_op_to_pdf(doc, op, {target.id: target})
            instructions = list(pikepdf.parse_content_stream(doc.pages[0]))

        assert sum(
            str(instr.operator) in {"BMC", "BDC"}
            and instr.operands
            and str(instr.operands[0]) == "/PrynXImageClip"
            for instr in instructions
        ) == 1
        assert sum(str(instr.operator) == "W" for instr in instructions) == 1
        assert sum(str(instr.operator) == "Do" for instr in instructions) == 1

def test_clip_image_switches_shape_without_stacking():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "frame-source.pdf")
        out = os.path.join(td, "frame-triangle.pdf")
        _make_image_pdf(src)
        target = [obj for obj in list_objects(src, 0) if obj.type == "image"][0]

        circle = EditOp.model_validate({
            "page": 0,
            "kind": "clipImage",
            "targetIds": [target.id],
            "clip": {"shape": "circle"},
        })
        triangle = EditOp.model_validate({
            "page": 0,
            "kind": "clipImage",
            "targetIds": [target.id],
            "clip": {"shape": "triangle"},
        })
        with pikepdf.open(src) as doc:
            _apply_op_to_pdf(doc, circle, {target.id: target})
            _apply_op_to_pdf(doc, triangle, {target.id: target})
            instructions = list(pikepdf.parse_content_stream(doc.pages[0]))
            markers = [
                instr for instr in instructions
                if str(instr.operator) in {"BMC", "BDC"}
                and instr.operands
                and str(instr.operands[0]) == "/PrynXImageClip"
            ]
            assert len(markers) == 1
            assert sum(str(instr.operator) == "W" for instr in instructions) == 1
            doc.save(out)

        rendered = _render_rgb(out)
        inside = rendered.getpixel((100, 200))
        outside = rendered.getpixel((55, 155))
        assert inside[0] > 200 and inside[2] < 80
        assert min(outside) > 240


def test_clip_image_moves_with_image_preserves_replace_and_can_remove():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "frame-source.pdf")
        framed = os.path.join(td, "frame-circle.pdf")
        moved = os.path.join(td, "frame-moved.pdf")
        unframed = os.path.join(td, "frame-removed.pdf")
        _make_image_pdf(src)
        target = [obj for obj in list_objects(src, 0) if obj.type == "image"][0]

        circle = EditOp.model_validate({
            "page": 0,
            "kind": "clipImage",
            "targetIds": [target.id],
            "clip": {"shape": "circle"},
        })
        with pikepdf.open(src) as doc:
            _apply_op_to_pdf(doc, circle, {target.id: target})
            doc.save(framed)

        framed_target = [obj for obj in list_objects(framed, 0) if obj.type == "image"][0]
        replacement = base64.b64encode(_solid_png((20, 40, 240))).decode("ascii")
        replace_op = EditOp.model_validate({
            "page": 0,
            "kind": "replaceImage",
            "targetIds": [framed_target.id],
            "image": {"dataRef": "data:image/png;base64," + replacement},
        })
        move_op = EditOp.model_validate({
            "page": 0,
            "kind": "affine",
            "targetIds": [framed_target.id],
            "affine": [1, 0, 0, 1, 80, 0],
        })
        with pikepdf.open(framed) as doc:
            _apply_op_to_pdf(doc, replace_op, {framed_target.id: framed_target})
            _apply_op_to_pdf(doc, move_op, {framed_target.id: framed_target})
            doc.save(moved)

        rendered = _render_rgb(moved)
        old_center = rendered.getpixel((100, 200))
        new_center = rendered.getpixel((180, 200))
        new_corner = rendered.getpixel((132, 152))
        assert min(old_center) > 240
        assert new_center[2] > 200 and new_center[0] < 80
        assert min(new_corner) > 240

        moved_target = [obj for obj in list_objects(moved, 0) if obj.type == "image"][0]
        remove_frame = EditOp.model_validate({
            "page": 0,
            "kind": "clipImage",
            "targetIds": [moved_target.id],
            "clip": {"shape": "none"},
        })
        with pikepdf.open(moved) as doc:
            _apply_op_to_pdf(doc, remove_frame, {moved_target.id: moved_target})
            doc.save(unframed)

        rendered = _render_rgb(unframed)
        restored_corner = rendered.getpixel((132, 152))
        assert restored_corner[2] > 200 and restored_corner[0] < 80

def test_clip_image_undo_redo_roundtrip(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "frame-session.pdf")
        _make_image_pdf(src)
        monkeypatch.setattr(edit_session_core, "_resolve_source_path", lambda _fid: src)
        session = edit_session_core.open_session("frame-session-fid")
        try:
            target = [
                obj for obj in edit_session_core.list_objects_from_session(session, 0)
                if obj.type == "image"
            ][0]
            op = EditOp.model_validate({
                "page": 0,
                "kind": "clipImage",
                "targetIds": [target.id],
                "clip": {"shape": "rounded", "radius": 0.2},
            })

            def marker_count() -> int:
                return sum(
                    str(instr.operator) in {"BMC", "BDC"}
                    and instr.operands
                    and str(instr.operands[0]) == "/PrynXImageClip"
                    for instr in pikepdf.parse_content_stream(session.pdf.pages[0])
                )

            edit_session_core.apply_op(session, op)
            assert marker_count() == 1
            assert len(session.op_log) == 1

            edit_session_core.undo(session)
            assert marker_count() == 0
            assert len(session.redo_stack) == 1

            edit_session_core.redo(session)
            assert marker_count() == 1
            assert len(session.op_log) == 1
        finally:
            edit_session_core.close_session(session.session_id)

"""Contract affine-mm và parity manifest cho nesting tự do production."""

from __future__ import annotations

from copy import deepcopy

import pytest

from app.workers.imposition_affine import (
    Affine2D,
    AffineContractError,
    PoseMm,
    compose_affine,
    compose_render_ctm_mm,
    parse_pose_mm,
    rigid_pose_affine_mm,
)
from app.workers.imposition_parity import (
    ParityError,
    assert_manifest_affine_parity,
    assert_parity,
)


IDENTITY = Affine2D(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


@pytest.mark.parametrize("angle", [0.0, 13.372849, 90.0, 217.5, 359.999999])
def test_pose_affine_maps_reference_to_translation_without_mirror(angle):
    reference = (11.25, -7.5)
    pose = PoseMm(angle, 123.456, 87.654)
    geometry = rigid_pose_affine_mm(pose, reference)

    assert geometry.apply(reference) == pytest.approx(
        (pose.translate_x_mm, pose.translate_y_mm), abs=1e-12
    )
    assert geometry.determinant == pytest.approx(1.0, abs=1e-12)


@pytest.mark.parametrize(
    "raw",
    [
        {"rotationDeg": 17.0, "translateXmm": 1.0},
        {
            "rotationDeg": 17.0,
            "translateXmm": 1.0,
            "translateYmm": 2.0,
            "extra": 3,
        },
        {"rotationDeg": True, "translateXmm": 1.0, "translateYmm": 2.0},
        {"rotationDeg": -0.001, "translateXmm": 1.0, "translateYmm": 2.0},
        {"rotationDeg": 360.0, "translateXmm": 1.0, "translateYmm": 2.0},
        {"rotationDeg": 17.0, "translateXmm": float("nan"), "translateYmm": 2.0},
    ],
)
def test_parse_pose_mm_rejects_contract_drift(raw):
    with pytest.raises(AffineContractError):
        parse_pose_mm(raw)


def test_render_ctm_order_and_determinant_for_front_back_cut():
    source = Affine2D(0.0, -1.0, 1.0, 0.0, -14.111111, 148.166667)
    pose = PoseMm(17.0, 120.5, 80.25)
    reference = (31.0, 22.0)
    geometry = rigid_pose_affine_mm(pose, reference)
    back_frame = Affine2D(-1.0, 0.0, 0.0, 1.0, 320.0, 0.0)
    point = (25.0, 40.0)

    front = compose_render_ctm_mm(
        sheet_frame=IDENTITY,
        pose=pose,
        reference_point_mm=reference,
        source_page_to_canonical=source,
    )
    cut = compose_render_ctm_mm(
        sheet_frame=IDENTITY,
        pose=pose,
        reference_point_mm=reference,
        source_page_to_canonical=source,
    )
    back = compose_render_ctm_mm(
        sheet_frame=back_frame,
        pose=pose,
        reference_point_mm=reference,
        source_page_to_canonical=source,
    )
    expected_front = geometry.apply(source.apply(point))

    assert front.apply(point) == pytest.approx(expected_front, abs=1e-12)
    assert cut.apply(point) == pytest.approx(expected_front, abs=1e-12)
    assert back.apply(point) == pytest.approx(
        back_frame.apply(expected_front), abs=1e-12
    )
    assert front.determinant == pytest.approx(1.0, abs=1e-12)
    assert cut.determinant == pytest.approx(1.0, abs=1e-12)
    assert back.determinant == pytest.approx(-1.0, abs=1e-12)

    wrong_order = compose_affine(source, compose_affine(geometry, IDENTITY))
    assert wrong_order.apply(point) != pytest.approx(front.apply(point), abs=1e-6)


def test_render_ctm_rejects_mirror_inside_source_transform():
    mirrored_source = Affine2D(-1.0, 0.0, 0.0, 1.0, 100.0, 0.0)
    with pytest.raises(AffineContractError, match="không được mirror"):
        compose_render_ctm_mm(
            sheet_frame=IDENTITY,
            pose=PoseMm(41.25, 70.0, 90.0),
            reference_point_mm=(10.0, 20.0),
            source_page_to_canonical=mirrored_source,
        )


def _placement(
    instance_id: str,
    *,
    part_id: str = "part-a",
    angle: float = 13.372849,
    tx: float = 80.0,
    ty: float = 90.0,
    sheet_index: int = 0,
    source_revision: str = "a" * 64,
) -> dict:
    return {
        "instanceId": instance_id,
        "partId": part_id,
        "sheetIndex": sheet_index,
        "pose": {
            "rotationDeg": angle,
            "translateXmm": tx,
            "translateYmm": ty,
        },
        "sourceRevision": source_revision,
    }


def test_manifest_affine_parity_pairs_by_instance_id_not_array_order():
    preview = [
        _placement("part-a#0001"),
        _placement("part-b#0001", part_id="part-b", angle=217.5, tx=180.0),
    ]
    output = list(reversed(deepcopy(preview)))
    references = {"part-a": [10.0, 20.0], "part-b": [30.0, 40.0]}

    assert assert_manifest_affine_parity(
        preview,
        output,
        preview_reference_points_mm=references,
        output_reference_points_mm=deepcopy(references),
    )


def test_manifest_affine_parity_uses_circular_angle_and_mm_tolerance():
    preview = [_placement("part-a#0001", angle=359.999, tx=80.0, ty=90.0)]
    output = [_placement("part-a#0001", angle=0.001, tx=80.099, ty=89.901)]
    references = {"part-a": [10.0, 20.0]}

    assert assert_manifest_affine_parity(
        preview,
        output,
        preview_reference_points_mm=references,
        output_reference_points_mm=references,
    )


@pytest.mark.parametrize(
    "field,value,match",
    [
        ("partId", "part-b", "partId"),
        ("sheetIndex", 1, "sheetIndex"),
        ("sourceRevision", "b" * 64, "sourceRevision"),
    ],
)
def test_manifest_affine_parity_rejects_identity_drift(field, value, match):
    preview = [_placement("part-a#0001")]
    output = deepcopy(preview)
    output[0][field] = value
    references = {"part-a": [10.0, 20.0], "part-b": [10.0, 20.0]}

    with pytest.raises(ParityError, match=match):
        assert_manifest_affine_parity(
            preview,
            output,
            preview_reference_points_mm=references,
            output_reference_points_mm=references,
        )


@pytest.mark.parametrize(
    "pose_field,value,match",
    [
        ("rotationDeg", 13.392849, "góc xoay"),
        ("translateXmm", 80.100001, "translateXmm"),
        ("translateYmm", 90.100001, "translateYmm"),
    ],
)
def test_manifest_affine_parity_rejects_pose_drift(pose_field, value, match):
    preview = [_placement("part-a#0001")]
    output = deepcopy(preview)
    output[0]["pose"][pose_field] = value
    references = {"part-a": [10.0, 20.0]}

    with pytest.raises(ParityError, match=match):
        assert_manifest_affine_parity(
            preview,
            output,
            preview_reference_points_mm=references,
            output_reference_points_mm=references,
        )


def test_manifest_affine_parity_rejects_reference_and_instance_set_drift():
    preview = [_placement("part-a#0001")]
    output = deepcopy(preview)

    with pytest.raises(ParityError, match="referencePointMm lệch"):
        assert_manifest_affine_parity(
            preview,
            output,
            preview_reference_points_mm={"part-a": [10.0, 20.0]},
            output_reference_points_mm={"part-a": [10.001, 20.0]},
        )

    with pytest.raises(ParityError, match="Instance set lệch"):
        assert_manifest_affine_parity(
            preview,
            [],
            preview_reference_points_mm={"part-a": [10.0, 20.0]},
            output_reference_points_mm={"part-a": [10.0, 20.0]},
        )


def test_manifest_affine_parity_rejects_duplicate_instance_id():
    placement = _placement("part-a#0001")
    references = {"part-a": [10.0, 20.0]}
    with pytest.raises(ParityError, match="instanceId trùng"):
        assert_manifest_affine_parity(
            [placement],
            [deepcopy(placement), deepcopy(placement)],
            preview_reference_points_mm=references,
            output_reference_points_mm=references,
        )


def test_legacy_parity_rejects_rotation_deg_instead_of_false_green():
    base = {"x": 0.0, "y": 0.0, "width": 10.0, "height": 20.0}
    preview = [{**base, "rotationDeg": 13.25}]
    output = [{**base, "rotationDeg": 217.5}]

    with pytest.raises(ParityError, match="assert_manifest_affine_parity"):
        assert_parity(preview, output)


@pytest.mark.parametrize(
    "sheet_frame,source_transform",
    [
        (Affine2D(2.0, 0.0, 0.0, 2.0, 0.0, 0.0), IDENTITY),
        (Affine2D(1.0, 0.0, 0.5, 1.0, 0.0, 0.0), IDENTITY),
        (IDENTITY, Affine2D(3.0, 0.0, 0.0, 3.0, 0.0, 0.0)),
        (IDENTITY, Affine2D(1.0, 0.0, 2.0, 1.0, 0.0, 0.0)),
    ],
)
def test_render_ctm_rejects_scale_and_shear(sheet_frame, source_transform):
    with pytest.raises(AffineContractError, match="scale/shear"):
        compose_render_ctm_mm(
            sheet_frame=sheet_frame,
            pose=PoseMm(17.0, 70.0, 90.0),
            reference_point_mm=(10.0, 20.0),
            source_page_to_canonical=source_transform,
        )


@pytest.mark.parametrize(
    "tolerance_name,value",
    [
        (name, value)
        for name in ("pos_tol_mm", "rot_tol_deg")
        for value in (True, "0.1", float("nan"), float("inf"), {}, [])
    ],
)
def test_legacy_parity_rejects_malformed_tolerance(tolerance_name, value):
    item = {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}
    with pytest.raises(ParityError, match="phải là số hữu hạn"):
        assert_parity([item], [deepcopy(item)], **{tolerance_name: value})


@pytest.mark.parametrize("field", ["x", "rotation"])
def test_legacy_parity_rejects_nan_in_geometry(field):
    preview = {
        "x": 0.0,
        "y": 0.0,
        "width": 10.0,
        "height": 20.0,
        field: float("nan"),
    }
    output = {"x": 0.0, "y": 0.0, "width": 10.0, "height": 20.0}

    with pytest.raises(ParityError, match="phải là số hữu hạn"):
        assert_parity([preview], [output])


def test_legacy_parity_rejects_manifest_identity_when_pose_was_dropped():
    partial_manifest = {
        "instanceId": "part-a#0001",
        "partId": "part-a",
        "sheetIndex": 0,
        "sourceRevision": "a" * 64,
    }

    with pytest.raises(ParityError, match="assert_manifest_affine_parity"):
        assert_parity([partial_manifest], [deepcopy(partial_manifest)])

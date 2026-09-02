"""
imposition_parity.py — Parity guard cho preview == output (R7).

Cung cấp `assert_parity` để so sánh bố cục giữa đường dẫn preview và đường dẫn
output theo dung sai cấu hình. Được dùng làm "lưới an toàn" cho các phase sau:
mọi thay đổi layout phải giữ preview khớp output.

Spec: .kiro/specs/die-shape-detection-ssot
Requirements: 7.1, 7.3, 7.4, 7.5
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.workers.imposition_affine import (
    AffineContractError,
    PoseMm,
    angle_diff_deg,
    parse_finite_number,
    parse_point_mm,
    parse_pose_mm,
    rigid_pose_affine_mm,
)

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465

# Dung sai mặc định (R7.3): vị trí/kích thước 0.1mm, góc 0.01 độ.
DEFAULT_POS_TOL_MM = 0.1
DEFAULT_ROT_TOL_DEG = 0.01

# Khoảng hợp lệ cho cấu hình dung sai (ngoài khoảng → dùng mặc định + cảnh báo, R7.5).
_POS_TOL_RANGE_MM = (0.0, 5.0)
_ROT_TOL_RANGE_DEG = (0.0, 5.0)

_MANIFEST_AFFINE_FIELDS = frozenset(
    {
        "instanceId",
        "partId",
        "sheetIndex",
        "sourceRevision",
        "pose",
        "rotationDeg",
        "translateXmm",
        "translateYmm",
        "referencePointMm",
        "affineMm",
    }
)


class ParityError(AssertionError):
    """Sai lệch parity vượt dung sai (R7.4)."""


@dataclass(frozen=True)
class ParityTolerance:
    pos_tol_pt: float
    rot_tol_deg: float


def _parity_number(value: Any, field: str) -> float:
    """Đọc số hữu hạn và đổi lỗi contract thành ParityError."""

    try:
        return parse_finite_number(value, field=field)
    except AffineContractError as exc:
        raise ParityError(str(exc)) from exc


def resolve_tolerance(
    pos_tol_mm: float | None = None,
    rot_tol_deg: float | None = None,
) -> ParityTolerance:
    """Chuẩn hoá cấu hình dung sai; thiếu/ngoài khoảng → mặc định + log cảnh báo (R7.5)."""
    p_mm = pos_tol_mm
    if p_mm is not None:
        p_mm = _parity_number(p_mm, "pos_tol_mm")
    if p_mm is None or not (_POS_TOL_RANGE_MM[0] <= p_mm <= _POS_TOL_RANGE_MM[1]):
        if p_mm is not None:
            logger.warning(
                "[PARITY] pos_tol_mm=%s ngoài %s → dùng mặc định %s mm.",
                p_mm, _POS_TOL_RANGE_MM, DEFAULT_POS_TOL_MM,
            )
        p_mm = DEFAULT_POS_TOL_MM

    r_deg = rot_tol_deg
    if r_deg is not None:
        r_deg = _parity_number(r_deg, "rot_tol_deg")
    if r_deg is None or not (_ROT_TOL_RANGE_DEG[0] <= r_deg <= _ROT_TOL_RANGE_DEG[1]):
        if r_deg is not None:
            logger.warning(
                "[PARITY] rot_tol_deg=%s ngoài %s → dùng mặc định %s độ.",
                r_deg, _ROT_TOL_RANGE_DEG, DEFAULT_ROT_TOL_DEG,
            )
        r_deg = DEFAULT_ROT_TOL_DEG

    return ParityTolerance(pos_tol_pt=p_mm * MM_TO_PTS, rot_tol_deg=r_deg)


def _rotation_deg(item: dict[str, Any]) -> float:
    """Suy ra góc xoay (độ) từ một item layout (hỗ trợ isRotated/isRotated180/rotation)."""
    if "rotation" in item:
        return _parity_number(item["rotation"], "rotation") % 360.0
    deg = 0.0
    if item.get("isRotated"):
        deg += 90.0
    if item.get("isRotated180"):
        deg += 180.0
    return deg % 360.0


def _angle_diff(a: float, b: float) -> float:
    """Chênh lệch góc nhỏ nhất (độ) trên vòng tròn."""
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _reject_manifest_items_in_legacy(
    preview_items: Sequence[dict[str, Any]],
    output_items: Sequence[dict[str, Any]],
) -> None:
    """Không cho parity legacy tạo false-green khi gặp pose manifest-mm."""

    for lane, items in (("preview", preview_items), ("output", output_items)):
        for index, item in enumerate(items):
            fields = _MANIFEST_AFFINE_FIELDS.intersection(item)
            if fields:
                names = ", ".join(sorted(fields))
                raise ParityError(
                    f"{lane}[{index}] chứa {names}; phải dùng "
                    "assert_manifest_affine_parity cho pose manifest-mm."
                )


def assert_parity(
    preview_items: Sequence[dict[str, Any]],
    output_items: Sequence[dict[str, Any]],
    pos_tol_mm: float | None = None,
    rot_tol_deg: float | None = None,
) -> bool:
    """So bố cục preview vs output từng phần tử theo dung sai (R7.1, R7.3).

    Trả True nếu ĐẠT. Vượt dung sai → raise ParityError nêu rõ phần tử và loại
    sai lệch (R7.4). Thiếu/ngoài khoảng cấu hình → dùng mặc định + cảnh báo (R7.5).
    """
    _reject_manifest_items_in_legacy(preview_items, output_items)
    tol = resolve_tolerance(pos_tol_mm, rot_tol_deg)

    if len(preview_items) != len(output_items):
        raise ParityError(
            f"Số phần tử lệch: preview={len(preview_items)} vs output={len(output_items)}"
        )

    for idx, (pv, ov) in enumerate(zip(preview_items, output_items)):
        for attr in ("x", "y", "width", "height"):
            pv_val = _parity_number(
                pv.get(attr, 0.0), f"preview[{idx}].{attr}"
            )
            ov_val = _parity_number(
                ov.get(attr, 0.0), f"output[{idx}].{attr}"
            )
            if abs(pv_val - ov_val) > tol.pos_tol_pt:
                raise ParityError(
                    f"Phần tử #{idx}: '{attr}' lệch {abs(pv_val - ov_val):.4f}pt "
                    f"> dung sai {tol.pos_tol_pt:.4f}pt "
                    f"(preview={pv_val:.4f}, output={ov_val:.4f})"
                )
        rot_diff = _angle_diff(_rotation_deg(pv), _rotation_deg(ov))
        if rot_diff > tol.rot_tol_deg:
            raise ParityError(
                f"Phần tử #{idx}: góc xoay lệch {rot_diff:.4f}° "
                f"> dung sai {tol.rot_tol_deg:.4f}°"
            )
    return True


@dataclass(frozen=True)
class _ManifestPlacement:
    instance_id: str
    part_id: str
    sheet_index: int
    source_revision: str
    pose: PoseMm


def _index_manifest_items(
    items: Sequence[Mapping[str, Any]], lane: str
) -> dict[str, _ManifestPlacement]:
    expected = {"instanceId", "partId", "sheetIndex", "pose", "sourceRevision"}
    indexed: dict[str, _ManifestPlacement] = {}
    for index, raw in enumerate(items):
        if not isinstance(raw, Mapping) or set(raw) != expected:
            raise ParityError(
                f"{lane}[{index}] không đúng exact schema placement manifest."
            )
        instance_id = raw["instanceId"]
        part_id = raw["partId"]
        sheet_index = raw["sheetIndex"]
        source_revision = raw["sourceRevision"]
        if not isinstance(instance_id, str) or not instance_id:
            raise ParityError(f"{lane}[{index}].instanceId không hợp lệ.")
        if instance_id in indexed:
            raise ParityError(f"{lane} có instanceId trùng: {instance_id!r}.")
        if not isinstance(part_id, str) or not part_id:
            raise ParityError(f"{lane}[{index}].partId không hợp lệ.")
        if type(sheet_index) is not int or sheet_index < 0:
            raise ParityError(f"{lane}[{index}].sheetIndex không hợp lệ.")
        if not isinstance(source_revision, str) or not source_revision:
            raise ParityError(f"{lane}[{index}].sourceRevision không hợp lệ.")
        try:
            pose = parse_pose_mm(raw["pose"], field=f"{lane}[{index}].pose")
        except AffineContractError as exc:
            raise ParityError(str(exc)) from exc
        indexed[instance_id] = _ManifestPlacement(
            instance_id=instance_id,
            part_id=part_id,
            sheet_index=sheet_index,
            source_revision=source_revision,
            pose=pose,
        )
    return indexed


def _reference_for_part(
    references: Mapping[str, Sequence[Any]], part_id: str, lane: str
) -> tuple[float, float]:
    if part_id not in references:
        raise ParityError(f"{lane} thiếu referencePointMm của part {part_id!r}.")
    try:
        return parse_point_mm(
            references[part_id],
            field=f"{lane}.referencePointMm[{part_id!r}]",
        )
    except AffineContractError as exc:
        raise ParityError(str(exc)) from exc


def assert_manifest_affine_parity(
    preview_items: Sequence[Mapping[str, Any]],
    output_items: Sequence[Mapping[str, Any]],
    *,
    preview_reference_points_mm: Mapping[str, Sequence[Any]],
    output_reference_points_mm: Mapping[str, Sequence[Any]],
    pos_tol_mm: float | None = None,
    rot_tol_deg: float | None = None,
) -> bool:
    """So parity manifest-mm theo identity và pose, không trộn lane point/AABB.

    Thứ tự mảng không authoritative; instanceId mới là khoá ghép. Reference point
    lấy từ immutable render bundle theo partId và phải giống canonical tuyệt đối.
    """

    if not isinstance(preview_reference_points_mm, Mapping):
        raise ParityError("preview_reference_points_mm phải là mapping theo partId.")
    if not isinstance(output_reference_points_mm, Mapping):
        raise ParityError("output_reference_points_mm phải là mapping theo partId.")

    preview = _index_manifest_items(preview_items, "preview")
    output = _index_manifest_items(output_items, "output")
    if set(preview) != set(output):
        missing = sorted(set(preview).difference(output))
        extra = sorted(set(output).difference(preview))
        raise ParityError(
            f"Instance set lệch; thiếu ở output={missing}, dư ở output={extra}."
        )

    tolerance = resolve_tolerance(pos_tol_mm, rot_tol_deg)
    position_tolerance_mm = tolerance.pos_tol_pt / MM_TO_PTS
    for instance_id in sorted(preview):
        pv = preview[instance_id]
        ov = output[instance_id]
        for field, pv_value, ov_value in (
            ("partId", pv.part_id, ov.part_id),
            ("sheetIndex", pv.sheet_index, ov.sheet_index),
            ("sourceRevision", pv.source_revision, ov.source_revision),
        ):
            if pv_value != ov_value:
                raise ParityError(
                    f"Instance {instance_id!r}: {field} lệch "
                    f"(preview={pv_value!r}, output={ov_value!r})."
                )

        pv_reference = _reference_for_part(
            preview_reference_points_mm, pv.part_id, "preview"
        )
        ov_reference = _reference_for_part(
            output_reference_points_mm, ov.part_id, "output"
        )
        if pv_reference != ov_reference:
            raise ParityError(
                f"Instance {instance_id!r}: referencePointMm lệch "
                f"(preview={pv_reference}, output={ov_reference})."
            )

        try:
            pv_geometry = rigid_pose_affine_mm(pv.pose, pv_reference)
            ov_geometry = rigid_pose_affine_mm(ov.pose, ov_reference)
            rotation_difference = angle_diff_deg(
                pv.pose.rotation_deg, ov.pose.rotation_deg
            )
        except AffineContractError as exc:
            raise ParityError(str(exc)) from exc
        if abs(pv_geometry.determinant - 1.0) > 1e-12:
            raise ParityError(f"Instance {instance_id!r}: preview G không có det=+1.")
        if abs(ov_geometry.determinant - 1.0) > 1e-12:
            raise ParityError(f"Instance {instance_id!r}: output G không có det=+1.")

        for field, pv_value, ov_value in (
            ("translateXmm", pv.pose.translate_x_mm, ov.pose.translate_x_mm),
            ("translateYmm", pv.pose.translate_y_mm, ov.pose.translate_y_mm),
        ):
            difference = abs(pv_value - ov_value)
            if difference > position_tolerance_mm:
                raise ParityError(
                    f"Instance {instance_id!r}: {field} lệch {difference:.6f}mm "
                    f"> dung sai {position_tolerance_mm:.6f}mm."
                )
        if rotation_difference > tolerance.rot_tol_deg:
            raise ParityError(
                f"Instance {instance_id!r}: góc xoay lệch "
                f"{rotation_difference:.6f}° > dung sai "
                f"{tolerance.rot_tol_deg:.6f}°."
            )
    return True

"""
cut_model_builder.py — Dựng CutModel từ hình học đường cắt đã bình.

Requirements: 1.1, 1.2, 1.4, 1.5.

Thiết kế theo HỢP ĐỒNG INPUT rõ ràng để unit-test được, KHÔNG ghép cứng nội bộ
nup_engine. Nguồn hình học thực tế là `nup_diecut.extract_page_die_cut_polygon`
(Shapely Polygon) — builder nhận polygon/coords (mm, gốc dưới-trái) và:
  - làm phẳng/nén (RDP) giữ sai số (Req 1.2),
  - giữ NGUYÊN vị trí từng con theo layout (không tự căn) (Req 1.4),
  - gắn tên nhóm/ô/lớp theo PontConfig — hợp đồng đặt tên (Req 1.5),
  - tính frame = bbox tâm ốc.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.geometry import rdp_simplify, RDP_EPS_MM


class NamingContractError(ValueError):
    """Tên nhóm/ô/lớp không khớp cài đặt ốc (PontConfig) — Req 1.5."""


def _polygon_to_polylines(geom: Any) -> list[list[tuple[float, float]]]:
    """Chuẩn hoá một hình học → danh sách polyline (exterior + các interior).

    Chấp nhận:
      - Shapely Polygon/MultiPolygon (có .exterior/.geoms),
      - list điểm [(x,y), ...],
      - dict {'points': [...]}.
    """
    # dict
    if isinstance(geom, dict) and "points" in geom:
        return [[(float(x), float(y)) for x, y in geom["points"]]]
    # list điểm
    if isinstance(geom, (list, tuple)) and geom and isinstance(geom[0], (list, tuple)) and len(geom[0]) == 2:
        return [[(float(x), float(y)) for x, y in geom]]
    # Shapely
    rings: list[list[tuple[float, float]]] = []
    geoms = getattr(geom, "geoms", None)
    if geoms is not None:  # MultiPolygon
        for g in geoms:
            rings.extend(_polygon_to_polylines(g))
        return rings
    ext = getattr(geom, "exterior", None)
    if ext is not None:  # Polygon
        rings.append([(float(x), float(y)) for x, y in list(ext.coords)])
        for interior in getattr(geom, "interiors", []):
            rings.append([(float(x), float(y)) for x, y in list(interior.coords)])
        return rings
    raise TypeError(f"Không nhận dạng được hình học đường cắt: {type(geom)!r}")


def _extract_source_names(pont_config: Optional[dict]) -> dict:
    if not pont_config:
        return {}
    return {
        "group": pont_config.get("groupName") or pont_config.get("group_name") or "",
        "item": pont_config.get("itemName") or pont_config.get("item_name") or "",
        "layer": pont_config.get("layerName") or pont_config.get("layer_name") or "",
        "layerInfo": pont_config.get("layerInfoName") or pont_config.get("layer_info_name") or "",
    }


def build_cut_model(
    cut_geometries: Iterable[Any],
    *,
    marks: Optional[Iterable[tuple]] = None,
    sheet_w_mm: float,
    sheet_h_mm: float,
    pont_config: Optional[dict] = None,
    tool_tags: Optional[list[Optional[str]]] = None,
    block_ids: Optional[list[int]] = None,
    rdp_eps_mm: float = RDP_EPS_MM,
    require_naming: bool = False,
) -> CutModel:
    """Dựng CutModel từ các hình học đường cắt (mm, gốc dưới-trái).

    cut_geometries: lặp các polygon/coords (mỗi phần tử = 1 con/khuôn).
    marks: lặp (x, y[, kind]) tâm ốc (mm).
    require_naming: nếu True và có pont_config → bắt buộc group+item không rỗng (Req 1.5).
    """
    source_names = _extract_source_names(pont_config)

    if require_naming and pont_config is not None:
        if not source_names.get("group") or not source_names.get("item"):
            raise NamingContractError(
                "Cài đặt ốc/boong thiếu tên nhóm (groupName) hoặc tên ô (itemName) — "
                "không thể khớp hợp đồng đặt tên với khâu sinh lệnh (Req 1.5)."
            )

    geoms = list(cut_geometries)
    paths: list[CutPath] = []
    for i, geom in enumerate(geoms):
        for ring in _polygon_to_polylines(geom):
            if len(ring) < 2:
                continue
            simplified = rdp_simplify(ring, rdp_eps_mm)
            if len(simplified) < 2:
                continue
            tag = tool_tags[i] if tool_tags and i < len(tool_tags) else None
            bid = block_ids[i] if block_ids and i < len(block_ids) else 0
            paths.append(CutPath(points=simplified, closed=True, tool_tag=tag, block_id=bid))

    mark_objs: list[RegMark] = []
    for m in (marks or []):
        if len(m) >= 3:
            mark_objs.append(RegMark(m[0], m[1], m[2]))
        else:
            mark_objs.append(RegMark(m[0], m[1]))

    model = CutModel(
        paths=paths,
        marks=mark_objs,
        sheet_w_mm=sheet_w_mm,
        sheet_h_mm=sheet_h_mm,
        source_names=source_names,
    )
    model.frame = model.compute_frame_from_marks()

    if model.is_empty:
        raise ValueError("Không có đường cắt hợp lệ nào để xuất (Req 1.5).")

    return model

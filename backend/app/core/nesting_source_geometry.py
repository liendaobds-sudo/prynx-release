"""Resolve contour nguồn đã pin sang hệ canonical mm cho nesting production.

Module này chỉ mở snapshot trong PinnedNestingSource. Tọa độ parser top-down
được đổi về PDF bottom-up, đổi user unit sang mm rồi áp
SourcePageToCanonical đúng một lần. Không có nhánh fallback theo bbox.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Literal, Sequence

from app.core.nesting_production_adapter import CANONICAL_DECIMAL_PLACES, RenderPolygonV1
from app.core.nesting_source_pin import PinnedNestingSource, PinnedPageMetadata
from app.workers.imposition_affine import Affine2D

if TYPE_CHECKING:
    from app.workers.die_detection import DetectedShape


_PT_TO_MM = 25.4 / 72.0


class NestingSourceGeometryError(ValueError):
    """Contour nguồn không đủ chặt để dùng trong manifest production."""

    code = "NESTING_SOURCE_GEOMETRY_INVALID"
    status_code = 422


@dataclass(frozen=True, slots=True)
class ResolvedSourceGeometry:
    """Một contour trong hệ canonical mm, gắn với đúng trang snapshot."""

    page_index: int
    source_kind: Literal["sticker", "cnc"]
    polygon: RenderPolygonV1


def _error(message: str) -> NestingSourceGeometryError:
    return NestingSourceGeometryError(message)


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error(f"{field} phải là số hữu hạn.")
    result = float(value)
    if not math.isfinite(result):
        raise _error(f"{field} phải là số hữu hạn.")
    return 0.0 if result == 0.0 else result


def _box4(value: Any, field: str) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise _error(f"{field} phải có đúng bốn tọa độ mm.")
    box = tuple(
        _finite_number(coordinate, f"{field}[{index}]")
        for index, coordinate in enumerate(value)
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        raise _error(f"{field} có chiều rộng/chiều cao không dương.")
    return box


def _expected_source_affine(
    media_box_mm: Sequence[float], rotate_deg: int
) -> tuple[float, float, float, float, float, float]:
    x0, y0, x1, y1 = media_box_mm
    if rotate_deg == 0:
        return (1.0, 0.0, 0.0, 1.0, -x0, -y0)
    if rotate_deg == 90:
        return (0.0, -1.0, 1.0, 0.0, -y0, x1)
    if rotate_deg == 180:
        return (-1.0, 0.0, 0.0, -1.0, x1, y1)
    return (0.0, 1.0, -1.0, 0.0, y1, -x0)


def _validate_page_metadata(
    pin: PinnedNestingSource, page_index: int
) -> PinnedPageMetadata:
    if not isinstance(pin, PinnedNestingSource):
        raise TypeError("pin phải là PinnedNestingSource.")
    if type(page_index) is not int or page_index < 0:
        raise _error("page_index phải là số nguyên không âm, không nhận boolean.")
    if type(pin.page_count) is not int or pin.page_count <= 0:
        raise _error("source pin có page_count không hợp lệ.")
    if len(pin.pages) != pin.page_count:
        raise _error("source pin không có đủ metadata cho mọi trang.")
    if page_index >= pin.page_count:
        raise _error("page_index vượt số trang của source pin.")

    for expected_index, metadata in enumerate(pin.pages):
        if not isinstance(metadata, PinnedPageMetadata):
            raise _error("source pin chứa page metadata sai kiểu.")
        if type(metadata.page_index) is not int or metadata.page_index != expected_index:
            raise _error("source pin có page metadata trùng, thiếu hoặc sai thứ tự.")
    metadata = pin.pages[page_index]

    if not isinstance(metadata.page_boxes_mm, dict) or set(metadata.page_boxes_mm) != {
        "mediaBox",
        "cropBox",
        "trimBox",
    }:
        raise _error("page metadata phải có đúng MediaBox/CropBox/TrimBox.")
    media_box = _box4(metadata.page_boxes_mm["mediaBox"], "page.mediaBox")
    _box4(metadata.page_boxes_mm["cropBox"], "page.cropBox")
    _box4(metadata.page_boxes_mm["trimBox"], "page.trimBox")
    user_unit = _finite_number(metadata.user_unit, "page.userUnit")
    if not 0.0 < user_unit <= 75000.0:
        raise _error("page.userUnit ngoài miền PDF hợp lệ.")
    if type(metadata.rotate_deg) is not int or metadata.rotate_deg not in {0, 90, 180, 270}:
        raise _error("page.rotateDeg không phải góc phần tư canonical.")
    try:
        source_affine = Affine2D.from_sequence(
            metadata.source_page_to_canonical,
            field="page.sourcePageToCanonical",
        )
    except ValueError as exc:
        raise _error(str(exc)) from exc
    expected_affine = _expected_source_affine(media_box, metadata.rotate_deg)
    if any(
        abs(actual - expected) > 1e-6
        for actual, expected in zip(source_affine.as_tuple(), expected_affine)
    ):
        raise _error("SourcePageToCanonical không khớp MediaBox và Rotate đã pin.")
    return metadata


def _document_page_count(document: Any) -> int:
    value = getattr(document, "page_count", None)
    if type(value) is int:
        return value
    try:
        return len(document)
    except (TypeError, AttributeError) as exc:
        raise _error("Không đọc được số trang của PDF snapshot.") from exc


def _open_snapshot_page(
    pin: PinnedNestingSource,
    page_index: int,
    document_opener: Callable[[str], Any],
) -> tuple[Any, Any]:
    snapshot_path = Path(pin.snapshot_path)
    try:
        document = document_opener(str(snapshot_path))
    except Exception as exc:
        raise _error("Không mở được PDF snapshot đã pin.") from exc
    try:
        if _document_page_count(document) != pin.page_count:
            raise _error("Số trang PDF snapshot không khớp source pin.")
        page = document[page_index]
    except NestingSourceGeometryError:
        try:
            document.close()
        except Exception:
            pass
        raise
    except Exception as exc:
        try:
            document.close()
        except Exception:
            pass
        raise _error("Không đọc được trang đã pin trong PDF snapshot.") from exc
    return document, page


def _point_to_canonical_mm(
    point: Sequence[Any],
    *,
    metadata: PinnedPageMetadata,
    source_affine: Affine2D,
) -> tuple[float, float]:
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        raise _error("Contour phải gồm các điểm có đúng hai tọa độ.")
    x_top_user = _finite_number(point[0], "contour.xUserUnit")
    y_top_user = _finite_number(point[1], "contour.yUserUnit")
    scale = metadata.user_unit * _PT_TO_MM
    media_box = metadata.page_boxes_mm["mediaBox"]
    media_height_user = (float(media_box[3]) - float(media_box[1])) / scale
    raw_mm = (x_top_user * scale, (media_height_user - y_top_user) * scale)
    x_mm, y_mm = source_affine.apply(raw_mm)
    return (
        0.0 if x_mm == 0.0 else x_mm,
        0.0 if y_mm == 0.0 else y_mm,
    )


def _ring_to_canonical_mm(
    coordinates: Any,
    *,
    metadata: PinnedPageMetadata,
    source_affine: Affine2D,
    field: str,
) -> tuple[tuple[float, float], ...]:
    try:
        raw_points = list(coordinates)
    except TypeError as exc:
        raise _error(f"{field} không phải một vòng điểm.") from exc
    points = [
        _point_to_canonical_mm(
            point, metadata=metadata, source_affine=source_affine
        )
        for point in raw_points
    ]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    compact: list[tuple[float, float]] = []
    for point in points:
        if not compact or point != compact[-1]:
            compact.append(point)
    if len(compact) < 3 or len(set(compact)) < 3:
        raise _error(f"{field} không còn đủ ba đỉnh phân biệt.")
    area2 = sum(
        compact[index][0] * compact[(index + 1) % len(compact)][1]
        - compact[(index + 1) % len(compact)][0] * compact[index][1]
        for index in range(len(compact))
    )
    if not math.isfinite(area2) or abs(area2) <= 1e-12:
        raise _error(f"{field} có diện tích bằng 0 hoặc không hữu hạn.")
    return tuple(compact)


def _polygon_to_canonical_mm(
    polygon: Any,
    *,
    metadata: PinnedPageMetadata,
) -> RenderPolygonV1:
    if polygon is None:
        raise _error("Không tìm thấy contour bế semantic trên trang nguồn.")
    geometry_type = getattr(polygon, "geom_type", None)
    if geometry_type != "Polygon":
        if geometry_type == "MultiPolygon":
            raise _error("Trang có nhiều contour rời nên part nguồn bị nhập nhằng.")
        raise _error("Contour nguồn không phải một Polygon semantic duy nhất.")
    if bool(getattr(polygon, "is_empty", True)):
        raise _error("Contour nguồn rỗng.")
    if not bool(getattr(polygon, "is_valid", False)):
        raise _error("Contour nguồn tự cắt hoặc không hợp lệ.")
    area = _finite_number(getattr(polygon, "area", None), "contour.area")
    if area <= 0.0:
        raise _error("Contour nguồn có diện tích không dương.")

    try:
        source_affine = Affine2D.from_sequence(
            metadata.source_page_to_canonical,
            field="page.sourcePageToCanonical",
        )
        outer_coordinates = polygon.exterior.coords
        raw_interiors = tuple(polygon.interiors)
    except (AttributeError, TypeError, ValueError) as exc:
        raise _error("Không đọc được các vòng của contour nguồn.") from exc
    outer = _ring_to_canonical_mm(
        outer_coordinates,
        metadata=metadata,
        source_affine=source_affine,
        field="contour.outer",
    )
    holes = tuple(
        _ring_to_canonical_mm(
            interior.coords,
            metadata=metadata,
            source_affine=source_affine,
            field=f"contour.holes[{index}]",
        )
        for index, interior in enumerate(raw_interiors)
    )
    return RenderPolygonV1(outer=outer, holes=holes)


#: Dung sai đơn giản hoá footprint đóng gói, mm.
#:
#: PERF (audit 2026-08-28 §NEST-FOOTPRINT): chi phí NFP tăng theo BÌNH PHƯƠNG số mảnh
#: lồi, mà số mảnh ≈ số đỉnh lõm + 1. Đo trong Rust (release):
#:
#:     7 mảnh → NFP 0,44ms | 32 mảnh → 96ms | 43 mảnh → 510ms | 64 mảnh → 1715ms
#:
#: Contour thật từ file khách (13 trang) có 110–733 đỉnh với 4–66 đỉnh lõm, nên mỗi NFP
#: tốn 0,5–1,7s. Job nhiều mẫu cần NFP cho **từng cặp mẫu × từng góc**, nên 13 mẫu là
#: hàng trăm NFP ⇒ chờ nhiều phút, đúng triệu chứng "xoay mãi không xong".
#:
#: 0,2mm nằm **dưới** sai số cơ khí của dao bế (~0,3mm), nên không mất gì về nghiệp vụ.
#: Đo trên chính file khách ở mức này: đỉnh lõm giảm 50–65% (trang 733 đỉnh/66 lõm →
#: 171/22), diện tích chỉ phình 1,6–3,7%.
PACKING_FOOTPRINT_TOLERANCE_MM = 0.2

#: Trần số đỉnh của footprint đóng gói — **van an toàn**, không phải cần tăng tốc.
#:
#: PERF (audit 2026-08-28 §NEST-TRIALS-0): tôi đã thử ép mạnh số đỉnh để chữa việc solver
#: chạy 0 trial, và **đo được là hướng sai**. Ghi lại số đo để không ai làm lại:
#:
#: File khách 13 mẫu, autofill một tờ 320×430, ngân sách 3000ms, cùng máy, **3 lượt mỗi
#: cấu hình** (một lượt không đủ: cùng cấu hình đo được 31,7s rồi 55,3s):
#:
#:     | trần đỉnh | engineMs 3 lượt      | attempts | con/tờ |
#:     | 24        | 9,9 / 10,1 / 11,5s   | ~239     | 44     |
#:     | tắt trần  | 15,5 / 15,1 / 17,4s  | 69       | **46** |
#:
#: Cả hai cột `con/tờ` lặp lại y nguyên cả 3 lượt, nên kết luận không phải nhiễu:
#:
#: 1. **Ép đỉnh làm mất vật liệu thật.** 44 so với 46 con là −4,3% trên MỌI tờ, mãi mãi,
#:    để đổi lấy ~5,5s một lần. Với nhà in, vật liệu là chi phí trội ⇒ lỗ.
#:    (``materialUtilization`` mà engine báo *tăng* khi ép đỉnh — 0,615 so với 0,599 — là
#:    ảo: nó tính theo diện tích footprint, mà footprint vừa bị phình. Số đáng tin là
#:    ``placedCount``.)
#: 2. **Nhiều lượt thử không bù được footprint sai.** Trần 24 cho gấp 3,5 lần
#:    ``attempts`` (239 so với 69) mà vẫn xếp được ÍT hơn. Độ trung thực của hình thắng
#:    số lượt thử.
#: 3. **Chi phí mỗi attempt đi theo số đỉnh, và nó chiếm gần hết thời gian.**
#:    225ms/attempt ở 55–211 đỉnh so với 44ms/attempt ở ≤24 đỉnh — giảm 5 lần. Nhân với
#:    số attempt là ra đúng tổng thời gian (69 × 225ms ≈ 15,5s), nên không còn chỗ nào
#:    khác đáng kể.
#:
#: Điểm 3 dẫn tới kết luận về hướng tối ưu: phải làm NFP rẻ đi **mà không đổi hình** —
#: cache theo hình+góc (§NFP-CACHE, đã làm), chạy song song trial (NFP-PARALLEL-1), giảm
#: số mảnh lồi trong phân rã. Không phải làm hình xấu đi.
#:
#: Nên trần được đặt **cao hơn mọi giá trị thật của file khách** (đo tại 0,2mm: 55–211
#: đỉnh, cao nhất trang 12 với 211): nó không bao giờ chạm trên file bình thường, chỉ chặn
#: file bệnh lý kiểu contour vài nghìn đỉnh khỏi treo máy.
PACKING_FOOTPRINT_MAX_VERTICES = 256

#: Dung sai tối đa khi nới để đạt trần đỉnh, mm. Chặn trên để footprint không phình quá
#: mức thợ chấp nhận được: 3mm trên khuôn 45mm là ~13% mỗi chiều.
PACKING_FOOTPRINT_MAX_TOLERANCE_MM = 3.0


def derive_packing_footprint(
    polygon: RenderPolygonV1,
    *,
    tolerance_mm: float = PACKING_FOOTPRINT_TOLERANCE_MM,
    max_vertices: int = PACKING_FOOTPRINT_MAX_VERTICES,
    max_tolerance_mm: float = PACKING_FOOTPRINT_MAX_TOLERANCE_MM,
) -> RenderPolygonV1:
    """Dựng footprint đóng gói: rẻ hơn nhiều mà vẫn CHỨA đường bế thật.

    Đây là chỗ duy nhất được phép làm hình khác đường bế, và chỉ theo **một** chiều:
    phình ra. Hai bất biến:

    1. **Bao hàm.** Footprint phải phủ `cutContour` và `artworkClipPath` — chính điều
       `_validate_render_geometry` cưỡng chế. Nhờ vậy hai chi tiết không thể đè nhau:
       engine tránh va chạm trên footprint, mà footprint lớn hơn hình thật.
    2. **Dao vẫn cắt đường gốc.** Chỉ `packing_footprint` bị đổi; `cut_contour` giữ
       nguyên từng đỉnh. Người thợ nhận đúng đường bế của file.

    ``buffer`` được chọn thay vì ``simplify`` thuần vì Douglas–Peucker cắt **vào trong**
    nên phải hợp lại với hình gốc để giữ bao hàm — và bước hợp đó nhồi lại toàn bộ đỉnh
    cũ, đo được là mất sạch tác dụng (127 đỉnh vẫn ra 127). Phình ra thì **lấp luôn các
    chỗ lõm nhỏ**, tức xoá đúng loại đỉnh gây tốn.

    Lỗ bị bỏ khỏi footprint: kernel V1 vốn coi lỗ của footprint là vật liệu đặc, nên giữ
    lỗ ở đây chỉ tốn công mà không đổi kết quả.

    ``max_vertices`` là **mục tiêu**, không phải cam kết: nếu nới tới ``max_tolerance_mm``
    mà vẫn chưa đạt thì hàm trả footprint tốt nhất dựng được, không phình thêm nữa.
    """

    from shapely.geometry import Polygon

    if not isinstance(polygon, RenderPolygonV1):
        raise TypeError("polygon phải là RenderPolygonV1.")
    tolerance = float(tolerance_mm)
    if not math.isfinite(tolerance) or tolerance < 0.0:
        raise ValueError("tolerance_mm phải là số hữu hạn không âm.")
    max_tolerance = float(max_tolerance_mm)
    if not math.isfinite(max_tolerance) or max_tolerance < tolerance:
        raise ValueError("max_tolerance_mm phải là số hữu hạn không nhỏ hơn tolerance_mm.")
    if int(max_vertices) < 3:
        raise ValueError("max_vertices phải ít nhất là 3.")
    max_vertices = int(max_vertices)

    original = Polygon(polygon.outer)
    if tolerance == 0.0 or original.is_empty or not original.is_valid:
        return RenderPolygonV1(outer=polygon.outer, holes=())

    # Nới dung sai dần cho tới khi đạt trần số đỉnh. Mỗi bước vẫn phải CHỨA hình gốc, nên
    # nới thêm chỉ làm footprint lớn hơn — không bao giờ nhỏ hơn đường bế.
    best: Any = None
    step = tolerance
    while True:
        candidate = _grown_footprint(original, step)
        if candidate is not None:
            best = candidate
            if len(candidate.exterior.coords) - 1 <= max_vertices:
                break
        if step >= max_tolerance:
            break
        step = min(step * 2.0, max_tolerance)

    if best is None:
        # Không dựng được footprint an toàn ⇒ dùng chính đường bế. Chậm nhưng đúng;
        # tuyệt đối không trả hình có thể nhỏ hơn đường bế.
        return RenderPolygonV1(outer=polygon.outer, holes=())

    outer = tuple(
        (round(float(x), CANONICAL_DECIMAL_PLACES), round(float(y), CANONICAL_DECIMAL_PLACES))
        for x, y in tuple(best.exterior.coords)[:-1]
    )
    if len(outer) < 3:
        return RenderPolygonV1(outer=polygon.outer, holes=())
    return RenderPolygonV1(outer=outer, holes=())


def _grown_footprint(original: Any, tolerance: float) -> Any | None:
    """Một bước phình + giảm đỉnh. Trả ``None`` nếu không giữ được bao hàm.

    ``mitre`` để góc không sinh cả chùm đỉnh như join tròn.
    """

    grown = original.buffer(tolerance, join_style=2, mitre_limit=2.0)
    for candidate in (grown.simplify(tolerance, preserve_topology=True), grown):
        if candidate.geom_type == "Polygon" and candidate.covers(original):
            return candidate
    return None


def _default_document_opener(path: str) -> Any:
    from app.workers import pdf_wrapper as pdf_lib

    return pdf_lib.open(path)


def resolve_sticker_source_geometry(
    pin: PinnedNestingSource,
    page_index: int,
    *,
    polygon_extractor: Callable[[Any], Any] | None = None,
    document_opener: Callable[[str], Any] | None = None,
) -> ResolvedSourceGeometry:
    """Resolve đúng một contour Sticker từ trang snapshot, không fallback bbox."""

    metadata = _validate_page_metadata(pin, page_index)
    if polygon_extractor is None:
        from app.workers.nup_diecut import extract_page_die_cut_polygon

        # NEST (audit 2026-08-28 §A4b-2): đường manifest phải giữ LỖ KHUÔN (cửa sổ,
        # lỗ treo) để lớp CUT có nét dao trong lòng chi tiết. Lane legacy vẫn gọi
        # extractor không tham số nên hợp đồng cũ không đổi.
        polygon_extractor = partial(extract_page_die_cut_polygon, keep_holes=True)
    document, page = _open_snapshot_page(
        pin,
        page_index,
        document_opener or _default_document_opener,
    )
    try:
        try:
            polygon = polygon_extractor(page)
        except Exception as exc:
            raise _error("Không trích được contour bế từ PDF snapshot.") from exc
        resolved = _polygon_to_canonical_mm(polygon, metadata=metadata)
    finally:
        try:
            document.close()
        except Exception:
            pass
    return ResolvedSourceGeometry(
        page_index=page_index,
        source_kind="sticker",
        polygon=resolved,
    )


def resolve_cnc_source_geometry(
    pin: PinnedNestingSource,
    page_index: int,
    detected_shape: DetectedShape,
    *,
    document_opener: Callable[[str], Any] | None = None,
) -> ResolvedSourceGeometry:
    """Resolve contour CNC đã detect trên chính snapshot, không detect lại."""

    from shapely.geometry import Polygon

    from app.workers.die_detection import DetectedPageContour, DetectedShape

    metadata = _validate_page_metadata(pin, page_index)
    if not isinstance(detected_shape, DetectedShape):
        raise TypeError("detected_shape phải là DetectedShape.")
    if detected_shape.page != page_index:
        raise _error("DetectedShape không thuộc page_index đang resolve.")
    contour = detected_shape.page_contour
    if not isinstance(contour, DetectedPageContour):
        raise _error("DetectedShape không có page-space contour production.")
    if contour.page_index != page_index:
        raise _error("Page contour CNC không thuộc page_index đang resolve.")

    document, _page = _open_snapshot_page(
        pin,
        page_index,
        document_opener or _default_document_opener,
    )
    try:
        try:
            polygon = Polygon(
                contour.outer_top_down_user_units,
                contour.holes_top_down_user_units,
            )
        except (TypeError, ValueError) as exc:
            raise _error("Không dựng được Polygon từ page contour CNC.") from exc
        resolved = _polygon_to_canonical_mm(polygon, metadata=metadata)
    finally:
        try:
            document.close()
        except Exception:
            pass
    return ResolvedSourceGeometry(
        page_index=page_index,
        source_kind="cnc",
        polygon=resolved,
    )
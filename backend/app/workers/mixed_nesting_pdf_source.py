"""Nhập PDF khuôn bế thành contour cho "Bình lồng ghép tự do" — phase P12.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §10, §16.3.

Sáu quyết định của module này, mỗi cái đều có lý do đo được hoặc trích được:

1. **Không dùng PDFium.** Đọc đường vector bằng ``pdf_content_parser.parse_content_stream``
   — pikepdf thuần. Vì vậy yêu cầu "no PDFium thread race" của gate P12 được thoả mãn
   **theo cấu trúc**, không phải bằng cách bọc khóa cho đúng. Không có ``pdfium_guard()``
   ở đây là **chủ đích**, không phải thiếu sót.

2. **Không ghi file, không giữ PDF.** Lồng ghép chỉ cần *hình học*. Bytes PDF được phân
   tích trong RAM rồi bỏ; registry chỉ giữ polygon (vài KB mỗi khuôn). Hệ quả: không có
   storage root, không có cleanup root, không có đường path traversal — cả một lớp rủi ro
   của §12.4 biến mất thay vì phải phòng.

3. **Không nhận đường dẫn cục bộ.** Chỉ nhận bytes qua multipart (§10.1). Không có tham số
   nào trong module này nhận ``path``.

4. **Nhiều contour thì KHÔNG đoán.** Trả ``ambiguous`` kèm danh sách để người dùng chọn
   (§10.5). Tự chọn "cái lớn nhất" là cách âm thầm bình sai khuôn.

5. **Toạ độ phải lật lại Y.** Parser tự ghi trong docstring rằng nó dùng **hệ riêng** với
   Y đã lật (``pdf_content_parser.parse_content_stream`` dòng 511–514). Dùng thẳng số của
   parser sẽ cho contour **soi gương** — mà lật khuôn là điều cả dự án cấm. Ở đây lật lại
   một lần, và có test kiểm chiều vòng.

6. **Vị trí tuyệt đối trên trang không quan trọng.** Engine tự suy pivot bằng trọng tâm,
   nên một phép tịnh tiến hằng số không đổi kết quả. Contour được dịch về gốc `(0,0)` cho
   dễ đọc; điều **quan trọng** là tỷ lệ và chiều vòng, cả hai đều được kiểm.
"""

from __future__ import annotations

import hashlib
import logging
import math
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Final, Literal, Optional, Sequence

logger = logging.getLogger(__name__)

# ── Hằng số hợp đồng ────────────────────────────────────────────────────────

#: Version quy tắc làm phẳng Bézier + đơn giản hoá. Đổi quy tắc là đổi hợp đồng, và
#: ``sourceRevision`` bao version này nên kết quả cũ không bị dùng lẫn.
FLATTEN_RULE_VERSION: Final[int] = 1

#: Sai số làm phẳng đường cong, mm. Nhỏ hơn bước dao bế nên không thấy trên bản in.
FLATTEN_TOLERANCE_MM: Final[float] = 0.05

#: Sai số coi hai điểm là một, mm.
POINT_MERGE_TOLERANCE_MM: Final[float] = 0.01

#: Sai số coi ba điểm là thẳng hàng (khoảng cách vuông góc), mm.
COLLINEAR_TOLERANCE_MM: Final[float] = 0.005

#: Sai số coi vòng là đã đóng, mm.
CLOSE_TOLERANCE_MM: Final[float] = 0.35

#: Diện tích tối thiểu để một vòng được coi là contour thật, mm².
MIN_RING_AREA_MM2: Final[float] = 1.0

#: Trần đỉnh mỗi vòng sau khi làm phẳng. Khớp ``model.rs::MAX_RING_VERTICES``.
MAX_RING_VERTICES: Final[int] = 20_000

#: Trần số vòng ứng viên trả về cho người dùng chọn.
MAX_CANDIDATES: Final[int] = 64

#: Trần đỉnh cho phép kiểm tự cắt bằng O(n²). Vòng dày hơn thì để Rust kiểm.
SELF_INTERSECTION_CHECK_LIMIT: Final[int] = 2_000

#: Trần byte của file PDF nhận vào.
MAX_SOURCE_BYTES: Final[int] = 64 * 1024 * 1024

#: Số trang tối đa được quét.
MAX_PAGES_SCANNED: Final[int] = 50

#: TTL của một nguồn trong registry, giây.
SOURCE_TTL_SECONDS: Final[float] = 60 * 60

#: Trần số nguồn mỗi owner.
MAX_SOURCES_PER_OWNER: Final[int] = 64

_PT_TO_MM: Final[float] = 25.4 / 72.0

SourceStatus = Literal["ready", "ambiguous", "no_contour"]


class SourceError(Exception):
    """Lỗi có mã ổn định để route map sang HTTP."""

    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ─────────────────────────────────────────────────────────────────────────────
#  Hình học
# ─────────────────────────────────────────────────────────────────────────────

Point = tuple[float, float]
Ring = list[Point]


def _signed_area(ring: Sequence[Point]) -> float:
    total = 0.0
    count = len(ring)
    for index in range(count):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % count]
        total += x1 * y2 - x2 * y1
    return total / 2.0


def ring_area_mm2(ring: Sequence[Point]) -> float:
    return abs(_signed_area(ring))


def _bounds(ring: Sequence[Point]) -> tuple[float, float, float, float]:
    xs = [point[0] for point in ring]
    ys = [point[1] for point in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def flatten_cubic(p0: Point, p1: Point, p2: Point, p3: Point, tolerance_mm: float) -> list[Point]:
    """Làm phẳng một đoạn Bézier bậc ba, chia đôi thích ứng.

    Trả các điểm **không gồm** ``p0`` (điểm đó đã có ở đoạn trước) để không sinh đỉnh lặp.

    Tiêu chí phẳng: khoảng cách lớn nhất từ hai điểm điều khiển tới dây cung. Đây là chặn
    trên quen dùng cho độ lệch của đường cong so với dây — chọn nó vì rẻ và **không bao
    giờ đánh giá thấp** độ lệch, nên không làm phẳng quá tay.
    """
    # Độ lệch của hai điểm điều khiển so với dây p0→p3.
    dx = p3[0] - p0[0]
    dy = p3[1] - p0[1]
    chord = math.hypot(dx, dy)
    if chord < 1e-12:
        deviation = max(_distance(p1, p0), _distance(p2, p0))
    else:
        deviation = max(
            abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / chord,
            abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / chord,
        )

    if deviation <= tolerance_mm:
        return [p3]

    # Chia đôi de Casteljau.
    def mid(a: Point, b: Point) -> Point:
        return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)

    p01 = mid(p0, p1)
    p12 = mid(p1, p2)
    p23 = mid(p2, p3)
    p012 = mid(p01, p12)
    p123 = mid(p12, p23)
    center = mid(p012, p123)

    left = flatten_cubic(p0, p01, p012, center, tolerance_mm)
    right = flatten_cubic(center, p123, p23, p3, tolerance_mm)
    return left + right


def simplify_ring(ring: Sequence[Point]) -> Ring:
    """Loại đỉnh lặp và đỉnh thẳng hàng. Không đổi hình dạng quá tolerance."""
    if len(ring) < 3:
        return list(ring)

    # 1. Bỏ đỉnh trùng liền kề (kể cả đỉnh đóng vòng lặp lại đỉnh đầu).
    deduped: Ring = []
    for point in ring:
        if not deduped or _distance(deduped[-1], point) > POINT_MERGE_TOLERANCE_MM:
            deduped.append(point)
    while len(deduped) >= 2 and _distance(deduped[0], deduped[-1]) <= POINT_MERGE_TOLERANCE_MM:
        deduped.pop()
    if len(deduped) < 3:
        return deduped

    # 2. Bỏ đỉnh thẳng hàng, quét vòng cho tới khi không bỏ được nữa.
    changed = True
    while changed and len(deduped) > 3:
        changed = False
        result: Ring = []
        count = len(deduped)
        for index in range(count):
            previous = deduped[index - 1]
            current = deduped[index]
            following = deduped[(index + 1) % count]
            base = _distance(previous, following)
            if base <= POINT_MERGE_TOLERANCE_MM:
                continue
            cross = abs(
                (current[0] - previous[0]) * (following[1] - previous[1])
                - (current[1] - previous[1]) * (following[0] - previous[0])
            )
            if cross / base <= COLLINEAR_TOLERANCE_MM:
                changed = True
                continue
            result.append(current)
        if len(result) >= 3:
            deduped = result
        else:
            break
    return deduped


def _segments_cross(a1: Point, a2: Point, b1: Point, b2: Point) -> bool:
    def orientation(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1 = orientation(b1, b2, a1)
    d2 = orientation(b1, b2, a2)
    d3 = orientation(a1, a2, b1)
    d4 = orientation(a1, a2, b2)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def is_self_intersecting(ring: Sequence[Point]) -> bool:
    """Vòng có tự cắt không. Chỉ kiểm cặp cạnh **không kề nhau**.

    O(n²) nên chỉ chạy khi số đỉnh dưới ``SELF_INTERSECTION_CHECK_LIMIT``; vòng dày hơn
    được để cho validator Rust kiểm bằng đường quét trục X. Trả ``False`` khi bỏ kiểm là
    **không** nói "vòng sạch" — nó nói "chưa kết luận ở tầng này", và Rust vẫn từ chối
    sau. Ghi rõ để không ai coi đây là bảo đảm.
    """
    count = len(ring)
    if count < 4 or count > SELF_INTERSECTION_CHECK_LIMIT:
        return False
    for i in range(count):
        a1 = ring[i]
        a2 = ring[(i + 1) % count]
        for j in range(i + 2, count):
            if i == 0 and j == count - 1:
                continue  # hai cạnh kề qua điểm đóng vòng
            b1 = ring[j]
            b2 = ring[(j + 1) % count]
            if _segments_cross(a1, a2, b1, b2):
                return True
    return False


def _point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    inside = False
    count = len(ring)
    for index in range(count):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % count]
        if (y1 > point[1]) != (y2 > point[1]):
            slope = (x2 - x1) * (point[1] - y1) / (y2 - y1) + x1
            if point[0] < slope:
                inside = not inside
    return inside


def _ring_inside(inner: Sequence[Point], outer: Sequence[Point]) -> bool:
    """Vòng trong có nằm trong vòng ngoài không (kiểm bằng mẫu đỉnh)."""
    if not inner or not outer:
        return False
    sample = inner if len(inner) <= 16 else inner[:: max(1, len(inner) // 16)]
    return all(_point_in_ring(point, outer) for point in sample)


# ─────────────────────────────────────────────────────────────────────────────
#  Đọc PDF
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ContourCandidate:
    """Một vòng kín ứng viên trên trang."""

    candidate_id: str
    page_number: int
    outer: Ring
    holes: list[Ring]
    area_mm2: float
    width_mm: float
    height_mm: float
    #: Lý do bị loại, nếu có. ``None`` = dùng được.
    rejected_reason: Optional[str] = None


def _subpaths_of(items: Sequence[Any], page_height_pt: float) -> list[Ring]:
    """Tách `items` của một drawing thành các vòng, đã đổi về mm và lật lại Y.

    Parser dùng hệ riêng với Y đã lật (xem docstring ``parse_content_stream``). Lật lại
    ở đây là bắt buộc: nếu không, contour sẽ **soi gương**, và lật khuôn là điều bị cấm.
    """
    rings: list[Ring] = []
    current: Ring = []

    def to_mm(x_pt: float, y_parser_pt: float) -> Point:
        return (x_pt * _PT_TO_MM, (page_height_pt - y_parser_pt) * _PT_TO_MM)

    def flush() -> None:
        nonlocal current
        if len(current) >= 3:
            rings.append(current)
        current = []

    for item in items:
        kind = item[0]
        if kind == "re":
            flush()
            rect = item[1]
            corners = [
                to_mm(rect.x0, rect.y0),
                to_mm(rect.x1, rect.y0),
                to_mm(rect.x1, rect.y1),
                to_mm(rect.x0, rect.y1),
            ]
            # `re` là vòng đóng ngầm định. Lặp lại đỉnh đầu ở cuối để bước kiểm "vòng có
            # đóng không" nhận ra — nếu không, mọi hình chữ nhật sẽ bị loại oan là hở.
            # `simplify_ring` bỏ lại đỉnh lặp đó ngay sau.
            rings.append([*corners, corners[0]])
            continue

        if kind == "l":
            start = to_mm(item[1].x, item[1].y)
            end = to_mm(item[2].x, item[2].y)
            if not current or _distance(current[-1], start) > POINT_MERGE_TOLERANCE_MM:
                flush()
                current = [start]
            current.append(end)
            continue

        if kind == "c":
            start = to_mm(item[1].x, item[1].y)
            c1 = to_mm(item[2].x, item[2].y)
            c2 = to_mm(item[3].x, item[3].y)
            end = to_mm(item[4].x, item[4].y)
            if not current or _distance(current[-1], start) > POINT_MERGE_TOLERANCE_MM:
                flush()
                current = [start]
            current.extend(flatten_cubic(start, c1, c2, end, FLATTEN_TOLERANCE_MM))
            if len(current) > MAX_RING_VERTICES:
                # Vòng vượt trần: bỏ luôn, không cắt bớt thành hình khác.
                current = []
            continue

    flush()
    return rings


def _classify(rings: Sequence[Ring], page_number: int) -> list[ContourCandidate]:
    """Ghép vòng thành ứng viên: vòng lớn làm contour ngoài, vòng nằm trong làm lỗ."""
    usable: list[tuple[Ring, float]] = []
    rejected: list[tuple[Ring, str]] = []

    for ring in rings:
        simplified = simplify_ring(ring)
        if len(simplified) < 3:
            continue
        # Vòng hở: điểm đầu và cuối cách nhau quá xa ⇒ không phải đường bế kín.
        if _distance(ring[0], ring[-1]) > CLOSE_TOLERANCE_MM:
            rejected.append((simplified, "RING_NOT_CLOSED"))
            continue
        if len(simplified) > MAX_RING_VERTICES:
            rejected.append((simplified, "RING_TOO_MANY_VERTICES"))
            continue
        # Kiểm tự cắt TRƯỚC khi xét diện tích. Lý do đo được: vòng hình nơ
        # `(100,100)→(300,300)→(300,100)→(100,300)` có hai tam giác ngược chiều nên diện
        # tích **có dấu triệt tiêu về 0**. Nếu xét diện tích trước, vòng hỏng đó bị loại
        # IM LẶNG như nhiễu và người dùng không biết file mình sai — đúng thứ §10.9 cấm.
        if is_self_intersecting(simplified):
            rejected.append((simplified, "RING_SELF_INTERSECTING"))
            continue
        area = ring_area_mm2(simplified)
        if area < MIN_RING_AREA_MM2:
            continue  # vòng cực nhỏ: bỏ im lặng, đó là nhiễu không phải lỗi
        usable.append((simplified, area))

    usable.sort(key=lambda pair: pair[1], reverse=True)

    candidates: list[ContourCandidate] = []
    consumed: set[int] = set()
    for index, (ring, area) in enumerate(usable):
        if index in consumed:
            continue
        holes: list[Ring] = []
        for other_index in range(index + 1, len(usable)):
            if other_index in consumed:
                continue
            other_ring, _other_area = usable[other_index]
            if _ring_inside(other_ring, ring):
                holes.append(other_ring)
                consumed.add(other_index)
        min_x, min_y, max_x, max_y = _bounds(ring)
        candidates.append(
            ContourCandidate(
                candidate_id=f"p{page_number}-c{len(candidates) + 1}",
                page_number=page_number,
                outer=[(x - min_x, y - min_y) for x, y in ring],
                holes=[[(x - min_x, y - min_y) for x, y in hole] for hole in holes],
                area_mm2=area,
                width_mm=max_x - min_x,
                height_mm=max_y - min_y,
            )
        )
        if len(candidates) >= MAX_CANDIDATES:
            break

    for ring, reason in rejected[: max(0, MAX_CANDIDATES - len(candidates))]:
        min_x, min_y, max_x, max_y = _bounds(ring)
        candidates.append(
            ContourCandidate(
                candidate_id=f"p{page_number}-x{len(candidates) + 1}",
                page_number=page_number,
                outer=[(x - min_x, y - min_y) for x, y in ring],
                holes=[],
                area_mm2=ring_area_mm2(ring),
                width_mm=max_x - min_x,
                height_mm=max_y - min_y,
                rejected_reason=reason,
            )
        )
    return candidates


def page_box_candidate(width_pt: float, height_pt: float, page_number: int) -> ContourCandidate:
    """Hình chữ nhật theo khổ trang — chỉ dùng khi người dùng xác nhận rõ (§10.6)."""
    width_mm = width_pt * _PT_TO_MM
    height_mm = height_pt * _PT_TO_MM
    return ContourCandidate(
        candidate_id=f"p{page_number}-pagebox",
        page_number=page_number,
        outer=[(0.0, 0.0), (width_mm, 0.0), (width_mm, height_mm), (0.0, height_mm)],
        holes=[],
        area_mm2=width_mm * height_mm,
        width_mm=width_mm,
        height_mm=height_mm,
    )


def extract_candidates(pdf_bytes: bytes) -> tuple[list[ContourCandidate], list[dict[str, Any]]]:
    """Đọc mọi vòng kín ứng viên. Trả ``(ứng viên, thông tin trang)``.

    **Chặn theo byte trước khi mở**: file quá lớn thì lỗi ngay, không nạp vào pikepdf.
    """
    if not pdf_bytes:
        raise SourceError("MIXED_NESTING_SOURCE_EMPTY", "File PDF rỗng.")
    if len(pdf_bytes) > MAX_SOURCE_BYTES:
        raise SourceError(
            "MIXED_NESTING_SOURCE_TOO_LARGE",
            f"File PDF vượt trần {MAX_SOURCE_BYTES // (1024 * 1024)} MB.",
            413,
        )
    if not pdf_bytes.startswith(b"%PDF-"):
        raise SourceError(
            "MIXED_NESTING_SOURCE_NOT_PDF", "Nội dung không phải file PDF."
        )

    import io  # noqa: PLC0415

    import pikepdf  # noqa: PLC0415

    from app.workers.pdf_content_parser import extract_vector_paths  # noqa: PLC0415

    try:
        document = pikepdf.Pdf.open(io.BytesIO(pdf_bytes))
    except Exception as exc:  # noqa: BLE001 - pikepdf ném nhiều loại
        raise SourceError(
            "MIXED_NESTING_SOURCE_UNREADABLE",
            "Không mở được file PDF. File có thể bị hỏng hoặc đang khóa.",
        ) from exc

    candidates: list[ContourCandidate] = []
    pages: list[dict[str, Any]] = []
    try:
        for page_index, page in enumerate(document.pages):
            if page_index >= MAX_PAGES_SCANNED:
                break
            page_number = page_index + 1
            try:
                media = page.mediabox
                width_pt = float(media[2] - media[0])
                height_pt = float(media[3] - media[1])
            except Exception:  # noqa: BLE001
                width_pt = height_pt = 0.0
            pages.append(
                {
                    "pageNumber": page_number,
                    "widthMm": width_pt * _PT_TO_MM,
                    "heightMm": height_pt * _PT_TO_MM,
                }
            )

            try:
                drawings = extract_vector_paths(page, document)
            except Exception:  # noqa: BLE001 - trang lỗi không được giết cả file
                logger.warning(
                    "[MIXED-NESTING] không đọc được đường vector ở trang %d", page_number,
                    exc_info=True,
                )
                continue

            rings: list[Ring] = []
            for drawing in drawings:
                items = drawing.get("items") or []
                if not items:
                    continue
                rings.extend(_subpaths_of(items, height_pt))
            candidates.extend(_classify(rings, page_number))
            if len(candidates) >= MAX_CANDIDATES:
                break
    finally:
        try:
            document.close()
        except Exception:  # noqa: BLE001
            pass

    return candidates, pages


# ─────────────────────────────────────────────────────────────────────────────
#  Băm và registry
# ─────────────────────────────────────────────────────────────────────────────


def geometry_hash(candidate: ContourCandidate) -> str:
    """Băm canonical của hình học.

    Bao **cả version quy tắc làm phẳng** (§9.1): đổi tolerance là đổi contour, nên hash
    phải khác để kết quả cũ không bị dùng lẫn.
    """
    digest = hashlib.sha256()
    digest.update(f"v{FLATTEN_RULE_VERSION}|tol{FLATTEN_TOLERANCE_MM}|".encode())
    for ring in [candidate.outer, *candidate.holes]:
        digest.update(b"R")
        for x, y in ring:
            # 6 chữ số thập phân = 1 nanomet, dưới mọi tolerance của ngành in.
            digest.update(f"{x:.6f},{y:.6f};".encode())
    return digest.hexdigest()


@dataclass
class SourceRecord:
    source_id: str
    owner: str
    status: SourceStatus
    file_name: str
    candidates: list[ContourCandidate]
    pages: list[dict[str, Any]]
    #: Ứng viên đang được chọn. ``None`` khi còn ``ambiguous``.
    selected_candidate_id: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.monotonic)

    def selected(self) -> Optional[ContourCandidate]:
        if self.selected_candidate_id is None:
            return None
        for candidate in self.candidates:
            if candidate.candidate_id == self.selected_candidate_id:
                return candidate
        return None

    def revision(self) -> Optional[str]:
        candidate = self.selected()
        return geometry_hash(candidate) if candidate else None


class MixedNestingSourceRegistry:
    """Giữ contour đã đọc trong RAM, có TTL và cách ly theo owner.

    Không giữ bytes PDF và **không ghi file nào**: lồng ghép chỉ cần polygon.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = SOURCE_TTL_SECONDS,
        max_per_owner: int = MAX_SOURCES_PER_OWNER,
    ) -> None:
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._max_per_owner = max(1, int(max_per_owner))
        self._lock = threading.RLock()
        self._sources: dict[str, SourceRecord] = {}

    def _sweep_locked(self) -> None:
        now = time.monotonic()
        expired = [
            source_id
            for source_id, record in self._sources.items()
            if now - record.updated_at >= self._ttl_seconds
        ]
        for source_id in expired:
            self._sources.pop(source_id, None)

    def register(
        self,
        *,
        owner: str,
        file_name: str,
        candidates: list[ContourCandidate],
        pages: list[dict[str, Any]],
    ) -> SourceRecord:
        usable = [item for item in candidates if item.rejected_reason is None]
        if len(usable) == 1:
            status: SourceStatus = "ready"
            selected = usable[0].candidate_id
        elif len(usable) > 1:
            status = "ambiguous"
            selected = None
        else:
            status = "no_contour"
            selected = None

        record = SourceRecord(
            source_id=secrets.token_hex(16),
            owner=owner,
            status=status,
            file_name=file_name,
            candidates=candidates,
            pages=pages,
            selected_candidate_id=selected,
        )
        with self._lock:
            self._sweep_locked()
            mine = [item for item in self._sources.values() if item.owner == owner]
            if len(mine) >= self._max_per_owner:
                # Bỏ nguồn cũ nhất của chính owner này thay vì từ chối: nguồn chỉ là
                # dữ liệu đọc lại được, và chặn người dùng ở đây không bảo vệ được gì.
                oldest = min(mine, key=lambda item: item.updated_at)
                self._sources.pop(oldest.source_id, None)
            self._sources[record.source_id] = record
        return record

    def get(self, source_id: str, owner: str) -> Optional[SourceRecord]:
        with self._lock:
            self._sweep_locked()
            record = self._sources.get(source_id)
            # Nguồn của owner khác coi như KHÔNG TỒN TẠI — không lộ việc nó có thật.
            if record is None or record.owner != owner:
                return None
            record.updated_at = time.monotonic()
            return record

    def select(self, source_id: str, owner: str, candidate_id: str) -> Optional[SourceRecord]:
        with self._lock:
            record = self._sources.get(source_id)
            if record is None or record.owner != owner:
                return None
            match = next(
                (item for item in record.candidates if item.candidate_id == candidate_id),
                None,
            )
            if match is None:
                raise SourceError(
                    "MIXED_NESTING_CANDIDATE_NOT_FOUND",
                    "Không tìm thấy đường bế đã chọn.",
                    404,
                )
            if match.rejected_reason is not None:
                raise SourceError(
                    "MIXED_NESTING_CANDIDATE_REJECTED",
                    f"Đường bế này không dùng được ({match.rejected_reason}).",
                )
            record.selected_candidate_id = candidate_id
            record.status = "ready"
            record.updated_at = time.monotonic()
            return record

    def accept_page_box(
        self, source_id: str, owner: str, page_number: int
    ) -> Optional[SourceRecord]:
        """Dùng khổ trang làm hình chữ nhật — chỉ khi người dùng xác nhận rõ (§10.6)."""
        with self._lock:
            record = self._sources.get(source_id)
            if record is None or record.owner != owner:
                return None
            page = next(
                (item for item in record.pages if item["pageNumber"] == page_number), None
            )
            if page is None:
                raise SourceError(
                    "MIXED_NESTING_PAGE_NOT_FOUND", "Không có trang này trong file.", 404
                )
            candidate = ContourCandidate(
                candidate_id=f"p{page_number}-pagebox",
                page_number=page_number,
                outer=[
                    (0.0, 0.0),
                    (page["widthMm"], 0.0),
                    (page["widthMm"], page["heightMm"]),
                    (0.0, page["heightMm"]),
                ],
                holes=[],
                area_mm2=page["widthMm"] * page["heightMm"],
                width_mm=page["widthMm"],
                height_mm=page["heightMm"],
            )
            record.candidates = [
                item for item in record.candidates if item.candidate_id != candidate.candidate_id
            ]
            record.candidates.append(candidate)
            record.selected_candidate_id = candidate.candidate_id
            record.status = "ready"
            record.updated_at = time.monotonic()
            return record

    def delete(self, source_id: str, owner: str) -> bool:
        with self._lock:
            record = self._sources.get(source_id)
            if record is None or record.owner != owner:
                return False
            self._sources.pop(source_id, None)
            return True

    def count_for_owner(self, owner: str) -> int:
        with self._lock:
            self._sweep_locked()
            return sum(1 for item in self._sources.values() if item.owner == owner)

    def clear(self) -> None:
        with self._lock:
            self._sources.clear()


#: Singleton dùng ở route. Test tạo registry riêng rồi monkeypatch vào module route.
mixed_nesting_sources = MixedNestingSourceRegistry()


def parse_source(
    *,
    owner: str,
    file_name: str,
    pdf_bytes: bytes,
    registry: Optional[MixedNestingSourceRegistry] = None,
) -> SourceRecord:
    """Đường đi đầy đủ: bytes → contour → registry. **Chặn thread gọi.**

    Nơi gọi phải đẩy qua threadpool; hàm này cố ý không tự tạo thread.

    ``registry`` để test tiêm bản riêng; mặc định dùng singleton.
    """
    candidates, pages = extract_candidates(pdf_bytes)
    target = registry if registry is not None else mixed_nesting_sources
    return target.register(
        owner=owner, file_name=file_name, candidates=candidates, pages=pages
    )

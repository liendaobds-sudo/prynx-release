"""Primitive PDF Form cho placement affine của nesting production.

Nhánh này chỉ nhận dữ liệu đã khóa bởi RenderBundle V2. Nó không solve, không suy
rectangle đích và không lượng tử góc về cardinal. Trang nguồn được nhúng như một
Form raw; mọi phép /Rotate, /UserUnit, pose và lật tờ chỉ xuất hiện đúng một lần
trong ma trận ngoài của từng placement.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

import pikepdf

from app.core.perf_sampler import (
    finish_perf_stage,
    increment_perf_counter,
    start_perf_stage,
)
from app.workers.imposition_affine import Affine2D
from app.workers.pdf_ops import _register_form_ocgs

logger = logging.getLogger(__name__)


PT_PER_MM = 72.0 / 25.4
MM_PER_PT = 25.4 / 72.0
RAW_FORM_PRIMITIVE_VERSION = "nesting-raw-form-v1"
RAW_FORM_BBOX_POLICY = "media-box"
RAW_FORM_VARIANT = "artwork-raw"

#: Biến thể artwork **đã bỏ nét bế**.
#:
#: FIX (audit 2026-08-28 §NEST-STRIP-DIE): nguồn tem bế mang nét CutContour trong chính
#: artwork. Đường cũ gọi `nup_artwork.strip_color_from_stream` để bỏ nét đó khỏi trang in;
#: renderer nesting thì paint nguyên trang nguồn, nên **đường bế bị in lên trang in** —
#: đúng lỗi người dùng báo. Biến thể này materialize thật: nhúng Form rồi bỏ nét bế trong
#: chính content stream của Form đã nhúng, chứ không đổi cache key để giả lập.
DIE_STRIPPED_FORM_VARIANT = "artwork-die-stripped"
DIE_STRIP_POLICY_VERSION = "nesting-die-strip-v1"
IMAGE_NORMALIZER_POLICY_VERSION = "adobe-embed-v1"
OCG_IMPORT_POLICY_VERSION = "pdf-ops-ocg-v1-strict-check"

_IDENTITY_PATTERN = re.compile(r"^[^\x00-\x1f\x7f]{1,256}$")
_SOURCE_REVISION_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_QUANTUM = Decimal("0.000001")
_PAGE_BINDING_FIELDS = frozenset(
    {
        "pageIndex",
        "pageBoxesMm",
        "userUnit",
        "rotateDeg",
        "sourcePageToCanonical",
        "sourceReferencePointMm",
    }
)
_PAGE_BOX_FIELDS = frozenset({"mediaBox", "cropBox", "trimBox"})


class ManifestPdfFormError(ValueError):
    """RenderBundle/source PDF không còn thỏa hợp đồng Form production."""

    code = "NESTING_PDF_FORM_CONTRACT_INVALID"
    status_code = 422


def _finite(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ManifestPdfFormError(f"{field} phải là số hữu hạn.")
    result = float(value)
    if not math.isfinite(result):
        raise ManifestPdfFormError(f"{field} phải là số hữu hạn.")
    return 0.0 if result == 0.0 else result


def _q6(value: Any, field: str) -> float:
    try:
        decimal_value = Decimal(str(value))
        if not decimal_value.is_finite():
            raise ManifestPdfFormError(f"{field} phải là số hữu hạn.")
        with localcontext() as context:
            context.prec = max(50, len(decimal_value.as_tuple().digits) + 24)
            rounded = decimal_value.quantize(_QUANTUM, rounding=ROUND_HALF_EVEN)
    except (InvalidOperation, TypeError, ValueError, OverflowError) as exc:
        raise ManifestPdfFormError(
            f"{field} không thể chuẩn hóa 6 chữ số."
        ) from exc
    result = float(rounded)
    return 0.0 if result == 0.0 else result


def _exact_mapping(
    value: Any, expected: frozenset[str], field: str
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManifestPdfFormError(f"{field} phải là object.")
    missing = expected.difference(value)
    unknown = set(value).difference(expected)
    if missing or unknown:
        details = []
        if missing:
            details.append("thiếu " + ", ".join(sorted(missing)))
        if unknown:
            details.append("có field lạ " + ", ".join(sorted(unknown)))
        raise ManifestPdfFormError(f"{field} {'; '.join(details)}.")
    return value


def _box4(value: Any, field: str) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ManifestPdfFormError(f"{field} phải có đúng bốn tọa độ.")
    box = tuple(_finite(item, f"{field}[{index}]") for index, item in enumerate(value))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ManifestPdfFormError(f"{field} có chiều rộng/chiều cao không dương.")
    return box


def _point2(value: Any, field: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ManifestPdfFormError(f"{field} phải có đúng hai tọa độ.")
    return (_finite(value[0], f"{field}[0]"), _finite(value[1], f"{field}[1]"))


@dataclass(frozen=True, slots=True)
class ManifestPageBinding:
    """PageBinding V2 đã đóng băng, dùng trực tiếp bởi writer."""

    page_index: int
    media_box_mm: tuple[float, float, float, float]
    crop_box_mm: tuple[float, float, float, float]
    trim_box_mm: tuple[float, float, float, float]
    user_unit: float
    rotate_deg: int
    source_page_to_canonical: Affine2D
    source_reference_point_mm: tuple[float, float]

    @classmethod
    def from_mapping(cls, raw: Any, *, field: str = "pageBinding") -> "ManifestPageBinding":
        binding = _exact_mapping(raw, _PAGE_BINDING_FIELDS, field)
        page_index = binding["pageIndex"]
        if isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
            raise ManifestPdfFormError(f"{field}.pageIndex không hợp lệ.")
        boxes = _exact_mapping(
            binding["pageBoxesMm"], _PAGE_BOX_FIELDS, f"{field}.pageBoxesMm"
        )
        user_unit = _finite(binding["userUnit"], f"{field}.userUnit")
        if not 0.0 < user_unit <= 75000.0:
            raise ManifestPdfFormError(
                f"{field}.userUnit phải lớn hơn 0 và không vượt 75000."
            )
        rotate_deg = binding["rotateDeg"]
        if (
            isinstance(rotate_deg, bool)
            or not isinstance(rotate_deg, int)
            or rotate_deg not in {0, 90, 180, 270}
        ):
            raise ManifestPdfFormError(
                f"{field}.rotateDeg chỉ nhận 0, 90, 180 hoặc 270."
            )
        return cls(
            page_index=page_index,
            media_box_mm=_box4(boxes["mediaBox"], f"{field}.pageBoxesMm.mediaBox"),
            crop_box_mm=_box4(boxes["cropBox"], f"{field}.pageBoxesMm.cropBox"),
            trim_box_mm=_box4(boxes["trimBox"], f"{field}.pageBoxesMm.trimBox"),
            user_unit=user_unit,
            rotate_deg=rotate_deg,
            source_page_to_canonical=Affine2D.from_sequence(
                binding["sourcePageToCanonical"],
                field=f"{field}.sourcePageToCanonical",
            ),
            source_reference_point_mm=_point2(
                binding["sourceReferencePointMm"],
                f"{field}.sourceReferencePointMm",
            ),
        )

    def fingerprint(self) -> str:
        payload = {
            "pageIndex": self.page_index,
            "pageBoxesMm": {
                "mediaBox": self.media_box_mm,
                "cropBox": self.crop_box_mm,
                "trimBox": self.trim_box_mm,
            },
            "userUnit": self.user_unit,
            "rotateDeg": self.rotate_deg,
            "sourcePageToCanonical": self.source_page_to_canonical.as_tuple(),
            "sourceReferencePointMm": self.source_reference_point_mm,
        }
        canonical = json.dumps(
            payload,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
        return hashlib.sha256(canonical).hexdigest()


@dataclass(frozen=True, slots=True)
class EmbeddedManifestForm:
    xobject: Any
    resource_name: Any
    cache_key: tuple[Any, ...]
    raw_media_box: tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class PaintedManifestForm:
    resource_name: str
    matrix_pdf: Affine2D
    clip_rings_pdf: tuple[tuple[tuple[float, float], ...], ...]
    cache_key: tuple[Any, ...]


def _inherited(page: pikepdf.Page, key: str) -> Any:
    node = page.obj
    seen: set[tuple[int, int] | int] = set()
    for _depth in range(64):
        marker = getattr(node, "objgen", None)
        identity: tuple[int, int] | int = (
            tuple(marker) if marker and tuple(marker) != (0, 0) else id(node)
        )
        if identity in seen:
            raise ManifestPdfFormError("Pages tree nguồn có vòng lặp.")
        seen.add(identity)
        value = node.get(key)
        if value is not None:
            return value
        node = node.get("/Parent")
        if node is None:
            return None
    raise ManifestPdfFormError("Pages tree nguồn vượt giới hạn kế thừa.")


def _raw_box(value: Any, field: str) -> tuple[float, float, float, float]:
    try:
        values = list(value)
    except (TypeError, ValueError) as exc:
        raise ManifestPdfFormError(f"{field} không phải PageBox.") from exc
    return _box4(values, field)


def _physical_box_mm(
    raw_box: Sequence[float], user_unit: float, field: str
) -> tuple[float, float, float, float]:
    scale = Decimal(str(user_unit)) * Decimal("25.4") / Decimal("72")
    return tuple(
        _q6(Decimal(str(value)) * scale, f"{field}[{index}]")
        for index, value in enumerate(raw_box)
    )


def _expected_source_affine(
    media_box_mm: Sequence[float], rotate_deg: int
) -> tuple[float, float, float, float, float, float]:
    x0, y0, x1, y1 = media_box_mm
    if rotate_deg == 0:
        values = (1.0, 0.0, 0.0, 1.0, -x0, -y0)
    elif rotate_deg == 90:
        values = (0.0, -1.0, 1.0, 0.0, -y0, x1)
    elif rotate_deg == 180:
        values = (-1.0, 0.0, 0.0, -1.0, x1, y1)
    else:
        values = (0.0, 1.0, -1.0, 0.0, y1, -x0)
    return tuple(_q6(value, f"sourcePageToCanonical[{index}]") for index, value in enumerate(values))


def validate_source_page_binding(
    source_pdf: pikepdf.Pdf, binding: ManifestPageBinding
) -> tuple[pikepdf.Page, tuple[float, float, float, float]]:
    """Đối chiếu PageBinding với chính PDF đã pin trước khi nhúng Form."""

    if not isinstance(binding, ManifestPageBinding):
        raise ManifestPdfFormError("binding phải là ManifestPageBinding đã kiểm chứng.")
    if binding.page_index >= len(source_pdf.pages):
        raise ManifestPdfFormError("pageIndex vượt số trang PDF nguồn đã resolve.")
    page = source_pdf.pages[binding.page_index]
    if page.obj.get("/Matrix") is not None:
        raise ManifestPdfFormError(
            "Trang nguồn có /Matrix ngoài hợp đồng RenderBundle; không thể render an toàn."
        )

    raw_media_value = _inherited(page, "/MediaBox")
    if raw_media_value is None:
        raise ManifestPdfFormError("Trang nguồn thiếu MediaBox.")
    raw_media = _raw_box(raw_media_value, "source.MediaBox")
    raw_crop_value = _inherited(page, "/CropBox")
    raw_crop = raw_media if raw_crop_value is None else _raw_box(
        raw_crop_value, "source.CropBox"
    )
    raw_trim_value = _inherited(page, "/TrimBox")
    raw_trim = raw_crop if raw_trim_value is None else _raw_box(
        raw_trim_value, "source.TrimBox"
    )

    actual_user_unit = _q6(page.obj.get("/UserUnit", 1), "source.UserUnit")
    if not 0.0 < actual_user_unit <= 75000.0:
        raise ManifestPdfFormError("Trang nguồn có UserUnit ngoài miền.")
    raw_rotate = _inherited(page, "/Rotate")
    raw_rotate = 0 if raw_rotate is None else raw_rotate
    rotate_number = _finite(raw_rotate, "source.Rotate")
    rotate_integer = round(rotate_number)
    if abs(rotate_number - rotate_integer) > 1e-9 or rotate_integer % 90 != 0:
        raise ManifestPdfFormError("Trang nguồn có Rotate không hợp lệ.")
    actual_rotate = int(rotate_integer) % 360

    actual_boxes = (
        _physical_box_mm(raw_media, actual_user_unit, "source.mediaBoxMm"),
        _physical_box_mm(raw_crop, actual_user_unit, "source.cropBoxMm"),
        _physical_box_mm(raw_trim, actual_user_unit, "source.trimBoxMm"),
    )
    expected_boxes = (
        binding.media_box_mm,
        binding.crop_box_mm,
        binding.trim_box_mm,
    )
    if (
        actual_user_unit != binding.user_unit
        or actual_rotate != binding.rotate_deg
        or actual_boxes != expected_boxes
        or _expected_source_affine(actual_boxes[0], actual_rotate)
        != binding.source_page_to_canonical.as_tuple()
    ):
        raise ManifestPdfFormError(
            "PDF nguồn không còn khớp PageBinding bất biến của manifest."
        )
    return page, raw_media


def _clean_identity(value: Any, field: str, *, revision: bool = False) -> str:
    pattern = _SOURCE_REVISION_PATTERN if revision else _IDENTITY_PATTERN
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ManifestPdfFormError(f"{field} không phải định danh canonical hợp lệ.")
    return value


@contextmanager
def _verified_source_pdf(
    source_path: str | Path, source_revision: str
) -> Iterator[pikepdf.Pdf]:
    """Mở đúng snapshot có byte hash đã ghim; không nhận Pdf tùy ý từ caller."""

    try:
        path = Path(source_path)
    except TypeError as exc:
        raise ManifestPdfFormError("sourcePath không phải đường dẫn PDF hợp lệ.") from exc
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source_stream:
            for chunk in iter(lambda: source_stream.read(1024 * 1024), b""):
                digest.update(chunk)
            actual_revision = "sha256:" + digest.hexdigest()
            if actual_revision != source_revision:
                raise ManifestPdfFormError(
                    "PDF nguồn không khớp sourceRevision đã ghim trong manifest."
                )
            source_stream.seek(0)
            try:
                source_pdf = pikepdf.Pdf.open(source_stream)
            except Exception as exc:
                raise ManifestPdfFormError(
                    "Không mở được PDF nguồn đã ghim bằng parser strict."
                ) from exc
            try:
                yield source_pdf
            finally:
                source_pdf.close()
    except ManifestPdfFormError:
        raise
    except OSError as exc:
        raise ManifestPdfFormError("Không đọc được PDF nguồn đã ghim.") from exc


def _collect_form_ocgs(form: Any) -> list[Any]:
    collected: list[Any] = []
    seen: set[tuple[int, int] | int] = set()

    def visit_candidate(candidate: Any) -> None:
        try:
            marker = getattr(candidate, "objgen", None)
            identity: tuple[int, int] | int = (
                tuple(marker) if marker and tuple(marker) != (0, 0) else id(candidate)
            )
            if identity in seen:
                return
            seen.add(identity)
            kind = str(candidate.get("/Type", ""))
            if kind == "/OCG":
                collected.append(candidate)
            elif kind == "/OCMD":
                values = candidate.get("/OCGs", [])
                if isinstance(values, pikepdf.Array):
                    for value in values:
                        visit_candidate(value)
                elif values:
                    visit_candidate(values)
        except Exception as exc:
            raise ManifestPdfFormError("Không đọc được OCG/OCMD trong Form.") from exc

    visited_resources: set[tuple[int, int] | int] = set()

    def walk(resources: Any, depth: int = 0) -> None:
        if not resources:
            return
        if depth > 16:
            raise ManifestPdfFormError("Cây resource Form vượt giới hạn an toàn.")
        marker = getattr(resources, "objgen", None)
        identity: tuple[int, int] | int = (
            tuple(marker) if marker and tuple(marker) != (0, 0) else id(resources)
        )
        if identity in visited_resources:
            return
        visited_resources.add(identity)
        try:
            for _name, value in resources.get("/Properties", {}).items():
                visit_candidate(value)
            for _name, child in resources.get("/XObject", {}).items():
                oc = child.get("/OC")
                if oc is not None:
                    visit_candidate(oc)
                walk(child.get("/Resources", {}), depth + 1)
        except ManifestPdfFormError:
            raise
        except Exception as exc:
            raise ManifestPdfFormError("Không duyệt được resource Form.") from exc

    oc = form.get("/OC")
    if oc is not None:
        visit_candidate(oc)
    walk(form.get("/Resources", {}))
    return collected


def _assert_form_ocgs_registered(destination_pdf: pikepdf.Pdf, form: Any) -> None:
    required = _collect_form_ocgs(form)
    if not required:
        return
    properties = destination_pdf.Root.get("/OCProperties")
    registered = [] if not properties else list(properties.get("/OCGs", []) or [])
    registered_ids = {
        tuple(value.objgen)
        for value in registered
        if getattr(value, "objgen", None) not in (None, (0, 0))
    }
    missing = [
        value
        for value in required
        if tuple(getattr(value, "objgen", (0, 0))) not in registered_ids
    ]
    if missing:
        raise ManifestPdfFormError(
            "Không đăng ký đủ OCG của Form vào catalog PDF đích."
        )


def _die_strip_target(die_filter: Mapping[str, Any]) -> tuple[Any, str | None]:
    """Đổi `cutStyle.sourceFilter` thành cặp `(target_color, target_spot)`.

    Đúng hai tham số mà `nup_artwork.strip_color_from_stream` nhận, để nhánh nesting và
    nhánh cũ nhận diện nét bế theo **cùng** tiêu chí.
    """

    if not isinstance(die_filter, Mapping):
        raise ManifestPdfFormError("cutStyle.sourceFilter phải là object.")
    mode = die_filter.get("mode")
    if mode == "spot":
        names = die_filter.get("spotNames")
        if not isinstance(names, Sequence) or isinstance(names, (str, bytes)) or not names:
            raise ManifestPdfFormError(
                "sourceFilter.spotNames phải là mảng tên kênh không rỗng."
            )
        first = names[0]
        if not isinstance(first, str) or not first.strip():
            raise ManifestPdfFormError("sourceFilter.spotNames chứa tên không hợp lệ.")
        return (None, first.strip())
    if mode == "process":
        process = die_filter.get("processColor")
        if not isinstance(process, Mapping):
            raise ManifestPdfFormError(
                "sourceFilter.mode='process' cần processColor."
            )
        components = process.get("components")
        if (
            not isinstance(components, Sequence)
            or isinstance(components, (str, bytes))
            or not components
        ):
            raise ManifestPdfFormError("processColor.components phải là mảng số.")
        return (tuple(float(value) for value in components), None)
    raise ManifestPdfFormError(f"sourceFilter.mode không hỗ trợ: {mode!r}.")


def _strip_die_from_page(source_page: Any, strip_target: tuple[Any, str | None]) -> None:
    """Bỏ nét bế trên TRANG NGUỒN trước khi biến nó thành Form.

    Tách ở đây, không tách sau khi nhúng: `strip_color_from_stream` là bộ đi content
    stream của lane cũ, nó cần trang thật với `/Resources` đầy đủ. Đo được là gọi nó trên
    Form đã nhúng thì không bỏ được nét nào.
    """

    from app.workers.nup_artwork import strip_color_from_stream

    target_color, target_spot = strip_target
    if target_spot:
        # Đo được: khớp tên kênh là PHÂN BIỆT hoa/thường. File khách khai `CutContour`
        # còn `cutStyle.sourceFilter.spotNames` mặc định là `cutcontour`, nên gọi thẳng
        # thì không bỏ được nét nào. Resolve tên THẬT trên trang trước khi tách.
        target_spot = _resolve_actual_spot_name(source_page, target_spot)
    try:
        strip_color_from_stream(source_page, target_color, target_spot=target_spot)
    except Exception as exc:
        raise ManifestPdfFormError(
            "Không tách được nét bế khỏi artwork; dừng thay vì in đường bế lên trang in."
        ) from exc
    _strip_die_from_form(source_page.obj, (target_color, target_spot))


def _resolve_actual_spot_name(source_page: Any, requested: str) -> str:
    """Tên kênh Separation THẬT trên trang, khớp không phân biệt hoa/thường.

    Trả lại chính `requested` nếu không tìm thấy — để `strip_color_from_stream` tự quyết,
    và để lỗi (nếu có) không bị che bởi một tên tự bịa.
    """

    wanted = requested.strip().lower()
    found: list[str] = []

    def walk(resources: Any, depth: int = 0) -> None:
        if resources is None or depth > 6:
            return
        try:
            spaces = resources.get("/ColorSpace")
        except Exception:
            return
        if spaces is not None:
            try:
                for _key, value in spaces.items():
                    try:
                        if str(value[0]) != "/Separation":
                            continue
                        name = str(value[1]).lstrip("/")
                    except Exception:
                        continue
                    if name.lower() == wanted:
                        found.append(name)
            except Exception:
                pass
        try:
            xobjects = resources.get("/XObject")
        except Exception:
            return
        if xobjects is None:
            return
        try:
            for _name, child in xobjects.items():
                try:
                    if "/Form" not in str(child.get("/Subtype", "")):
                        continue
                    walk(child.get("/Resources"), depth + 1)
                except Exception:
                    continue
        except Exception:
            pass

    try:
        walk(source_page.obj.get("/Resources"))
    except Exception:
        return requested
    return found[0] if found else requested


def _strip_die_from_form(form: Any, strip_target: tuple[Any, str | None]) -> None:
    """Bỏ nét bế khỏi Form đã nhúng, đệ quy vào Form con.

    Import muộn vì `nup_artwork` phụ thuộc module này — import ở đầu file sẽ tạo vòng.
    """

    from app.workers.nup_artwork import strip_color_from_stream

    target_color, target_spot = strip_target
    try:
        strip_color_from_stream(form, target_color, target_spot=target_spot)
    except Exception as exc:
        raise ManifestPdfFormError(
            "Không tách được nét bế khỏi artwork; dừng thay vì in đường bế lên trang in."
        ) from exc

    # Form con: nét bế có thể nằm trong XObject lồng.
    try:
        resources = form.get("/Resources")
        xobjects = None if resources is None else resources.get("/XObject")
        if xobjects is None:
            return
        for _name, child in xobjects.items():
            try:
                if "/Form" not in str(child.get("/Subtype", "")):
                    continue
            except Exception:
                continue
            try:
                strip_color_from_stream(child, target_color, target_spot=target_spot)
            except Exception:
                logger.debug("Không tách nét bế trong Form con.", exc_info=True)
    except Exception:
        logger.debug("Không quét được Form con để tách nét bế.", exc_info=True)


def embed_manifest_page_form(
    destination_pdf: pikepdf.Pdf,
    *,
    source_path: str | Path,
    locator_id: str,
    source_revision: str,
    binding: ManifestPageBinding,
    form_variant: str,
    die_filter: Mapping[str, Any] | None = None,
) -> EmbeddedManifestForm:
    """Nhúng một raw Form đúng một lần cho mỗi source/page/variant.

    ``die_filter`` bắt buộc khi ``form_variant == DIE_STRIPPED_FORM_VARIANT``: nó nói nét
    nào là nét bế (kênh spot hoặc màu process). Không có nó thì không thể tách, và tách
    "giả" là đúng lỗi đã giao ra người dùng.
    """

    # PERF (audit 2026-09-02 §PERF-NEST-06): gom thời gian nhúng Form cho cả job;
    # không log từng placement và helper không đọc clock khi PRYNX_PERF tắt.
    perf_sample = start_perf_stage()
    locator = _clean_identity(locator_id, "locatorId")
    revision = _clean_identity(source_revision, "sourceRevision", revision=True)
    variant = _clean_identity(form_variant, "formVariant")
    if variant not in (RAW_FORM_VARIANT, DIE_STRIPPED_FORM_VARIANT):
        raise ManifestPdfFormError(
            "formVariant chưa được materialize; không được chỉ đổi cache key để giả lập tách CUT."
        )
    strip_target: tuple[Any, str | None] | None = None
    if variant == DIE_STRIPPED_FORM_VARIANT:
        if die_filter is None:
            raise ManifestPdfFormError(
                "Biến thể tách nét bế cần die_filter; thiếu nó thì tách là giả."
            )
        strip_target = _die_strip_target(die_filter)
    cache_key = (
        RAW_FORM_PRIMITIVE_VERSION,
        RAW_FORM_BBOX_POLICY,
        IMAGE_NORMALIZER_POLICY_VERSION,
        OCG_IMPORT_POLICY_VERSION,
        locator,
        revision,
        binding.page_index,
        binding.fingerprint(),
        variant,
        # Đổi tiêu chí nhận diện nét bế là đổi nội dung Form ⇒ phải đổi cache key.
        DIE_STRIP_POLICY_VERSION if strip_target else "",
        repr(strip_target) if strip_target else "",
    )

    cache = getattr(destination_pdf, "_nesting_raw_form_cache", None)
    if cache is None:
        cache = {}
        try:
            destination_pdf._nesting_raw_form_cache = cache
        except Exception as exc:
            raise ManifestPdfFormError(
                "Không tạo được cache Form scoped theo PDF đích."
            ) from exc
    cached = cache.get(cache_key)
    if cached is not None:
        finish_perf_stage(
            perf_sample,
            "writer_embed_s",
            count_name="writer_embed_calls",
        )
        increment_perf_counter("writer_embed_cache_hits")
        return cached

    with _verified_source_pdf(source_path, revision) as source_pdf:
        source_page, raw_media = validate_source_page_binding(source_pdf, binding)
        if strip_target is not None:
            # Lane cũ coalesce trước khi tách nét bế (`nup_artwork` §STRIP_DIECUT), vì
            # parser chỉ đi được một stream. Snapshot là bản copy nên sửa ở đây không
            # chạm file nguồn của khách.
            try:
                source_page.contents_coalesce()
            except Exception as exc:
                raise ManifestPdfFormError(
                    "Không gộp được content stream nguồn để tách nét bế."
                ) from exc
            _strip_die_from_page(source_page, strip_target)
        try:
            form = source_page.as_form_xobject(handle_transformations=False)
        except TypeError as exc:
            raise ManifestPdfFormError(
                "PikePDF hiện tại không hỗ trợ raw Form không biến đổi."
            ) from exc
        except Exception as exc:
            raise ManifestPdfFormError("Không dựng được Form từ trang nguồn.") from exc
        if form.get("/Matrix") is not None:
            raise ManifestPdfFormError(
                "Raw Form bất ngờ chứa /Matrix; dừng để tránh double-transform."
            )
        form["/BBox"] = pikepdf.Array(list(raw_media))

        try:
            form = destination_pdf.copy_foreign(form)
            from app.workers.pdf_image_compat import normalize_adobe_embed_images

            normalize_adobe_embed_images(form)
            _register_form_ocgs(destination_pdf, form, source_pdf)
            _assert_form_ocgs_registered(destination_pdf, form)
        except ManifestPdfFormError:
            raise
        except Exception as exc:
            raise ManifestPdfFormError(
                "Không copy/chuẩn hóa được resource của Form nguồn."
            ) from exc

    digest = hashlib.sha256(repr(cache_key).encode("utf-8")).hexdigest()[:32]
    resource_name = pikepdf.Name(f"/NstXo{digest}")
    embedded = EmbeddedManifestForm(
        xobject=form,
        resource_name=resource_name,
        cache_key=cache_key,
        raw_media_box=raw_media,
    )
    cache[cache_key] = embedded
    finish_perf_stage(
        perf_sample,
        "writer_embed_s",
        count_name="writer_embed_calls",
    )
    increment_perf_counter("writer_embed_cache_misses")
    return embedded


def _output_page_space(
    destination_page: pikepdf.Page,
) -> tuple[float, float, float]:
    if destination_page.obj.get("/Matrix") is not None:
        raise ManifestPdfFormError(
            "Trang đích có /Matrix ngoài hợp đồng renderer production."
        )
    rotate = _inherited(destination_page, "/Rotate")
    rotate = 0 if rotate is None else _finite(rotate, "output.Rotate")
    if round(rotate) % 360 != 0 or abs(rotate - round(rotate)) > 1e-9:
        raise ManifestPdfFormError("Trang đích phải có Rotate=0.")
    media_value = _inherited(destination_page, "/MediaBox")
    if media_value is None:
        raise ManifestPdfFormError("Trang đích thiếu MediaBox.")
    media = _raw_box(media_value, "output.MediaBox")
    output_user_unit = _q6(
        destination_page.obj.get("/UserUnit", 1), "output.UserUnit"
    )
    if not 0.0 < output_user_unit <= 75000.0:
        raise ManifestPdfFormError("Trang đích có UserUnit ngoài miền.")
    return media[0], media[1], output_user_unit


def pdf_form_matrix(
    render_ctm_mm: Affine2D,
    *,
    source_user_unit: float,
    destination_media_origin: Sequence[float] = (0.0, 0.0),
    output_user_unit: float = 1.0,
) -> Affine2D:
    """Đổi CTM mm sang toán tử ``cm`` raw-source → output-PDF units."""

    if not isinstance(render_ctm_mm, Affine2D):
        raise ManifestPdfFormError("renderCTM phải là Affine2D đã kiểm chứng.")
    source_unit = _finite(source_user_unit, "source.UserUnit")
    output_unit = _finite(output_user_unit, "output.UserUnit")
    if source_unit <= 0.0 or output_unit <= 0.0:
        raise ManifestPdfFormError("UserUnit nguồn/đích phải lớn hơn 0.")
    origin = _point2(destination_media_origin, "output.MediaBoxOrigin")
    linear_scale = source_unit / output_unit
    translation_scale = PT_PER_MM / output_unit
    return Affine2D(
        render_ctm_mm.a * linear_scale,
        render_ctm_mm.b * linear_scale,
        render_ctm_mm.c * linear_scale,
        render_ctm_mm.d * linear_scale,
        origin[0] + render_ctm_mm.e * translation_scale,
        origin[1] + render_ctm_mm.f * translation_scale,
    )


def _pdf_clip_rings(
    rings_output_mm: Sequence[Sequence[Sequence[Any]]],
    *,
    destination_media_origin: Sequence[float],
    output_user_unit: float,
) -> tuple[tuple[tuple[float, float], ...], ...]:
    origin = _point2(destination_media_origin, "output.MediaBoxOrigin")
    unit = _finite(output_user_unit, "output.UserUnit")
    if unit <= 0.0:
        raise ManifestPdfFormError("output.UserUnit phải lớn hơn 0.")
    if not isinstance(rings_output_mm, (list, tuple)) or not rings_output_mm:
        raise ManifestPdfFormError("artworkClipPath không có ring output.")
    scale = PT_PER_MM / unit
    result = []
    for ring_index, ring in enumerate(rings_output_mm):
        if not isinstance(ring, (list, tuple)) or len(ring) < 3:
            raise ManifestPdfFormError(
                f"clipRings[{ring_index}] phải có ít nhất ba điểm."
            )
        points = []
        for point_index, point in enumerate(ring):
            x, y = _point2(point, f"clipRings[{ring_index}][{point_index}]")
            points.append((origin[0] + x * scale, origin[1] + y * scale))
        result.append(tuple(points))
    return tuple(result)


def _format_number(value: float) -> str:
    normalized = 0.0 if abs(value) < 0.5e-9 else value
    return f"{normalized:.9f}"


def _clip_stream(rings_pdf: Sequence[Sequence[Sequence[float]]]) -> str:
    operations: list[str] = []
    for ring in rings_pdf:
        x0, y0 = ring[0]
        operations.append(f"{_format_number(x0)} {_format_number(y0)} m")
        for x, y in ring[1:]:
            operations.append(f"{_format_number(x)} {_format_number(y)} l")
        operations.append("h")
    # NESTING (audit 2026-08-28 §A1c): nonzero winding, khớp lane legacy
    # `pdf_ops._clip_path`. Painter này CHỈ vẽ artwork (`RAW_FORM_VARIANT`), và
    # theo quyết định cổng Chặng 0 thì vùng lỗ vẫn được in mực — nên clip chỉ
    # nhận vòng ngoài từ `build_manifest_clip_rings`. Đổi lại thành `W*` sẽ
    # khoét trắng cửa sổ khuôn, tức đổi hành vi in của mọi job tem/CNC.
    operations.append("W n")
    return "\n".join(operations) + "\n"


def paint_manifest_page_form(
    destination_pdf: pikepdf.Pdf,
    destination_page: pikepdf.Page,
    *,
    source_path: str | Path,
    locator_id: str,
    source_revision: str,
    binding: ManifestPageBinding,
    form_variant: str,
    render_ctm_mm: Affine2D,
    clip_rings_output_mm: Sequence[Sequence[Sequence[Any]]],
    die_filter: Mapping[str, Any] | None = None,
) -> PaintedManifestForm:
    """Clip + paint một placement; không có fallback hình chữ nhật/raster/cardinal."""

    embedded = embed_manifest_page_form(
        destination_pdf,
        source_path=source_path,
        locator_id=locator_id,
        source_revision=source_revision,
        binding=binding,
        form_variant=form_variant,
        die_filter=die_filter,
    )
    # PERF (audit 2026-09-02 §PERF-NEST-06): phase paint loại phần embed để biết
    # riêng chi phí ma trận/clip/resource/content stream, vẫn chỉ xuất số tổng.
    perf_sample = start_perf_stage()
    origin_x, origin_y, output_user_unit = _output_page_space(destination_page)
    matrix = pdf_form_matrix(
        render_ctm_mm,
        source_user_unit=binding.user_unit,
        destination_media_origin=(origin_x, origin_y),
        output_user_unit=output_user_unit,
    )
    clip_rings_pdf = _pdf_clip_rings(
        clip_rings_output_mm,
        destination_media_origin=(origin_x, origin_y),
        output_user_unit=output_user_unit,
    )
    resource_name = destination_page.add_resource(
        embedded.xobject,
        pikepdf.Name.XObject,
        name=embedded.resource_name,
    )
    resource_text = str(resource_name)
    if not resource_text.startswith("/"):
        resource_text = "/" + resource_text
    a, b, c, d, e, f = matrix.as_tuple()
    stream = (
        "q\n"
        + _clip_stream(clip_rings_pdf)
        + " ".join(_format_number(value) for value in (a, b, c, d, e, f))
        + " cm\n"
        + resource_text
        + " Do\nQ\n"
    )
    destination_page.contents_add(
        pikepdf.Stream(destination_pdf, stream.encode("ascii"))
    )
    painted = PaintedManifestForm(
        resource_name=resource_text,
        matrix_pdf=matrix,
        clip_rings_pdf=clip_rings_pdf,
        cache_key=embedded.cache_key,
    )
    finish_perf_stage(
        perf_sample,
        "writer_form_paint_s",
        count_name="writer_form_paint_calls",
    )
    return painted

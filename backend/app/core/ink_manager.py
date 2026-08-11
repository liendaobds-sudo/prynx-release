"""
Ink Manager Engine — Quản lý kênh mực PDF (Process CMYK + Spot Colors).

Chức năng tương đương Acrobat Pro → Print Production → Ink Manager.
"""
import logging
import asyncio
import copy
import threading
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any

import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)


PROCESS_COLORANTS: tuple[tuple[str, list[int]], ...] = (
    ("Cyan", [100, 0, 0, 0]),
    ("Magenta", [0, 100, 0, 0]),
    ("Yellow", [0, 0, 100, 0]),
    ("Black", [0, 0, 0, 100]),
)
_PROCESS_NAMES = {name for name, _cmyk in PROCESS_COLORANTS}
_INVENTORY_CACHE: OrderedDict[tuple[str, int, int], dict[str, Any]] = OrderedDict()
_INVENTORY_CACHE_LOCK = threading.RLock()


def inventory_cache_capacity_for_ram(total_ram_mb: float | None) -> int:
    """Số tài liệu metadata giữ nóng; máy mạnh tăng theo RAM, không trần cố định."""
    if total_ram_mb is None or total_ram_mb <= 0:
        return 8
    if total_ram_mb < 8 * 1024:
        return 4
    if total_ram_mb < 16 * 1024:
        return 12
    return max(32, int(total_ram_mb // 512))


def _inventory_cache_capacity() -> int:
    from app.core.system_memory import read_memory_status_mb

    total_ram_mb, _available_ram_mb = read_memory_status_mb()
    return inventory_cache_capacity_for_ram(total_ram_mb)


def _pdf_name(value: Any) -> str:
    text = str(value or "")
    return text[1:] if text.startswith("/") else text


def _pdf_mapping(value: Any) -> bool:
    """Dictionary và Stream đều có dictionary keys trong pikepdf."""
    return isinstance(value, (pikepdf.Dictionary, pikepdf.Stream))


def _object_key(value: Any) -> tuple[Any, ...]:
    """Khóa chống vòng lặp cho object gián tiếp và dictionary trực tiếp."""
    try:
        objgen = tuple(value.objgen)
    except (AttributeError, TypeError, ValueError):
        objgen = (0, 0)
    if objgen != (0, 0):
        return ("indirect", *objgen)
    return ("direct", id(value))


def _number_list(value: Any) -> list[float]:
    if not isinstance(value, pikepdf.Array):
        return []
    result: list[float] = []
    for item in value:
        try:
            result.append(float(item))
        except (TypeError, ValueError):
            return []
    return result


def _evaluate_tint_function(function: Any, inputs: list[float]) -> list[float] | None:
    """Đánh giá các tint transform đơn giản mà không đoán màu theo tên mực.

    FunctionType 2 là dạng Illustrator/Corel dùng phổ biến cho Separation. Type 3
    được hỗ trợ để theo đúng stitching function; Type 0/4 chưa được diễn giải ở
    lớp metadata và sẽ trả ``None`` thay vì bịa một alternate color.
    """
    if isinstance(function, pikepdf.Array):
        values: list[float] = []
        for child in function:
            evaluated = _evaluate_tint_function(child, inputs)
            if not evaluated:
                return None
            values.extend(evaluated)
        return values
    if not _pdf_mapping(function):
        return None
    try:
        function_type = int(function.get("/FunctionType", -1))
    except (TypeError, ValueError):
        return None
    if function_type == 2:
        if not inputs:
            return None
        x = max(0.0, min(1.0, float(inputs[0])))
        c0 = _number_list(function.get("/C0")) or [0.0]
        c1 = _number_list(function.get("/C1")) or [1.0] * len(c0)
        if len(c0) != len(c1):
            return None
        try:
            exponent = float(function.get("/N", 1.0))
        except (TypeError, ValueError):
            return None
        factor = x ** exponent
        return [a + factor * (b - a) for a, b in zip(c0, c1)]
    if function_type == 3:
        children = function.get("/Functions")
        if not isinstance(children, pikepdf.Array) or not children or not inputs:
            return None
        x = float(inputs[0])
        domain = _number_list(function.get("/Domain")) or [0.0, 1.0]
        bounds = _number_list(function.get("/Bounds"))
        encode = _number_list(function.get("/Encode"))
        if len(domain) < 2 or len(encode) < len(children) * 2:
            return None
        edges = [domain[0], *bounds, domain[1]]
        child_index = len(children) - 1
        for index in range(len(children)):
            if x < edges[index + 1] or index == len(children) - 1:
                child_index = index
                break
        low, high = edges[child_index], edges[child_index + 1]
        ratio = 0.0 if high == low else (x - low) / (high - low)
        encoded = encode[child_index * 2] + ratio * (
            encode[child_index * 2 + 1] - encode[child_index * 2]
        )
        return _evaluate_tint_function(children[child_index], [encoded])
    return None


def _alternate_values(space: Any, function: Any) -> dict[str, Any]:
    space_name = _pdf_name(space)
    values = _evaluate_tint_function(function, [1.0])
    result: dict[str, Any] = {
        "alternate_space": space_name or None,
        "alternate_components": values,
        "alternate_cmyk": None,
        "alternate_rgb": None,
    }
    if not values:
        return result
    clipped = [max(0.0, min(1.0, value)) for value in values]
    if space_name == "DeviceCMYK" and len(clipped) >= 4:
        result["alternate_cmyk"] = [round(value * 100, 4) for value in clipped[:4]]
    elif space_name == "DeviceRGB" and len(clipped) >= 3:
        result["alternate_rgb"] = [round(value * 255) for value in clipped[:3]]
    elif space_name == "DeviceGray" and clipped:
        gray = round(clipped[0] * 255)
        result["alternate_rgb"] = [gray, gray, gray]
    return result


def _register_spot(
    records: dict[str, dict[str, Any]],
    page_spots: list[str],
    name: str,
    page_num: int,
    alternate: dict[str, Any] | None = None,
) -> None:
    if not name or name in {"All", "None", *_PROCESS_NAMES}:
        return
    if name not in page_spots:
        page_spots.append(name)
    record = records.setdefault(
        name,
        {
            "name": name,
            "type": "spot",
            "is_spot": True,
            "pages": [],
            "alternate_space": None,
            "alternate_components": None,
            "alternate_cmyk": None,
            "alternate_rgb": None,
        },
    )
    if page_num not in record["pages"]:
        record["pages"].append(page_num)
    if alternate:
        for key in (
            "alternate_space",
            "alternate_components",
            "alternate_cmyk",
            "alternate_rgb",
        ):
            if record.get(key) is None and alternate.get(key) is not None:
                record[key] = alternate[key]


def _inspect_color_space(
    value: Any,
    page_num: int,
    records: dict[str, dict[str, Any]],
    page_spots: list[str],
    visited: set[tuple[Any, ...]],
) -> None:
    if not isinstance(value, pikepdf.Array) or not value:
        return
    key = ("colorspace", *_object_key(value))
    if key in visited:
        return
    visited.add(key)
    family = _pdf_name(value[0])
    if family == "Separation" and len(value) >= 4:
        name = _pdf_name(value[1])
        _register_spot(
            records,
            page_spots,
            name,
            page_num,
            _alternate_values(value[2], value[3]),
        )
        return
    if family in {"DeviceN", "NChannel"} and len(value) >= 4:
        names = value[1] if isinstance(value[1], pikepdf.Array) else []
        for item in names:
            _register_spot(records, page_spots, _pdf_name(item), page_num)
        # DeviceN/NChannel thường khai alternate riêng từng mực trong /Colorants.
        if len(value) >= 5 and isinstance(value[4], pikepdf.Dictionary):
            colorants = value[4].get("/Colorants")
            if isinstance(colorants, pikepdf.Dictionary):
                for _key, colorant_space in colorants.items():
                    _inspect_color_space(
                        colorant_space, page_num, records, page_spots, visited
                    )
        return
    if family in {"Indexed", "I"} and len(value) >= 2:
        _inspect_color_space(value[1], page_num, records, page_spots, visited)
    elif family == "Pattern" and len(value) >= 2:
        _inspect_color_space(value[1], page_num, records, page_spots, visited)


def _blend_space(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, pikepdf.Array) and value:
        return _pdf_name(value[0]) or None
    name = _pdf_name(value)
    return name or None


def _mark_transparency_group(group: Any, state: dict[str, Any]) -> None:
    if not isinstance(group, pikepdf.Dictionary):
        return
    if _pdf_name(group.get("/S")) != "Transparency":
        return
    state["page_has_transparency"] = True
    space = _blend_space(group.get("/CS"))
    if space and state.get("blending_color_space") is None:
        state["blending_color_space"] = space


def _has_non_normal_blend(value: Any) -> bool:
    values = list(value) if isinstance(value, pikepdf.Array) else [value]
    return any(_pdf_name(item) not in {"", "Normal", "Compatible"} for item in values)


def _walk_resources(
    resources: Any,
    page_num: int,
    records: dict[str, dict[str, Any]],
    page_spots: list[str],
    state: dict[str, Any],
    visited: set[tuple[Any, ...]],
) -> None:
    if not isinstance(resources, pikepdf.Dictionary):
        return
    key = ("resources", *_object_key(resources))
    if key in visited:
        return
    visited.add(key)

    color_spaces = resources.get("/ColorSpace")
    if isinstance(color_spaces, pikepdf.Dictionary):
        for _key, color_space in color_spaces.items():
            _inspect_color_space(
                color_space, page_num, records, page_spots, visited
            )

    ext_gstates = resources.get("/ExtGState")
    if isinstance(ext_gstates, pikepdf.Dictionary):
        for _key, gstate in ext_gstates.items():
            if not isinstance(gstate, pikepdf.Dictionary):
                continue
            try:
                fill_alpha = float(gstate.get("/ca", 1.0))
                stroke_alpha = float(gstate.get("/CA", 1.0))
            except (TypeError, ValueError):
                fill_alpha = stroke_alpha = 1.0
            smask = _pdf_name(gstate.get("/SMask"))
            if (
                fill_alpha < 0.9999
                or stroke_alpha < 0.9999
                or (smask and smask != "None")
                or _has_non_normal_blend(gstate.get("/BM"))
            ):
                state["page_has_transparency"] = True

    xobjects = resources.get("/XObject")
    if isinstance(xobjects, pikepdf.Dictionary):
        for _key, xobject in xobjects.items():
            if not _pdf_mapping(xobject):
                continue
            _mark_transparency_group(xobject.get("/Group"), state)
            smask = _pdf_name(xobject.get("/SMask"))
            if smask and smask != "None":
                state["page_has_transparency"] = True
            if _pdf_name(xobject.get("/Subtype")) == "Form":
                _walk_resources(
                    xobject.get("/Resources"),
                    page_num,
                    records,
                    page_spots,
                    state,
                    visited,
                )

    patterns = resources.get("/Pattern")
    if isinstance(patterns, pikepdf.Dictionary):
        for _key, pattern in patterns.items():
            if _pdf_mapping(pattern):
                _walk_resources(
                    pattern.get("/Resources"),
                    page_num,
                    records,
                    page_spots,
                    state,
                    visited,
                )

    shadings = resources.get("/Shading")
    if isinstance(shadings, pikepdf.Dictionary):
        for _key, shading in shadings.items():
            if _pdf_mapping(shading):
                _inspect_color_space(
                    shading.get("/ColorSpace"),
                    page_num,
                    records,
                    page_spots,
                    visited,
                )


def _analyze_ink_inventory_uncached(file_path: str) -> dict[str, Any]:
    """Đọc inventory mực + metadata trang bằng resource traversal thật.

    PREFLIGHT (audit 2026-08-10 §OP.2/4/5): regex trên chuỗi page dictionary bỏ
    mọi colorspace nằm trong resource gián tiếp/Form XObject. Hàm này đi đúng cây
    Resources của từng trang, giữ riêng inventory tài liệu và sự hiện diện theo
    trang, đồng thời lấy alternate color từ tint transform khi PDF khai được.
    """
    spot_records: dict[str, dict[str, Any]] = {}
    page_records: list[dict[str, Any]] = []
    with pikepdf.Pdf.open(file_path) as doc:
        total_pages = len(doc.pages)
        for page_index, page in enumerate(doc.pages):
            page_num = page_index + 1
            page_spots: list[str] = []
            state: dict[str, Any] = {
                "page_has_transparency": False,
                "blending_color_space": None,
            }
            _mark_transparency_group(page.obj.get("/Group"), state)
            try:
                resources = page.resources
            except (AttributeError, KeyError, RuntimeError):
                resources = page.obj.get("/Resources")
            try:
                _walk_resources(
                    resources,
                    page_num,
                    spot_records,
                    page_spots,
                    state,
                    set(),
                )
            except (AttributeError, KeyError, RuntimeError, TypeError, ValueError) as exc:
                logger.debug("Không đọc trọn resource trang %d: %s", page_num, exc)
            page_records.append(
                {
                    "page": page_num,
                    "colorants": [name for name, _cmyk in PROCESS_COLORANTS] + page_spots,
                    "spot_colorants": page_spots,
                    **state,
                }
            )

    all_pages = list(range(1, total_pages + 1))
    document_colorants: list[dict[str, Any]] = [
        {
            "name": name,
            "type": "process",
            "is_spot": False,
            "pages": all_pages,
            "page_count": total_pages,
            "alternate_space": "DeviceCMYK",
            "alternate_components": [value / 100 for value in cmyk],
            "alternate_cmyk": cmyk,
            "alternate_rgb": None,
        }
        for name, cmyk in PROCESS_COLORANTS
    ]
    for record in spot_records.values():
        record["page_count"] = len(record["pages"])
        document_colorants.append(record)
    return {
        "total_pages": total_pages,
        "document_colorants": document_colorants,
        "pages": page_records,
        "metadata_source": "pdf_resources",
    }


def analyze_ink_inventory(file_path: str) -> dict[str, Any]:
    """Bản public có cache theo path + size + mtime, an toàn khi Save/Replace.

    PERF (audit 2026-08-10 §OP.5): traversal Form XObject là chi phí theo toàn
    tài liệu và inventory không đổi khi chuyển trang. Cache chỉ giữ metadata nhỏ;
    tier RAM thấp giảm số tài liệu, máy >=16 GB tăng tuyến tính theo RAM.
    """
    path = Path(file_path).resolve()
    before = path.stat()
    key = (str(path), int(before.st_size), int(before.st_mtime_ns))
    with _INVENTORY_CACHE_LOCK:
        cached = _INVENTORY_CACHE.get(key)
        if cached is not None:
            _INVENTORY_CACHE.move_to_end(key)
            return copy.deepcopy(cached)

    result = _analyze_ink_inventory_uncached(str(path))
    after = path.stat()
    after_key = (str(path), int(after.st_size), int(after.st_mtime_ns))
    if after_key != key:
        # File bị Save/Replace trong lúc quét: bỏ snapshot lai và đọc lại một lần.
        result = _analyze_ink_inventory_uncached(str(path))
        key = after_key

    with _INVENTORY_CACHE_LOCK:
        stale_keys = [item for item in _INVENTORY_CACHE if item[0] == str(path) and item != key]
        for stale_key in stale_keys:
            _INVENTORY_CACHE.pop(stale_key, None)
        _INVENTORY_CACHE[key] = copy.deepcopy(result)
        _INVENTORY_CACHE.move_to_end(key)
        capacity = _inventory_cache_capacity()
        while len(_INVENTORY_CACHE) > capacity:
            _INVENTORY_CACHE.popitem(last=False)
    return result


def colorant_rgb_map(
    colorants: list[dict[str, Any]],
    profile_id: str = "fogra39",
    rendering_intent: str | int = "relative",
) -> dict[str, dict[str, Any]]:
    """Quy alternate color của spot sang sRGB bằng đúng ICC đang mô phỏng."""
    # PREFLIGHT (audit 2026-08-10 §OP.8): swatch spot là một phần của trạng thái
    # Simulation. Không được luôn dùng Relative khi Viewer/Soft-Proof đang dùng
    # intent khác, nếu không cùng một profile vẫn cho ba kết quả màu khác nhau.
    intent_codes = {
        "perceptual": 0,
        "relative": 1,
        "saturation": 2,
        "absolute": 3,
    }
    if isinstance(rendering_intent, int) and not isinstance(rendering_intent, bool):
        intent_code = rendering_intent
    else:
        intent_name = str(rendering_intent or "relative").strip().lower()
        if intent_name not in intent_codes:
            raise ValueError(f"Rendering intent không hợp lệ: {rendering_intent}")
        intent_code = intent_codes[intent_name]
    if intent_code not in intent_codes.values():
        raise ValueError(f"Rendering intent không hợp lệ: {rendering_intent}")

    result: dict[str, dict[str, Any]] = {}
    cmyk_items = [
        item for item in colorants
        if item.get("is_spot") and item.get("alternate_cmyk") is not None
    ]
    for item in colorants:
        if item.get("is_spot") and item.get("alternate_rgb") is not None:
            result[item["name"]] = {
                "rgb": list(item["alternate_rgb"]),
                "source": "tint_transform_alternate_rgb",
            }
    if not cmyk_items:
        return result

    converted: list[tuple[int, int, int]] | None = None
    try:
        from PIL import Image, ImageCms
        from app.core.icc_profiles import (
            resolve_cmyk_profile_path,
            resolve_srgb_profile_path,
        )

        cmyk_path = resolve_cmyk_profile_path(profile_id)
        srgb_path = resolve_srgb_profile_path()
        if cmyk_path and srgb_path:
            transform = ImageCms.buildTransformFromOpenProfiles(
                ImageCms.getOpenProfile(cmyk_path),
                ImageCms.getOpenProfile(srgb_path),
                "CMYK",
                "RGB",
                renderingIntent=ImageCms.Intent(intent_code),
            )
            image = Image.new("CMYK", (len(cmyk_items), 1))
            image.putdata(
                [
                    tuple(round(max(0.0, min(100.0, value)) * 2.55) for value in item["alternate_cmyk"])
                    for item in cmyk_items
                ]
            )
            converted = list(
                ImageCms.applyTransform(image, transform).get_flattened_data()
            )
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        logger.debug("Không quy được alternate CMYK qua ICC %s: %s", profile_id, exc)

    for index, item in enumerate(cmyk_items):
        if converted is not None:
            rgb = [int(value) for value in converted[index]]
            source = "tint_transform_icc"
        else:
            c, m, y, k = [value / 100 for value in item["alternate_cmyk"]]
            rgb = [
                round(255 * (1 - c) * (1 - k)),
                round(255 * (1 - m) * (1 - k)),
                round(255 * (1 - y) * (1 - k)),
            ]
            source = "tint_transform_formula_fallback"
        result[item["name"]] = {"rgb": rgb, "source": source}
    return result


class InkManagerEngine:

    def __init__(self):
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def list_inks(self, file_path: str) -> list[dict]:
        """
        Liệt kê toàn bộ kênh mực trong PDF.
        Returns: list of {name, type, cmyk, density, pages, page_count}
        """
        inventory = analyze_ink_inventory(file_path)
        result: list[dict[str, Any]] = []
        for ink in inventory["document_colorants"]:
            cmyk = ink.get("alternate_cmyk")
            cmyk_known = cmyk is not None
            fallback_cmyk = [0, 0, 0, 50] if ink.get("is_spot") else [0, 0, 0, 0]
            display_cmyk = cmyk or fallback_cmyk
            c, m, y, k = display_cmyk
            # Neutral density approximation (ISO 5)
            density = round(0.3 * c + 0.59 * m + 0.11 * y + k, 1) / 100
            result.append({
                "name": ink["name"],
                "type": ink["type"],
                "cmyk": display_cmyk,
                "cmyk_known": cmyk_known,
                "cmyk_source": "tint_transform" if cmyk_known else "unknown_fallback",
                "alternate_space": ink.get("alternate_space"),
                "density": round(density, 3),
                "pages": list(ink["pages"]),
                "page_count": ink["page_count"],
            })
        return result

    async def convert_spot_to_cmyk(self, file_path: str, spot_name: str | None = None) -> str:
        """
        Chuyển spot color → CMYK vĩnh viễn bằng engine object-level.
        spot_name: None = convert ALL spots.

        Đường object-level thay đúng lệnh tô màu pha bằng CMYK tương đương lấy
        từ chính `tintTransform` của file (§8.6.6.4 — đúng cách spec định nghĩa
        màu pha render trên thiết bị không có kênh đó). Engine chỉ đụng vào
        **những spot được yêu cầu**: `spot_name` cụ thể thì các
        kênh còn lại vẫn sống, còn `pdfwrite -sColorConversionStrategy=CMYK`
        nuốt sạch mọi Separation cùng lúc — kể cả kênh bế mà người dùng đang
        muốn giữ.
        """
        if not Path(file_path).exists():
            raise RuntimeError(f"File PDF không tồn tại: {file_path}")

        output_name = f"{Path(file_path).stem}_cmyk_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)

        try:
            from app.core import icc_profiles, pdf_actions_native

            native = await asyncio.to_thread(
                pdf_actions_native.convert_spot_to_cmyk,
                file_path,
                output_path,
                spot_name,
                icc_profiles.resolve_cmyk_profile_path(),
            )
        except Exception as e:  # noqa: BLE001
            # GS-SUNSET (audit 2026-08-08 §GS.2): lỗi engine nội bộ phải dừng
            # ngay và xóa output dở, không chuyển sang một engine ngoài sản phẩm.
            try:
                Path(output_path).unlink(missing_ok=True)
            except OSError:
                pass
            logger.warning("convert_spot: engine nội bộ lỗi, dừng an toàn: %s", e)
            from app.core.engine_support import (
                InternalEngineUnsupported,
                unsupported_message,
            )

            raise InternalEngineUnsupported(
                unsupported_message("Chuyển màu pha sang CMYK")
            ) from e

        if native is not None and native.get("supported"):
            logger.info(
                "Converted spot→CMYK bằng pikepdf: %s (%d lệnh tô)",
                ", ".join(native.get("converted", [])) or "không có spot nào",
                native.get("ops", 0),
            )
            return output_path

        try:
            Path(output_path).unlink(missing_ok=True)
        except OSError:
            pass
        blockers = "; ".join((native or {}).get("blockers", []))
        logger.info(
            "convert_spot: engine nội bộ không xử lý chắc chắn được (%s)",
            blockers or "không có chi tiết",
        )
        from app.core.engine_support import (
            InternalEngineUnsupported,
            unsupported_message,
        )

        raise InternalEngineUnsupported(
            unsupported_message("Chuyển màu pha sang CMYK")
        )

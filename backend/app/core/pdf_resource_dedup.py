"""Khử trùng lặp tài nguyên PDF (Image XObjects, SMasks).

Module tách ra để dùng chung cho việc ghép chunk (nup_output_finalize, sticker_engine,
mixed_nesting...), giúp tái sử dụng các indirect object stream ảnh giống nhau
thay vì nhân bản dữ liệu rác làm phình file và nghẽn bộ nhớ viewer.
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import pikepdf

logger = logging.getLogger(__name__)


def stable_pdf_object_signature(
    value: Any,
    cache: dict[tuple[str, tuple[int, int]], Any] | None = None,
    active: set[tuple[str, tuple[int, int]]] | None = None,
    depth: int = 0,
) -> Any:
    """Tạo chữ ký ổn định độc lập với số hiệu object trong PDF.

    Signature bao gồm toàn bộ stream dictionary (trừ /Length), các ICC profile lồng nhau,
    soft masks, và hash SHA256 của stream payload.
    Đồ thị quá sâu (> 8) hoặc có chu trình sẽ bị từ chối để an toàn.
    """
    if cache is None:
        cache = {}
    if active is None:
        active = set()
    if depth > 8:
        raise ValueError("PDF resource graph is too deep to deduplicate safely")

    if isinstance(value, pikepdf.Stream):
        object_id = ("stream", value.objgen)
        if value.objgen != (0, 0) and object_id in cache:
            return cache[object_id]
        if object_id in active:
            raise ValueError("Cyclic PDF stream resource")
        active.add(object_id)
        try:
            entries = tuple(
                sorted(
                    (
                        str(key),
                        stable_pdf_object_signature(
                            value.get(key), cache=cache, active=active, depth=depth + 1
                        ),
                    )
                    for key in value.keys()
                    if str(key) != "/Length"
                )
            )
            signature = (
                "stream",
                entries,
                hashlib.sha256(value.read_raw_bytes()).digest(),
            )
        finally:
            active.remove(object_id)
        if value.objgen != (0, 0):
            cache[object_id] = signature
        return signature

    if isinstance(value, pikepdf.Array):
        return (
            "array",
            tuple(
                stable_pdf_object_signature(
                    item, cache=cache, active=active, depth=depth + 1
                )
                for item in value
            ),
        )

    if isinstance(value, pikepdf.Dictionary):
        object_id = ("dict", value.objgen)
        if value.objgen != (0, 0) and object_id in cache:
            return cache[object_id]
        if object_id in active:
            raise ValueError("Cyclic PDF dictionary resource")
        active.add(object_id)
        try:
            signature = (
                "dict",
                tuple(
                    sorted(
                        (
                            str(key),
                            stable_pdf_object_signature(
                                value.get(key),
                                cache=cache,
                                active=active,
                                depth=depth + 1,
                            ),
                        )
                        for key in value.keys()
                        if str(key) != "/Length"
                    )
                ),
            )
        finally:
            active.remove(object_id)
        if value.objgen != (0, 0):
            cache[object_id] = signature
        return signature

    return (type(value).__name__, str(value))


def deduplicate_image_xobjects(pdf: pikepdf.Pdf) -> dict[str, Any]:
    """Nối lại các tham chiếu ảnh/mask giống nhau sau khi ghép PDF từ các worker/chunk.

    Bảo toàn cấu trúc OCG, properties, metadata. Thu hồi tài nguyên không còn tham chiếu.
    """
    started = time.perf_counter()
    signature_cache: dict[tuple[str, tuple[int, int]], Any] = {}
    canonical_by_signature: dict[Any, pikepdf.Stream] = {}
    replacements: dict[tuple[int, int], pikepdf.Stream] = {}
    duplicate_bytes = 0
    image_count = 0

    for obj in list(pdf.objects):
        try:
            if not (
                isinstance(obj, pikepdf.Stream)
                and str(obj.get("/Subtype", "")) == "/Image"
                and obj.objgen != (0, 0)
            ):
                continue
            image_count += 1
            signature = stable_pdf_object_signature(obj, cache=signature_cache)
            canonical = canonical_by_signature.get(signature)
            if canonical is None:
                canonical_by_signature[signature] = obj
            else:
                replacements[obj.objgen] = canonical
                duplicate_bytes += int(obj.get("/Length", 0) or 0)
        except Exception as exc:
            logger.debug("Bỏ qua ứng viên dedup ảnh không an toàn: %s", exc)

    rewired = 0
    if replacements:
        for obj in list(pdf.objects):
            try:
                # 1. Cập nhật /SMask và /Mask trên các Image XObject
                if (
                    isinstance(obj, pikepdf.Stream)
                    and str(obj.get("/Subtype", "")) == "/Image"
                ):
                    for key in ("/SMask", "/Mask"):
                        ref = obj.get(key, None)
                        if isinstance(ref, pikepdf.Stream):
                            canonical = replacements.get(ref.objgen)
                            if canonical is not None:
                                obj[pikepdf.Name(key)] = canonical
                                rewired += 1

                # 2. Cập nhật /Resources -> /XObject trên Pages hoặc Form XObjects
                if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                    continue
                resources = obj.get("/Resources", None)
                if not isinstance(resources, pikepdf.Dictionary):
                    continue
                xobjects = resources.get("/XObject", None)
                if not isinstance(xobjects, pikepdf.Dictionary):
                    continue
                for name in list(xobjects.keys()):
                    ref = xobjects.get(name)
                    if not isinstance(ref, pikepdf.Stream):
                        continue
                    canonical = replacements.get(ref.objgen)
                    if canonical is not None:
                        xobjects[name] = canonical
                        rewired += 1
            except Exception as exc:
                logger.debug("Không thể đi dây lại một tài nguyên ảnh PDF: %s", exc)

        pdf.remove_unreferenced_resources()

    elapsed = time.perf_counter() - started
    return {
        "images": image_count,
        "unique": len(canonical_by_signature),
        "duplicates": len(replacements),
        "rewired": rewired,
        "candidate_bytes": duplicate_bytes,
        "seconds": elapsed,
    }

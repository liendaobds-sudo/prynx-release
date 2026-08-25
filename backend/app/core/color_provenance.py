"""Hợp đồng provenance màu dùng chung cho luồng bù xén và Tách tem.

Module này chỉ mô tả màu và gắn profile cho PDF trung gian đã được xác định là
RGB. Nó không tự đoán profile in cho DeviceCMYK/DeviceN không có OutputIntent.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pikepdf


COLOR_PROVENANCE_SCHEMA = "prynx-color-provenance-v1"
COLOR_PROFILE_MISSING_WARNING = "COLOR_PROFILE_MISSING"
COLOR_PROFILE_MALFORMED_WARNING = "COLOR_PROFILE_MALFORMED"
COLOR_DEVICE_CMYK_FALLBACK_WARNING = "COLOR_DEVICE_CMYK_FALLBACK"
COLOR_DEVICEN_FALLBACK_WARNING = "COLOR_DEVICEN_FALLBACK"


def _stream_bytes(value: Any) -> bytes | None:
    try:
        if isinstance(value, pikepdf.Stream):
            return bytes(value.read_bytes())
    except Exception:
        return None
    return None


def _colorspace_flags(value: Any) -> tuple[bool, bool, bool, bool, bool]:
    """Trả (CMYK, RGB, DeviceN, malformed, ICC-CMYK) cho một ColorSpace."""
    try:
        if isinstance(value, pikepdf.Name):
            name = str(value)
            return (
                name == "/DeviceCMYK",
                name == "/DeviceRGB",
                name in {"/DeviceN", "/Separation"},
                False,
                False,
            )
        if not isinstance(value, pikepdf.Array) or not value:
            return False, False, False, False, False
        head = str(value[0])
        if head == "/ICCBased":
            if len(value) < 2 or not isinstance(value[1], pikepdf.Stream):
                return False, False, False, True, False
            try:
                channels = int(value[1].get("/N", 0))
            except (TypeError, ValueError, OverflowError):
                channels = 0
            return channels == 4, channels == 3, False, channels <= 0, channels == 4
        if head in {"/DeviceCMYK", "/CMYK"}:
            return True, False, False, False, False
        if head in {"/DeviceRGB", "/RGB"}:
            return False, True, False, False, False
        if head in {"/DeviceN", "/Separation"}:
            return False, False, True, False, False
    except Exception:
        return False, False, False, True, False
    return False, False, False, False, False


def _descriptor(
    *,
    source_kind: str,
    profile_state: str,
    has_device_cmyk: bool,
    has_rgb: bool,
    has_devicen: bool,
    has_embedded_cmyk_profile: bool = False,
    output_intent_count: int = 0,
    profile_sha256: str | None = None,
    output_condition_identifier: str | None = None,
    malformed: bool = False,
    error_type: str | None = None,
) -> dict[str, object]:
    warnings: list[str] = []
    if profile_state == "untagged-device-cmyk":
        warnings.append(COLOR_PROFILE_MISSING_WARNING)
    if profile_state == "malformed" or malformed:
        warnings.append(COLOR_PROFILE_MALFORMED_WARNING)
    result: dict[str, object] = {
        "schema": COLOR_PROVENANCE_SCHEMA,
        "source_kind": source_kind,
        "profile_state": profile_state,
        "has_device_cmyk": bool(has_device_cmyk),
        "has_rgb": bool(has_rgb),
        "has_devicen": bool(has_devicen),
        "has_embedded_cmyk_profile": bool(has_embedded_cmyk_profile),
        "output_intent_count": int(output_intent_count),
        "output_intent_profile_sha256": profile_sha256,
        "output_condition_identifier": output_condition_identifier,
        "warnings": warnings,
    }
    if error_type:
        result["error_type"] = error_type
    return result


def describe_pdf_color_provenance(pdf: pikepdf.Pdf) -> dict[str, object]:
    """Đọc profile và colorspace của PDF đang mở, không render/không sửa file."""
    has_cmyk = False
    has_rgb = False
    has_devicen = False
    has_embedded_cmyk_profile = False
    malformed = False
    try:
        # pikepdf.objects bao gồm Image/Form XObject lồng trong resource của trang.
        for obj in pdf.objects:
            if not isinstance(obj, pikepdf.Stream):
                continue
            cmyk, rgb, devicen, bad, embedded_cmyk = _colorspace_flags(
                obj.get("/ColorSpace")
            )
            has_cmyk |= cmyk
            has_rgb |= rgb
            has_devicen |= devicen
            malformed |= bad
            has_embedded_cmyk_profile |= embedded_cmyk
    except Exception:
        malformed = True

    profile_sha256: str | None = None
    output_condition: str | None = None
    intent_count = 0
    valid_profile_count = 0
    try:
        intents = pdf.Root.get("/OutputIntents")
        if intents:
            intent_count = len(intents)
            for intent in intents:
                payload = _stream_bytes(intent.get("/DestOutputProfile"))
                if payload:
                    valid_profile_count += 1
                    # Có nhiều intent thì fingerprint intent đầu tiên theo chuẩn PDF.
                    if profile_sha256 is None:
                        profile_sha256 = hashlib.sha256(payload).hexdigest()
                if output_condition is None and intent.get("/OutputConditionIdentifier") is not None:
                    output_condition = str(intent.get("/OutputConditionIdentifier"))
    except Exception:
        malformed = True

    if valid_profile_count:
        state = "tagged"
    elif intent_count:
        state = "malformed"
    elif has_embedded_cmyk_profile:
        # ICCBased CMYK trong chính XObject là provenance hợp lệ dù catalog
        # không có OutputIntent; không được coi nó như DeviceCMYK trần.
        state = "tagged"
    elif has_cmyk or has_devicen:
        state = "untagged-device-cmyk"
    elif has_rgb:
        state = "rgb"
    else:
        state = "unknown"
    return _descriptor(
        source_kind="pdf",
        profile_state=state,
        has_device_cmyk=has_cmyk,
        has_rgb=has_rgb,
        has_devicen=has_devicen,
        has_embedded_cmyk_profile=has_embedded_cmyk_profile,
        output_intent_count=intent_count,
        profile_sha256=profile_sha256,
        output_condition_identifier=output_condition,
        malformed=malformed,
    )


def describe_color_provenance(source_path: str | Path) -> dict[str, object]:
    """Đọc descriptor từ PDF hoặc ảnh; lỗi được chuyển thành descriptor an toàn."""
    path = Path(source_path)
    if path.suffix.lower() == ".pdf":
        try:
            with pikepdf.Pdf.open(path, attempt_recovery=False) as pdf:
                return describe_pdf_color_provenance(pdf)
        except Exception as exc:
            return _descriptor(
                source_kind="pdf",
                profile_state="malformed",
                has_device_cmyk=False,
                has_rgb=False,
                has_devicen=False,
                malformed=True,
                error_type=type(exc).__name__,
            )
    try:
        from PIL import Image

        with Image.open(path) as image:
            profile = image.info.get("icc_profile")
            is_cmyk = image.mode in {"CMYK", "YCbCrK"}
            is_rgb = image.mode in {"RGB", "RGBA", "L", "LA"}
            state = "tagged" if profile else (
                "untagged-device-cmyk" if is_cmyk else ("rgb" if is_rgb else "unknown")
            )
            return _descriptor(
                source_kind="raster",
                profile_state=state,
                has_device_cmyk=is_cmyk,
                has_rgb=is_rgb,
                has_devicen=False,
                profile_sha256=hashlib.sha256(profile).hexdigest() if profile else None,
            )
    except Exception as exc:
        return _descriptor(
            source_kind="unknown",
            profile_state="malformed",
            has_device_cmyk=False,
            has_rgb=False,
            has_devicen=False,
            malformed=True,
            error_type=type(exc).__name__,
        )


def color_profile_is_missing(provenance: dict[str, object] | None) -> bool:
    """True khi màu in 4 kênh/spot không có profile hợp lệ."""
    if not isinstance(provenance, dict):
        return False
    return bool(
        provenance.get("has_device_cmyk") or provenance.get("has_devicen")
    ) and str(provenance.get("profile_state", "")) != "tagged"


def embed_srgb_output_intent(pdf: pikepdf.Pdf, *, replace_existing: bool = False) -> bool:
    """Gắn OutputIntent sRGB cho PDF trung gian đã raster hóa thành RGB.

    Không gọi hàm này trên PDF còn Form/ảnh CMYK gốc; khi đó phải giữ profile
    nguồn hoặc báo thiếu profile thay vì hợp thức hóa màu bằng sRGB.
    """
    try:
        if pdf.Root.get("/OutputIntents") and not replace_existing:
            return False
        from PIL import ImageCms

        profile = pikepdf.Stream(
            pdf,
            ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes(),
        )
        profile[pikepdf.Name("/N")] = 3
        profile_ref = pdf.make_indirect(profile)
        intent = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OutputIntent"),
            "/S": pikepdf.Name("/GTS_PDFA1"),
            "/OutputConditionIdentifier": pikepdf.String("sRGB"),
            "/Info": pikepdf.String("sRGB IEC61966-2.1"),
            "/DestOutputProfile": profile_ref,
        }))
        pdf.Root[pikepdf.Name("/OutputIntents")] = pikepdf.Array([intent])
        return True
    except Exception:
        return False

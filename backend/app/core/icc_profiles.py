"""Shared ICC profile registry — Convert Colors, Soft-proof, Separations.

Resolves profiles from the app bundle first (``settings.ICC_PROFILE_DIR``),
then well-known OS color directories. Mỗi ứng viên sRGB được xác minh danh tính
trước khi dùng; file mang nhãn sRGB nhưng thực chất Adobe RGB sẽ bị cách ly.
"""
from __future__ import annotations

import logging
import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# Bundle dir (FOGRA39.icc, sRGB.icc ship with the app).
def _bundle_icc_dir() -> Path:
    raw = getattr(settings, "ICC_PROFILE_DIR", "") or ""
    configured = Path(raw)
    package_dir = Path(__file__).resolve().parents[1] / "assets" / "icc"

    # Đường tuyệt đối cấu hình từ một cwd khác có thể trỏ vào thư mục không tồn tại.
    # Không được vì thế mà âm thầm nhảy sang profile hệ điều hành: cùng một PDF sẽ cho
    # kẽm khác nhau giữa máy dev và máy khách. Bundle đi kèm app là fallback xác định.
    if configured.is_absolute():
        if configured.is_dir():
            return configured
        if package_dir.is_dir():
            return package_dir
        return configured

    candidates = [
        configured.resolve(),
        package_dir,
        Path.cwd() / "app" / "assets" / "icc",
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return configured.resolve()


OS_ICC_SEARCH_PATHS = [
    r"C:\Windows\System32\spool\drivers\color",
    "/Library/ColorSync/Profiles",
    "/System/Library/ColorSync/Profiles",
    "/usr/share/color/icc",
    "/usr/local/share/color/icc",
]

# id → metadata + candidate filenames (bundle names first)
PROFILE_REGISTRY: dict[str, dict[str, Any]] = {
    "srgb": {
        "name": "sRGB IEC61966-2.1",
        "description": "Màn hình / web (sRGB)",
        "category": "display",
        "filenames": [
            "sRGB.icc",
            "sRGB Color Space Profile.icm",
            "sRGB IEC61966-2.1.icc",
            "sRGB Profile.icc",
        ],
    },
    "fogra39": {
        "name": "ISO Coated v2 (FOGRA39)",
        "description": "Giấy couché offset châu Âu (ISO 12647-2)",
        "category": "output",
        "filenames": [
            "FOGRA39.icc",  # app bundle
            "CoatedFOGRA39.icc",
            "ISOcoated_v2_300_bas.icc",
            "ISOcoated_v2_300_eci.icc",
            "Coated FOGRA39 (ISO 12647-2_2004).icc",
        ],
    },
    "fogra27": {
        "name": "ISO Coated (FOGRA27)",
        "description": "Giấy couché offset châu Âu (cũ)",
        "category": "output",
        "filenames": ["CoatedFOGRA27.icc", "ISOcoated.icc", "FOGRA27.icc"],
    },
    "gracol": {
        "name": "GRACoL 2006 / 2013",
        "description": "Giấy couché offset Bắc Mỹ",
        "category": "output",
        "filenames": [
            "GRACoL2006_Coated1v2.icc",
            "GRACoL2013_CRPC6.icc",
            "GRACoL.icc",
        ],
    },
    "swop": {
        "name": "US Web Coated (SWOP) v2",
        "description": "In web offset Bắc Mỹ",
        "category": "output",
        "filenames": [
            "USWebCoatedSWOP.icc",
            "WebCoatedSWOP2006Grade3.icc",
            "USWebCoatedSWOP v2.icc",
            "SWOP.icc",
        ],
    },
    "japan_color": {
        "name": "Japan Color 2001 Coated",
        "description": "In offset Nhật Bản",
        "category": "output",
        "filenames": [
            "JapanColor2001Coated.icc",
            "JapanColor2001_Coated_bas.icc",
            "JapanColor.icc",
        ],
    },
    "uncoated": {
        "name": "ISO Uncoated (FOGRA29)",
        "description": "Giấy không tráng phủ",
        "category": "output",
        "filenames": [
            "UncoatedFOGRA29.icc",
            "ISOuncoated.icc",
            "Uncoated FOGRA29 (ISO 12647-2_2004).icc",
            "FOGRA29.icc",
        ],
    },
    "newspaper": {
        "name": "ISOnewspaper26v4",
        "description": "In báo (newsprint)",
        "category": "output",
        "filenames": ["ISOnewspaper26v4.icc", "ISOnewspaper.icc"],
    },
}

# Convert-Colors UI keys → registry id
CONVERT_ICC_FILE_MAP = {
    "fogra39": "fogra39",
    "swop": "swop",
    "japan_color": "japan_color",
    "gracol": "gracol",
    "uncoated": "uncoated",
}


def _search_dirs() -> list[Path]:
    dirs: list[Path] = [_bundle_icc_dir()]
    for d in OS_ICC_SEARCH_PATHS:
        p = Path(d)
        if p.is_dir():
            dirs.append(p)
    return dirs


def _profile_matches_registry_id(profile_id: str, path: Path) -> bool:
    """Chặn profile bị đặt sai tên trước khi PPE sử dụng."""
    if profile_id != "srgb":
        return True
    try:
        from PIL import ImageCms

        profile = ImageCms.getOpenProfile(str(path))
        identity = " ".join((
            ImageCms.getProfileName(profile),
            ImageCms.getProfileDescription(profile),
        )).strip().lower()
        return ("srgb" in identity or "iec 61966-2.1" in identity) and "adobe rgb" not in identity
    except Exception as exc:
        logger.warning("[ICC] không đọc được profile sRGB '%s': %s", path, exc)
        return False


@lru_cache(maxsize=1)
def _materialize_builtin_srgb_profile() -> Path | None:
    """Tạo profile sRGB chuẩn từ LittleCMS khi bundle/OS không có bản hợp lệ."""
    try:
        from PIL import ImageCms

        target_dir = Path(tempfile.gettempdir()) / "PrynX" / "icc"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "sRGB-lcms.icc"
        if target.is_file() and _profile_matches_registry_id("srgb", target):
            return target.resolve()

        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
        payload = profile.tobytes()
        temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
        temporary.write_bytes(payload)
        os.replace(temporary, target)
        if _profile_matches_registry_id("srgb", target):
            return target.resolve()
    except Exception as exc:
        logger.warning("[ICC] không tạo được profile sRGB LittleCMS: %s", exc)
    return None


def _find_file(profile_id: str, filenames: list[str]) -> Path | None:
    for directory in _search_dirs():
        try:
            for fn in filenames:
                candidate = directory / fn
                if candidate.is_file():
                    resolved = candidate.resolve()
                    if _profile_matches_registry_id(profile_id, resolved):
                        return resolved
                    logger.warning(
                        "[ICC] bỏ qua profile '%s' vì danh tính không khớp id '%s'",
                        resolved,
                        profile_id,
                    )
            # one-level subdirs
            for sub in directory.iterdir():
                if not sub.is_dir():
                    continue
                for fn in filenames:
                    candidate = sub / fn
                    if candidate.is_file():
                        resolved = candidate.resolve()
                        if _profile_matches_registry_id(profile_id, resolved):
                            return resolved
        except OSError:
            continue
    return None


@lru_cache(maxsize=32)
def resolve_profile_path(profile_id: str) -> str | None:
    """Return absolute path to an ICC file, or None if missing."""
    key = (profile_id or "").strip().lower()
    if key in ("auto", ""):
        key = "fogra39"
    info = PROFILE_REGISTRY.get(key)
    if not info:
        return None
    found = _find_file(key, list(info["filenames"]))
    if found:
        logger.debug("[ICC] %s → %s", key, found)
        return str(found)
    if key == "srgb":
        generated = _materialize_builtin_srgb_profile()
        if generated:
            logger.info("[ICC] srgb → %s (LittleCMS built-in)", generated)
            return str(generated)
    logger.warning("[ICC] profile '%s' not found (tried %s)", key, info["filenames"][:3])
    return None


def resolve_cmyk_profile_path(profile_id: str | None = None) -> str | None:
    """CMYK output profile for print simulation (default FOGRA39 bundle)."""
    return resolve_profile_path(profile_id or "fogra39")


def resolve_srgb_profile_path() -> str | None:
    return resolve_profile_path("srgb")


def default_cmyk_profile_filename() -> str:
    return getattr(settings, "DEFAULT_CMYK_PROFILE", "FOGRA39.icc") or "FOGRA39.icc"


def list_output_profiles() -> list[dict[str, Any]]:
    """Profiles exposed to Soft-proof / Convert Colors UI."""
    out: list[dict[str, Any]] = []
    for profile_id, info in PROFILE_REGISTRY.items():
        if info.get("category") != "output":
            continue
        path = resolve_profile_path(profile_id)
        out.append({
            "id": profile_id,
            "name": info["name"],
            "description": info["description"],
            "available": path is not None,
            "path": path,
        })
    return out

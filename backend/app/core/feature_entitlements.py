"""Danh mục quyền Free/Pro phía sidecar, đồng bộ với desktop."""
from __future__ import annotations

import os
import sys
from typing import Optional

def _feature_gating_enabled() -> bool:
    # A compiled production sidecar must never allow an environment override to
    # disable entitlements when it is launched outside the Tauri host.
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        return True
    return os.getenv("PRYNX_FEATURE_GATING_ENABLED", "false").lower() == "true"


FEATURE_GATING_ENABLED = _feature_gating_enabled()
_PLAN_RANK = {"free": 1, "pro": 2, "dev": 99}
FREE_FEATURES = {
    "pdf.shuffle", "pdf.resize", "pdf.split", "pdf.pages", "pdf.merge",
    "pdf.encrypt", "pdf.decrypt", "pdf.metadata", "pdf.optimize", "pdf.watermark",
    "pdf.header_footer", "pdf.office_convert", "qc.compare_text",
}
PRO_FEATURES = {
    "pdf.resize_batch", "pdf.office_batch", "pdf.optimize_advanced", "pdf.trim_shift",
    "prepress.preflight", "prepress.convert_colors", "prepress.hairlines", "prepress.trapping",
    "prepress.cutline", "prepress.pdfx", "prepress.paper_library",
    "vdp.datamerge", "vdp.numbering", "vdp.cover_numbering",
    "impo.booklet", "impo.nup", "impo.diecut", "impo.cnc", "packaging.dieline",
    "util.bgremover", "util.upscale", "util.logo_rebuild", "qc.compare_pdf",
}
FEATURE_MIN_PLAN: dict[str, str] = {
    **{feature: "free" for feature in FREE_FEATURES},
    **{feature: "pro" for feature in PRO_FEATURES},
}


def normalize_plan(raw: Optional[str]) -> str:
    plan = (raw or "").strip().lower()
    if plan in ("pro", "professional", "enterprise", "paid"):
        return "pro"
    if plan in ("dev", "development", "internal", "admin"):
        return "dev"
    return "free"


def can_use_feature(feature_id: str, plan: Optional[str] = None, features: Optional[list[str]] = None) -> bool:
    if not FEATURE_GATING_ENABLED:
        return True
    have = normalize_plan(plan)
    if have in ("pro", "dev"):
        return True
    if features and ("*" in features or feature_id in features):
        return True
    need = FEATURE_MIN_PLAN.get(feature_id)
    if need is None:
        return False
    return _PLAN_RANK[have] >= _PLAN_RANK[need]


def assert_feature(feature_id: str, license_info: Optional[dict] = None) -> None:
    if not FEATURE_GATING_ENABLED:
        return
    info = license_info or {}
    if not can_use_feature(feature_id, info.get("plan") or info.get("tier"), info.get("features")):
        raise PermissionError(
            f"Tính năng '{feature_id}' yêu cầu PrynX Pro "
            f"(gói hiện tại: {normalize_plan(info.get('plan') or info.get('tier'))})."
        )

"""
Free/Pro feature entitlements — Phase D scaffold.

FEATURE_GATING_ENABLED = False → mọi request license-valid vẫn chạy (hành vi hiện tại).
Khi bật: map feature_id → plan tối thiểu; phụ thuộc license_info['plan'].

Không gắn pricing. Không chặn route khi flag tắt.
"""

from __future__ import annotations

from typing import Optional

# ── Tắt gate mặc định (an toàn ship) ──
FEATURE_GATING_ENABLED = False

# plan rank
_PLAN_RANK = {"free": 1, "pro": 2, "dev": 99}

# feature_id → min plan
FEATURE_MIN_PLAN: dict[str, str] = {
    "pdf.encrypt": "free",
    "pdf.decrypt": "free",
    "pdf.metadata": "free",
    "pdf.optimize": "free",
    "pdf.watermark": "free",
    "pdf.merge": "free",
    "pdf.split": "free",
    "pdf.pages": "free",
    "pdf.office_convert": "free",
    "impo.booklet": "pro",
    "impo.nup": "pro",
    "impo.diecut": "pro",
    "impo.cnc": "pro",
    "impo.dieline": "pro",
    "vdp.numbering": "pro",
    "vdp.datamerge": "pro",
    "print.preflight": "pro",
    "qc.compare": "pro",
}


def normalize_plan(raw: Optional[str]) -> str:
    p = (raw or "").strip().lower()
    if p in ("pro", "professional", "enterprise"):
        return "pro"
    if p in ("dev", "development", "internal"):
        return "dev"
    return "free"


def can_use_feature(feature_id: str, plan: Optional[str] = None) -> bool:
    """True nếu plan đủ entitlement. Khi gate tắt → luôn True."""
    if not FEATURE_GATING_ENABLED:
        return True
    need = FEATURE_MIN_PLAN.get(feature_id)
    if not need:
        return True
    have = normalize_plan(plan)
    return _PLAN_RANK.get(have, 0) >= _PLAN_RANK.get(need, 0)


def assert_feature(feature_id: str, license_info: Optional[dict] = None) -> None:
    """Raise PermissionError nếu thiếu entitlement (chỉ khi gate bật)."""
    if not FEATURE_GATING_ENABLED:
        return
    plan = None
    if license_info:
        plan = license_info.get("plan") or license_info.get("tier")
    if not can_use_feature(feature_id, plan):
        raise PermissionError(
            f"Tính năng '{feature_id}' yêu cầu gói cao hơn (plan hiện tại: {normalize_plan(plan)})."
        )

"""
profile_store.py — Tạo/sửa/lưu Machine Profile của người dùng (Req 7.1, 7.3).

Profile người dùng lưu dạng JSON trong thư mục cấu hình; validate trước khi lưu
(không cho lưu thiếu trường bắt buộc).
"""

from __future__ import annotations

import json
import os

from app.workers.cut_export.profile import (
    MachineProfile,
    profile_from_dict,
    validate_profile_dict,
    load_profile,
)


def save_profile(data: dict, directory: str) -> str:
    """Validate rồi ghi profile ra `{directory}/{id}.json`. Trả đường dẫn.

    Ném ProfileError nếu thiếu/không hợp lệ (Req 7.3).
    """
    validate_profile_dict(data)  # ném ProfileError nếu sai
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{data['id']}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def list_profiles(directory: str) -> dict[str, MachineProfile]:
    out: dict[str, MachineProfile] = {}
    if not os.path.isdir(directory):
        return out
    for fn in sorted(os.listdir(directory)):
        if fn.endswith(".json"):
            try:
                p = load_profile(os.path.join(directory, fn))
                out[p.id] = p
            except Exception:
                continue
    return out


def delete_profile(profile_id: str, directory: str) -> bool:
    path = os.path.join(directory, f"{profile_id}.json")
    if os.path.isfile(path):
        os.remove(path)
        return True
    return False


def clone_profile(base: MachineProfile, new_id: str, **overrides) -> dict:
    """Tạo dict profile mới từ một profile có sẵn (để chỉnh rồi save)."""
    from dataclasses import asdict
    data = asdict(base)
    data["id"] = new_id
    data.update(overrides)
    profile_from_dict(data)  # validate
    return data

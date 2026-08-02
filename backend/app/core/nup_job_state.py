"""Đọc và chuẩn hóa trạng thái terminal của tiến trình N-Up."""

from __future__ import annotations

import os

NupTerminalState = tuple[str, str]


def read_nup_state(job_id: str, temp_dir: str) -> NupTerminalState | None:
    """Đọc state file hợp lệ; file thiếu/dở không được coi là terminal."""
    state_file = os.path.join(temp_dir, f"nup_state_{job_id}.txt")
    try:
        with open(state_file, "r", encoding="utf-8") as file_obj:
            parts = file_obj.read().split("|||", 1)
    except (OSError, UnicodeDecodeError):
        return None
    status = parts[0]
    if status not in {"completed", "failed"}:
        return None
    return status, parts[1] if len(parts) > 1 else ""


def resolve_nup_terminal_state(
    job_id: str,
    exitcode: int | None,
    *,
    cancelled: bool,
    temp_dir: str,
) -> NupTerminalState | None:
    """Không để child đã thoát mà thiếu state giữ job ở ``running`` vô hạn."""
    if cancelled:
        return None
    terminal_state = read_nup_state(job_id, temp_dir)
    if terminal_state is not None:
        return terminal_state

    if exitcode not in (0, None):
        error = f"Tiến trình N-Up kết thúc với mã lỗi {exitcode}."
    else:
        error = "Tiến trình N-Up kết thúc nhưng không ghi trạng thái hoàn tất."
    try:
        state_file = os.path.join(temp_dir, f"nup_state_{job_id}.txt")
        with open(state_file, "w", encoding="utf-8") as state_output:
            state_output.write(f"failed|||{error}")
    except OSError:
        pass
    return "failed", error

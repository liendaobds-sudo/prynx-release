"""Báo cáo tăng trưởng của các file backend lớn mà không chặn test/build.

Đây là tín hiệu để lên kế hoạch tách module, không phải tiêu chí đúng/sai của
artifact. Script luôn trả mã 0, kể cả khi file tăng hoặc mất; các hợp đồng hành
vi thật vẫn được bảo vệ bởi pytest, typecheck và các chốt endpoint.
"""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"

# Mốc quan sát rc.6 ngày 2026-08-13; không gọi là "trần" và không dùng để fail.
BASELINES: dict[str, int] = {
    "app/api/routes/imposition.py": 4055,
    "app/api/routes/pdf_tools.py": 2217,
    "app/api/routes/preflight.py": 1992,
    "app/api/routes/edit.py": 1432,
    "app/core/stream_editor.py": 3713,
    "app/workers/nup_engine.py": 3732,
    "app/core/channel_remover.py": 2246,
    "app/core/edit_session.py": 2211,
    "app/workers/sticker_engine.py": 9757,
}


def _line_count(path: Path) -> int:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return sum(1 for _ in handle)


def main() -> int:
    # BUILD (audit 2026-08-15 ARCH.BUDGET): Windows PowerShell 5 có thể trả
    # stdout cp1252 khi bị redirect; ép UTF-8 để báo cáo tiếng Việt không tự lỗi.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("[KIẾN TRÚC] Báo cáo file backend lớn (chỉ thông tin, không chặn build)")
    for rel_path, baseline in sorted(BASELINES.items()):
        path = BACKEND_ROOT / rel_path
        if not path.is_file():
            print(f"  [THÔNG TIN] {rel_path}: không còn ở vị trí cũ")
            continue
        actual = _line_count(path)
        delta = actual - baseline
        direction = f"+{delta}" if delta > 0 else str(delta)
        marker = "CẦN XEM" if delta > 0 else "OK"
        print(f"  [{marker}] {rel_path}: {actual} dòng (so với mốc {direction})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

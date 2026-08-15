"""Chốt hợp đồng kiến trúc có ý nghĩa hành vi cho các route backend lớn.

BUILD (audit 2026-08-15 ARCH.BUDGET): số dòng vật lý không còn là test chặn
build. Báo cáo tăng trưởng được chuyển sang ``scripts/report_architecture_debt.py``
vì comment, import hoặc lưới an toàn có thể làm số dòng tăng mà không làm kiến
trúc xấu đi. Chốt endpoint vẫn là hợp đồng thật: route đã quá tải không được nhận
thêm API mới.
"""

from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_route_imposition_khong_them_endpoint():
    """Đặt endpoint bình bản mới ở router riêng, không nối tiếp vào god route."""
    path = BACKEND_ROOT / "app/api/routes/imposition.py"
    text = path.read_text(encoding="utf-8", errors="replace")
    count = sum(1 for line in text.splitlines() if line.startswith("@router."))
    assert count <= 18, (
        f"routes/imposition.py có {count} endpoint (trần hợp đồng 18, audit "
        "2026-07-29 §A.1). Đặt endpoint mới ở router riêng thay vì nối tiếp "
        "vào file này."
    )

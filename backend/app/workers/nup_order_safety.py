"""BE.01/02 (audit 2026-09-20): chốt đủ lượng tại biên kế hoạch/writer."""
from collections import Counter

def require_quantity_coverage(required, produced):
    """Không cho tờ thiếu mẫu đi tiếp dưới trạng thái thành công."""
    missing = [(int(page), int(qty) - int(produced.get(page, 0)))
               for page, qty in required.items() if int(produced.get(page, 0)) < int(qty)]
    if missing:
        detail = ", ".join(f"mẫu {page + 1} thiếu {qty}" for page, qty in missing)
        raise ValueError(
            f"Không thể xếp đủ số lượng: {detail}. "
            "Hãy tăng khổ giấy hoặc kiểm tra kích thước tem, lề và boong."
        )

def require_packer_coverage(page_dims_qty, result):
    """Đối soát các tờ mẫu theo số lần in thật, không chỉ đếm tờ đại diện."""
    produced = Counter()
    for sheet in result.get("sheets") or [result]:
        runs = max(1, int(sheet.get("sheets_needed", 1) or 1))
        for placement in sheet.get("placements", []):
            produced[int(placement["page_idx"])] += runs
    require_quantity_coverage({int(p): int(q) for p, _w, _h, q in page_dims_qty}, produced)

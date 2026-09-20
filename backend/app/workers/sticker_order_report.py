"""BE.07/08: lệnh in và report lấy từ các recipe sẽ thật sự được ghi ra PDF."""
from collections import Counter
from app.workers import nup_report
from app.workers.nup_order_safety import require_quantity_coverage

MM = 2.83465

def build_order_reports(settings, placements, run_counts, requested, *, page_sheet=False):
    produced = Counter()
    physical = 0
    for index, values in placements.items():
        runs = int(run_counts.get(index,1))
        physical += runs
        for value in values:
            produced[int(value["src_page_idx"])] += runs
    require_quantity_coverage(requested, produced)
    total_requested, total_placed = sum(requested.values()), sum(produced.values())
    remaining = dict(requested)
    reports, rows = {}, []
    config = settings.get("reportDisplay") or {}
    for index, values in placements.items():
        if not values:
            raise ValueError("Kế hoạch có tờ trống; không thể xuất lệnh in.")
        runs = int(run_counts.get(index,1))
        counts = Counter(int(p["src_page_idx"]) for p in values)
        allocated = 0
        for page, count in counts.items():
            amount = min(remaining.get(page,0),count*runs)
            allocated += amount
            remaining[page] = remaining.get(page,0)-amount
        identifier = f"Bố cục {index+1}/{len(placements)}"
        label = config.get("labelNameText") or identifier
        rows.append({"label":label,"items_per_sheet":len(values),
                     "requested_qty":allocated,"sheet_count":runs})
        if not config.get("enabled"):
            continue
        p = values[0]
        w,h = float(p["width"]),float(p["height"])
        if p["cell"].get("isRotated"):
            w,h = h,w
        data = nup_report.compute_report_data(
            label_name=config.get("labelNameText") or "", identifier=identifier,
            width_mm=w/MM if len(counts)==1 or page_sheet else 0,
            height_mm=h/MM if len(counts)==1 or page_sheet else 0,
            paper_size=f'{settings.get("sheetWidth",0)}x{settings.get("sheetHeight",0)}mm',
            items_per_sheet=len(values), requested_qty=allocated, sheet_count_override=runs,
            material=settings.get("reportMaterial") or "",
            lamination_type=settings.get("reportLamination") or 0,
            lamination_sides=settings.get("reportLaminationSides") or 1,
            mode_label="Bình nguyên tấm decal" if page_sheet else "Bế tem",
            order_code=settings.get("reportOrderCode") or "", gang_count=len(counts),
        )
        reports[index] = nup_report.build_report_string(config,data)
    return reports,rows,{
        "requestedCount":total_requested,"placedCount":total_placed,
        "extraCount":total_placed-total_requested,"physicalSheetCount":physical,
        "templateCount":len(placements),
    }

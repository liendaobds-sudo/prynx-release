"""Kiểm chéo bằng PDF đọc lại và vẽ neo thật; không sửa mã sản phẩm."""
from pathlib import Path
import json
import runpy
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).parent
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
import numpy as np
import pikepdf
from shapely.geometry import LineString, Point
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from test_cutline_cubic_simplify import _sample, _dense_distance
from app.workers.cut_export.pdf_source import build_cut_model_from_pdf


def load(name):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def main():
    compared = []
    for mode in ("original", "round"):
        base = load(f"Binder2_p12_{mode}_s0.000.json")
        for suffix in (["0.050", "0.100", "0.100_auto"] if mode == "original" else ["0.100", "0.100_auto"]):
            target = load(f"Binder2_p12_{mode}_s{suffix}.json")
            distances = []
            for source, output in zip(base["rings_mm"][0], target["rings_mm"][0]):
                to_pt = lambda ring: [tuple((x * 72/25.4, y * 72/25.4) for x,y in curve) for curve in ring]
                distances.append(_dense_distance(_sample(to_pt(source)), _sample(to_pt(output))))
            compared.append(dict(mode=mode, simplify=suffix, sampled_distance_mm=distances,
                same_pdf_cut=base["pages"][0]["cut_sha256"] == target["pages"][0]["cut_sha256"],
                same_artwork_pixels=base["pages"][0]["artwork_raster"] == target["pages"][0]["artwork_raster"]))

    # Kiểm chéo finding của agent bằng chính public dispatcher một lần nữa.
    geometry = runpy.run_path(str(HERE / "geometry/probe.py"))
    gate = geometry["hard_gate_safe"]()

    # Kiểm lại khoảng lệch ở consumer máy cắt bằng lấy mẫu cubic giải tích.
    k = 4 * (2**0.5 - 1)/3
    control = np.array([(1,0),(1,k),(k,1),(0,1)])
    t = np.linspace(0,1,8193)[:,None]
    quarter = (1-t)**3*control[0]+3*(1-t)**2*t*control[1]+3*(1-t)*t*t*control[2]+t**3*control[3]
    samples = np.concatenate([quarter @ np.array([[np.cos(a),np.sin(a)],[-np.sin(a),np.cos(a)]])
                              for a in (0,np.pi/2,np.pi,3*np.pi/2)])*100 + 150
    downstream = []
    for mode in ("physical_coords", "normalized_ctm"):
        source = HERE / "flow" / f"downstream_{mode}_source.pdf"
        model = build_cut_model_from_pdf(str(source))
        polyline = LineString(model.paths[0].points)
        downstream.append(dict(mode=mode, vertices=len(model.paths[0].points),
            sampled_max_mm=max(polyline.distance(Point(p)) for p in samples)))
    (HERE / "root_verification.json").write_text(json.dumps(dict(
        artifact_comparisons=compared, gate_cross_check=gate,
        downstream_cross_check=downstream), ensure_ascii=False, indent=2), encoding="utf-8")

    pdfmetrics.registerFont(TTFont("AuditArial", "C:/Windows/Fonts/arial.ttf"))
    destination = ROOT / "output/pdf/Cutline-quality-audit-2026-09-24/doi_chieu_neo.pdf"
    c = canvas.Canvas(str(destination), pagesize=(960,650), invariant=1)
    c.setFont("AuditArial",24)
    c.drawString(38,609,"Preview và PDF khi Thực thi đang khác nhau")
    c.setFont("AuditArial",12)
    c.setFillColor(HexColor("#475569"))
    c.drawString(38,582,"Binder2 · trang 12 · giữ góc · offset 2 mm · khử răng cưa 30 · Simplify 0,10 mm")
    cases = [("Binder2_p12_original_s0.100.json", "Preview: 56 neo", "#0284c7"),
             ("Binder2_p12_original_s0.100_auto.json", "Thực thi AUTO: 73 neo", "#db2777")]
    for index,(name,title,color) in enumerate(cases):
        data = load(name)
        ring = np.array(data["rings_mm"][0][0])
        lower,upper = ring.reshape(-1,2).min(axis=0),ring.reshape(-1,2).max(axis=0)
        scale = min(380/(upper[0]-lower[0]),445/(upper[1]-lower[1]))
        origin = np.array([58+index*466,75])
        mapped=(ring-lower)*scale+origin
        c.setFillColor(HexColor("#0f172a")); c.setFont("AuditArial",18)
        c.drawString(58+index*466,548,title)
        path=c.beginPath(); path.moveTo(*mapped[0,0])
        for curve in mapped:
            path.curveTo(*curve[1],*curve[2],*curve[3])
        path.close()
        c.setStrokeColor(HexColor(color)); c.setLineWidth(1.25); c.drawPath(path)
        for point in mapped[:,0]:
            c.setFillColor(HexColor("#ffffff"));c.circle(*point,2.1,stroke=1,fill=1)
    c.setFont("AuditArial",11);c.setFillColor(HexColor("#475569"))
    c.drawString(38,30,"Chấm tròn là neo đọc từ PDF; không tính tay nắm. Đây là lỗi đồng bộ, chưa phải phương án tối ưu cuối.")
    c.save()
    print(json.dumps(dict(comparisons=compared, downstream=downstream,plot=str(destination)),ensure_ascii=True))


if __name__ == "__main__":
    main()

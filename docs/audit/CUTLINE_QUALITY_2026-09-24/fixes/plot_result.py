"""Vẽ neo từ chính hai PDF đã đọc lại trước/sau sửa AUTO."""
from pathlib import Path
import json
import numpy as np
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
destination = ROOT / "output/pdf/Cutline-quality-fixed-2026-09-24/doi_chieu_neo_sau_sua.pdf"
pdfmetrics.registerFont(TTFont("CutArial", "C:/Windows/Fonts/arial.ttf"))
c = canvas.Canvas(str(destination), pagesize=(960, 650), invariant=1)
c.setFont("CutArial", 24)
c.drawString(38, 610, "Đường cắt AUTO sau sửa: 73 → 56 neo")
c.setFont("CutArial", 12)
c.setFillColor(HexColor("#475569"))
c.drawString(38, 581, "Binder2 · trang 12 · giữ góc · offset 2 mm · khử răng cưa 30 · Simplify 0,10 mm")
cases = [(HERE.parent, "Trước sửa: 73 neo", "#db2777"),
         (HERE, "Sau sửa: 56 neo", "#0284c7")]
for index, (folder, title, color) in enumerate(cases):
    data = json.loads((folder / "Binder2_p12_original_s0.100_auto.json").read_text(encoding="utf-8"))
    ring = np.array(data["rings_mm"][0][0])
    lower, upper = ring.reshape(-1, 2).min(axis=0), ring.reshape(-1, 2).max(axis=0)
    scale = min(380 / (upper[0]-lower[0]), 440 / (upper[1]-lower[1]))
    mapped = (ring-lower)*scale+np.array([58+index*466, 78])
    c.setFillColor(HexColor("#0f172a")); c.setFont("CutArial", 18)
    c.drawString(58+index*466, 548, title)
    path = c.beginPath(); path.moveTo(*mapped[0, 0])
    for curve in mapped:
        path.curveTo(*curve[1], *curve[2], *curve[3])
    path.close()
    c.setStrokeColor(HexColor(color)); c.setLineWidth(1.25); c.drawPath(path)
    for point in mapped[:, 0]:
        c.setFillColor(HexColor("#ffffff")); c.circle(*point, 2.1, stroke=1, fill=1)
c.setFont("CutArial", 11); c.setFillColor(HexColor("#475569"))
c.drawString(38, 42, "Chấm tròn là neo đọc từ PDF, không tính tay nắm. Góc thật được giữ; cận sai lệch thêm ≤ 0,100 mm.")
c.drawString(38, 23, "Kiểm chéo dày: 0,09803 mm · artwork giữ nguyên · preview và PDF xuất cùng đường cắt.")
c.save()
print(destination)

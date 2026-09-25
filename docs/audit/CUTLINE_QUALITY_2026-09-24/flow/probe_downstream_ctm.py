"""Audit-only: equivalent CUT cubics must retain accuracy after PDF CTM scale."""
from pathlib import Path
from io import BytesIO
import json
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np
import pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.colors import CMYKColorSep
from shapely.geometry import LineString, Point

from app.workers.cut_export.pdf_source import build_cut_model_from_pdf
from app.workers.cut_export.emitters.pdf_spot import PdfSpotEmitter

OUT = Path(__file__).resolve().parent
RADIUS_MM = 100.0
MM_TO_PT = 72 / 25.4
K = 4 * (2**0.5 - 1) / 3
RINGS = [
    [(1, 0), (1, K), (K, 1), (0, 1)],
    [(0, 1), (-K, 1), (-1, K), (-1, 0)],
    [(-1, 0), (-1, -K), (-K, -1), (0, -1)],
    [(0, -1), (K, -1), (1, -K), (1, 0)],
]


def make_source(path, normalized):
    c = canvas.Canvas(str(path), pagesize=(300 * MM_TO_PT, 300 * MM_TO_PT), invariant=1)
    c.translate(150 * MM_TO_PT, 150 * MM_TO_PT)
    scale = RADIUS_MM * MM_TO_PT
    if normalized:
        c.scale(scale, scale)
        scale = 1
    c.setStrokeColor(CMYKColorSep(0, 1, 0, 0, spotName="CutContour"))
    c.setLineWidth(.01)
    p = c.beginPath()
    p.moveTo(scale, 0)
    for ring in RINGS:
        p.curveTo(*(value * scale for point in ring[1:] for value in point))
    p.close()
    c.drawPath(p, stroke=1, fill=0)
    c.showPage()
    c.save()


def count_pdf(data):
    with pikepdf.open(BytesIO(data)) as pdf:
        ops = [str(op) for _, op in pikepdf.parse_content_stream(pdf.pages[0])]
    return {"cubic": ops.count("c"), "line": ops.count("l")}


def main():
    t = np.linspace(0, 1, 4097)[:, None]
    samples = []
    for ring in RINGS:
        p = np.array(ring)
        xy = (1-t)**3*p[0] + 3*(1-t)**2*t*p[1] + 3*(1-t)*t**2*p[2] + t**3*p[3]
        samples.extend(xy * RADIUS_MM + 150)
    records = []
    for name, normalized in (("physical_coords", False), ("normalized_ctm", True)):
        source = OUT / f"downstream_{name}_source.pdf"
        make_source(source, normalized)
        model = build_cut_model_from_pdf(str(source))
        assert len(model.paths) == 1
        line = LineString(model.paths[0].points)
        error = max(line.distance(Point(p)) for p in samples)
        exported = PdfSpotEmitter().emit(model)
        (OUT / f"downstream_{name}_reexport.pdf").write_bytes(exported)
        records.append({
            "representation": name,
            "source": count_pdf(source.read_bytes()),
            "reexport": count_pdf(exported),
            "polyline_points": len(model.paths[0].points),
            "sampled_source_to_polyline_max_mm": error,
            "sampling_per_cubic": 4097,
            "note": "Measured sample maximum, not continuous certificate. Same physical 4 cubics in both PDFs.",
        })
    evidence = {"radius_mm": RADIUS_MM, "records": records}
    (OUT / "downstream_ctm_evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()

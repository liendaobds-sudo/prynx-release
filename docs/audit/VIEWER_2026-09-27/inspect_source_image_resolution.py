"""Chỉ đọc PDF: ghi kích thước ảnh nguồn và phép đặt ảnh, không raster GUI."""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ContentStream


def then(inner, outer):
    a, b, c, d, e, f = inner
    aa, bb, cc, dd, ee, ff = outer
    return (a * aa + b * cc, a * bb + b * dd, c * aa + d * cc,
            c * bb + d * dd, e * aa + f * cc + ee, e * bb + f * dd + ff)


def inspect(path: Path, zoom: float):
    reader = PdfReader(path)
    page = reader.pages[0]
    images = []
    operators = {}

    def visit(stream, resources, matrix, chain):
        states = []
        for args, op in ContentStream(stream, reader).operations:
            operators[op.decode("latin1")] = operators.get(op.decode("latin1"), 0) + 1
            if op == b"q":
                states.append(matrix)
            elif op == b"Q":
                matrix = states.pop()
            elif op == b"cm":
                matrix = then(tuple(float(x) for x in args), matrix)
            elif op == b"Do":
                obj = resources["/XObject"][args[0]].get_object()
                name = chain + [str(args[0])]
                if obj.get("/Subtype") == "/Form":
                    local = tuple(float(x) for x in obj.get("/Matrix", [1, 0, 0, 1, 0, 0]))
                    visit(obj, obj.get("/Resources", resources), then(local, matrix), name)
                elif obj.get("/Subtype") == "/Image":
                    width, height = int(obj["/Width"]), int(obj["/Height"])
                    a, b, c, d, e, f = matrix
                    points = [(a*x+c*y+e, b*x+d*y+f) for x, y in [(0, 0), (1, 0), (0, 1), (1, 1)]]
                    masks = {}
                    for key in ["/Mask", "/SMask"]:
                        value = obj.get(key)
                        if value is not None:
                            value = value.get_object()
                            if hasattr(value, "keys"):
                                masks[key] = {"width": value.get("/Width"), "height": value.get("/Height")}
                    images.append({"name": "/".join(name), "width": width, "height": height,
                                   "matrix": matrix, "bbox_page_y_up": [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)],
                                   "source_px_per_screen_px": [width/(math.hypot(a,b)*zoom), height/(math.hypot(c,d)*zoom)],
                                   "interpolate": bool(obj.get("/Interpolate", False)), "image_mask": bool(obj.get("/ImageMask", False)),
                                   "filter": str(obj.get("/Filter")), "color_space": str(obj.get("/ColorSpace")), "masks": masks})

    visit(page.get_contents(), page["/Resources"], (1, 0, 0, 1, 0, 0), [])
    return {"pdf": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "page": 1,
            "page_bounds": [float(v) for v in page.cropbox], "zoom": zoom,
            "images": images, "operator_counts": operators,
            "limitations": "BBox chưa intersect clip; đây là ảnh được gọi trong content/form, không raster ảnh màn hình hoặc so màu."}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    result = inspect(Path(sys.argv[1]), float(sys.argv[2]))
    print(json.dumps(result, ensure_ascii=False, indent=2))

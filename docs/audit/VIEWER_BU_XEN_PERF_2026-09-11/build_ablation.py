"""Tạo đối chứng thiếu 8 dải bù xén; chỉ chẩn đoán, tuyệt đối không giao in."""
import argparse
from pathlib import Path

import pikepdf

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
assert args.source.resolve() != args.output.resolve()
assert not args.output.exists(), "Không ghi đè artifact có sẵn"
with pikepdf.Pdf.open(args.source) as pdf:
    for page in pdf.pages:
        streams = list(page.Contents)
        assert len(streams) == 3
        # Cấu trúc đã đối chiếu của artifact CMNM: một q/re/clip/cm/Do/Q artwork,
        # theo sau là tám khối dải/góc. Giữ nguyên Form/resources và watermark.
        first = streams[1].read_bytes().splitlines()[:5]
        assert first[0] == b"q" and first[-1] == b"Q"
        assert first[-2].endswith(b" Do")
        page.Contents = pikepdf.Array([
            streams[0], pikepdf.Stream(pdf, b"\n".join(first) + b"\n"), streams[2],
        ])
        operations = list(pikepdf.parse_content_stream(page))
        assert sum(str(op.operator) == "Do" for op in operations) == 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pdf.save(args.output)

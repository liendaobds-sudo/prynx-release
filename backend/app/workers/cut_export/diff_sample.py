"""
diff_sample.py — Đối chiếu cấu trúc file đầu ra với MẪU THẬT của máy (Req 7.2).

Onboarding máy mới: lấy file mẫu (vd .plt do phần mềm hãng xuất) → so cấu trúc với
đầu ra Prynx để dò khác biệt (header, separator, lệnh pen, đơn vị thô).
KHÔNG so byte tuyệt đối — chỉ đặc trưng cấu trúc để gợi ý điền profile.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class PltSignature:
    head: str                       # ~40 ký tự đầu
    pen_tokens: dict = field(default_factory=dict)  # vd {'U': n, 'D': m, 'PU': ..}
    separator: str = ""             # ' ' | ';' | ''
    has_fsize: bool = False
    sample_len: int = 0


_PEN_RE = re.compile(r"(PU|PD|[UDMH])\s*-?\d")


def signature(data: bytes) -> PltSignature:
    text = data.decode("ascii", errors="replace")
    counts: dict[str, int] = {}
    for m in _PEN_RE.finditer(text):
        tok = m.group(1)
        counts[tok] = counts.get(tok, 0) + 1
    sep = ";" if ";" in text[:200] else (" " if " " in text[:200] else "")
    return PltSignature(
        head=text[:40],
        pen_tokens=counts,
        separator=sep,
        has_fsize="FSIZE" in text,
        sample_len=len(data),
    )


def diff_signatures(sample: bytes, generated: bytes) -> dict:
    """Trả khác biệt cấu trúc giữa mẫu thật và đầu ra Prynx."""
    s = signature(sample)
    g = signature(generated)
    diffs: dict = {}
    if s.head.strip()[:8] != g.head.strip()[:8]:
        diffs["header"] = {"sample": s.head, "generated": g.head}
    if set(s.pen_tokens) != set(g.pen_tokens):
        diffs["pen_tokens"] = {"sample": sorted(s.pen_tokens), "generated": sorted(g.pen_tokens)}
    if s.separator != g.separator:
        diffs["separator"] = {"sample": repr(s.separator), "generated": repr(g.separator)}
    if s.has_fsize != g.has_fsize:
        diffs["fsize"] = {"sample": s.has_fsize, "generated": g.has_fsize}
    return {"match": not diffs, "diffs": diffs, "sample": s, "generated": g}

#!/usr/bin/env python3
"""
i18n inventory — đếm CHÍNH XÁC số chuỗi cần dịch, tách khỏi nhiễu (comment/fixture/log).

Chạy:  python scripts/i18n_inventory.py           # bảng tóm tắt
       python scripts/i18n_inventory.py --full     # + top file & chi tiết backend
       python scripts/i18n_inventory.py --json out.json

Ba nhóm được đếm riêng:
  FE  = desktop/src  *.ts/*.tsx  (loại test): chuỗi UI có dấu Việt, đã STRIP comment
  BE  = backend/app  *.py (loại test): chỉ chuỗi USER-FACING (raise_http/detail=/CSV…)
  TST = *.test.ts / test_*.py: chỉ đếm ASSERTION có literal tiếng Việt (thứ THẬT vỡ)
"""
from __future__ import annotations
import os, re, sys, json, argparse
from dataclasses import dataclass, field, asdict

# Windows console mặc định cp1252 → ép UTF-8 để in bảng có dấu + ký tự khung.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FE_DIR = os.path.join(ROOT, "desktop", "src")
BE_DIR = os.path.join(ROOT, "backend", "app")

VN = "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
VN += VN.upper()
VN_RE = re.compile(f"[{VN}]")

def has_vn(s: str) -> bool:
    return bool(VN_RE.search(s))

# ─────────────────────────────────────────────────────────────────────────────
# JS/TS tokenizer: đọc ký tự, phân biệt code / comment / string / template.
# Trả về danh sách (kind, text) với kind ∈ {code, line_comment, block_comment,
# string, template}. Đủ để KHÔNG đếm dấu Việt trong comment.
# ─────────────────────────────────────────────────────────────────────────────
def tokenize_ts(src: str):
    i, n = 0, len(src)
    out, buf = [], []
    def flush(kind):
        if buf:
            out.append((kind, "".join(buf))); buf.clear()
    while i < n:
        c = src[i]
        nx = src[i+1] if i+1 < n else ""
        # line comment
        if c == "/" and nx == "/":
            flush("code")
            j = src.find("\n", i)
            j = n if j == -1 else j
            out.append(("line_comment", src[i:j])); i = j; continue
        # block comment
        if c == "/" and nx == "*":
            flush("code")
            j = src.find("*/", i+2)
            j = n if j == -1 else j+2
            out.append(("block_comment", src[i:j])); i = j; continue
        # strings
        if c in "\"'":
            flush("code")
            q = c; j = i+1
            while j < n:
                if src[j] == "\\": j += 2; continue
                if src[j] == q: j += 1; break
                j += 1
            out.append(("string", src[i:j])); i = j; continue
        # template literal (không xử lý ${} lồng sâu — đủ cho đếm)
        if c == "`":
            flush("code")
            j = i+1
            while j < n:
                if src[j] == "\\": j += 2; continue
                if src[j] == "`": j += 1; break
                j += 1
            out.append(("template", src[i:j])); i = j; continue
        buf.append(c); i += 1
    flush("code")
    return out

# JSX text node: >...<  nằm trong phần "code" (không phải chuỗi/comment).
# Bắt cụm text giữa dấu > và < không chứa {, < , > .
JSX_TEXT_RE = re.compile(r">\s*([^<>{}]*?[^\s<>{}])\s*<")

def scan_fe_file(path: str):
    src = open(path, encoding="utf-8", errors="replace").read()
    toks = tokenize_ts(src)
    string_units, jsx_units = set(), set()
    for kind, txt in toks:
        if kind in ("string", "template"):
            inner = txt[1:-1] if len(txt) >= 2 else txt
            if has_vn(inner):
                string_units.add(inner.strip())
        elif kind == "code":
            for m in JSX_TEXT_RE.finditer(txt):
                t = m.group(1).strip()
                if t and has_vn(t):
                    jsx_units.add(t)
    return string_units, jsx_units

# ─────────────────────────────────────────────────────────────────────────────
# Backend: chỉ chuỗi user-facing. Nhận diện qua sink:
#   raise_http(e, "…")  |  detail="…" / detail=f"…"  | HTTPException(…, "…")
#   return {... "message"/"error"/"detail": "…"}  | CSV header list có dấu Việt
# LOẠI: logger.*(…), docstring, comment (docstring/comment bỏ qua vì không match sink)
# ─────────────────────────────────────────────────────────────────────────────
BE_SINKS = [
    re.compile(r"raise_http\([^,]+,\s*([\"'])(?P<s>.*?)\1", re.S),
    re.compile(r"\bdetail\s*=\s*f?([\"'])(?P<s>.*?)\1", re.S),
    re.compile(r"HTTPException\([^)]*?([\"'])(?P<s>.*?)\1", re.S),
    re.compile(r"[\"'](?:message|error|detail|msg|warning)[\"']\s*:\s*f?([\"'])(?P<s>.*?)\1", re.S),
]
LOGGER_LINE = re.compile(r"\blog(?:ger)?\.\w+\(")

def scan_be_file(path: str):
    src = open(path, encoding="utf-8", errors="replace").read()
    units = set()
    for rx in BE_SINKS:
        for m in rx.finditer(src):
            s = m.group("s")
            if has_vn(s):
                # bỏ nếu nằm trên dòng logger.*
                start = src.rfind("\n", 0, m.start()) + 1
                line = src[start: src.find("\n", m.start())]
                if LOGGER_LINE.search(line):
                    continue
                units.add(s.strip())
    return units

# ─────────────────────────────────────────────────────────────────────────────
# Tests: chỉ assertion có literal Việt.
#   TS: expect(...).toBe("…VN…") / toContain / toEqual  |  assert.*("…VN…")
#   PY: assert ... "…VN…"  (cùng dòng)
# ─────────────────────────────────────────────────────────────────────────────
TS_ASSERT = re.compile(r"(?:expect\([^)]*\)\.\w+|assert\w*)\(([^)]*)\)")
PY_ASSERT = re.compile(r"^\s*assert\b(?P<body>.*)$", re.M)
STR_LIT = re.compile(r"([\"'])((?:\\.|(?!\1).)*)\1")

# Chỉ 1 nhóm THẬT vỡ khi dịch: assert kiểm CHUỖI DO APP SINH RA (output/message).
# Nhận diện qua biến bên trái gợi ý là output backend-facing.
OUTPUT_VARS = re.compile(r"\b(text|msg|message|detail|body|resp|response|content|report|error|err|warning|title|label|toast|out|output|stderr|stdout)\b", re.I)
# Tách message-arg của assert:  assert <expr>, "<message>"  → phần sau dấu phẩy top-level.
def _split_py_assert(body: str):
    depth = 0
    for i, ch in enumerate(body):
        if ch in "([{": depth += 1
        elif ch in ")]}": depth -= 1
        elif ch == "," and depth == 0:
            return body[:i], body[i+1:]   # (expr, message)
    return body, ""

def scan_test_file(path: str, is_py: bool):
    """Trả (breaking, incidental).
       breaking  = assert kiểm chuỗi app sinh ra → dịch backend là VỠ, phải sửa.
       incidental= VN nằm ở message-arg hoặc fixture/test-data → KHÔNG vỡ."""
    src = open(path, encoding="utf-8", errors="replace").read()
    breaking, incidental = [], []
    if is_py:
        for m in PY_ASSERT.finditer(src):
            expr, message = _split_py_assert(m.group("body"))
            # message-arg: mọi VN literal ở đây là incidental (chỉ hiện khi test fail)
            for sm in STR_LIT.finditer(message):
                if has_vn(sm.group(2)):
                    incidental.append(sm.group(2).strip())
            for sm in STR_LIT.finditer(expr):
                if not has_vn(sm.group(2)):
                    continue
                s = sm.group(2).strip()
                # breaking nếu literal so khớp với biến output backend-facing
                if OUTPUT_VARS.search(expr):
                    breaking.append(s)
                else:
                    incidental.append(s)   # fixture / test-data VN (tên KH, cột…)
    else:
        for m in TS_ASSERT.finditer(src):
            arg = m.group(1)
            for sm in STR_LIT.finditer(arg):
                if has_vn(sm.group(2)):
                    breaking.append(sm.group(2).strip())
    return breaking, incidental

# ─────────────────────────────────────────────────────────────────────────────
def walk(base, exts):
    for dp, _, fs in os.walk(base):
        if "node_modules" in dp or "__pycache__" in dp:
            continue
        for f in fs:
            if f.endswith(exts):
                yield os.path.join(dp, f)

def is_test_ts(p):  return p.endswith((".test.ts", ".test.tsx")) or os.sep+"tests"+os.sep in p or os.sep+"__tests__"+os.sep in p
def is_test_py(p):  base = os.path.basename(p); return base.startswith("test_") or os.sep+"tests"+os.sep in p

@dataclass
class Bucket:
    files: int = 0
    units: int = 0
    per_file: dict = field(default_factory=dict)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--json", metavar="PATH")
    args = ap.parse_args()

    fe = Bucket(); be = Bucket()
    fe_test = Bucket(); be_test = Bucket()
    fe_split = {"string": 0, "jsx": 0}

    fe_incidental = 0; be_incidental = 0

    for p in walk(FE_DIR, (".ts", ".tsx")):
        rel = os.path.relpath(p, ROOT)
        if is_test_ts(p):
            brk, inc = scan_test_file(p, is_py=False)
            fe_incidental += len(inc)
            if brk:
                fe_test.files += 1; fe_test.units += len(brk); fe_test.per_file[rel] = brk
            continue
        strs, jsx = scan_fe_file(p)
        total = len(strs) + len(jsx)
        if total:
            fe.files += 1; fe.units += total; fe.per_file[rel] = total
            fe_split["string"] += len(strs); fe_split["jsx"] += len(jsx)

    for p in walk(BE_DIR, (".py",)):
        rel = os.path.relpath(p, ROOT)
        if is_test_py(p):
            brk, inc = scan_test_file(p, is_py=True)
            be_incidental += len(inc)
            if brk:
                be_test.files += 1; be_test.units += len(brk); be_test.per_file[rel] = brk
            continue
        units = scan_be_file(p)
        if units:
            be.files += 1; be.units += len(units); be.per_file[rel] = len(units)

    # backend tests scan cũng cần đi qua backend/tests (ngoài backend/app)
    for p in walk(os.path.join(ROOT, "backend", "tests"), (".py",)):
        rel = os.path.relpath(p, ROOT)
        brk, inc = scan_test_file(p, is_py=True)
        be_incidental += len(inc)
        if brk:
            be_test.files += 1; be_test.units += len(brk); be_test.per_file[rel] = brk

    print("═" * 64)
    print("  i18n INVENTORY — đơn vị cần dịch (đã loại comment/log/fixture)")
    print("═" * 64)
    print(f"  FE  UI strings (desktop/src)   : {fe.units:5d} chuỗi / {fe.files:3d} file")
    print(f"        ├─ string literal        : {fe_split['string']:5d}")
    print(f"        └─ JSX text node         : {fe_split['jsx']:5d}")
    print(f"  BE  user-facing (backend/app)  : {be.units:5d} chuỗi / {be.files:3d} file")
    print(f"  TST assert VỠ — FE (check UI)  : {fe_test.units:5d} assert / {fe_test.files:3d} file")
    print(f"  TST assert VỠ — BE (check msg) : {be_test.units:5d} assert / {be_test.files:3d} file")
    print(f"     (chỉ VỠ nếu dịch backend/Phase 3)")
    print("─" * 64)
    print(f"  bỏ qua — VN ở message-arg/fixture (KHÔNG vỡ): FE {fe_incidental} + BE {be_incidental}")
    print("─" * 64)
    print(f"  TỔNG chuỗi UI+BE cần dịch      : {fe.units + be.units}")
    print(f"  TỔNG assertion THẬT phải sửa   : {fe_test.units + be_test.units}")
    print("═" * 64)

    if args.full:
        print("\n  TOP 20 FILE FE theo số chuỗi:")
        for rel, c in sorted(fe.per_file.items(), key=lambda x: -x[1])[:20]:
            print(f"    {c:4d}  {rel}")
        print("\n  TOP 15 FILE BE user-facing:")
        for rel, c in sorted(be.per_file.items(), key=lambda x: -x[1])[:15]:
            print(f"    {c:4d}  {rel}")
        print("\n  ASSERTION VN cần sửa (tất cả):")
        for bucket in (fe_test, be_test):
            for rel, hits in sorted(bucket.per_file.items()):
                print(f"    {rel}  ({len(hits)})")
                for h in hits[:6]:
                    print(f"        • {h[:70]}")

    if args.json:
        out = {
            "fe": {"files": fe.files, "units": fe.units, "split": fe_split, "per_file": fe.per_file},
            "be": {"files": be.files, "units": be.units, "per_file": be.per_file},
            "fe_test": asdict(fe_test),
            "be_test": asdict(be_test),
        }
        json.dump(out, open(args.json, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n  → JSON: {args.json}")

if __name__ == "__main__":
    main()

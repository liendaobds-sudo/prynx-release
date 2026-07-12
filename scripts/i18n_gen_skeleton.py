#!/usr/bin/env python3
"""
Sinh skeleton locale (vi.json / en.json) từ chuỗi UI thật trong desktop/src.

Dùng lại tokenizer của i18n_inventory (không đếm comment). Mỗi chuỗi VN:
  • gán NAMESPACE theo đường dẫn file  (preprocess.dataMerge, imposition.grid…)
  • sinh KEY = slug ASCII hoá từ chính chuỗi (ổn định, người đọc hiểu được)
  • va key trong cùng namespace → thêm hậu tố _2/_3

Xuất:
  desktop/src/i18n/locales/vi.json   # key → chuỗi VN gốc  (source of truth)
  desktop/src/i18n/locales/en.json   # key → ""  (chờ dịch; fallback vi khi rỗng)
  scripts/i18n_keymap.json           # {namespace: {key: {vi, files:[...], kind}}}  để review

Chạy:  python scripts/i18n_gen_skeleton.py
       python scripts/i18n_gen_skeleton.py --dry   # chỉ in thống kê, không ghi
"""
from __future__ import annotations
import os, re, sys, json, argparse

sys.stdout.reconfigure(encoding="utf-8")

# Dùng lại logic đã kiểm chứng trong i18n_inventory
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from i18n_inventory import tokenize_ts, has_vn, JSX_TEXT_RE, walk, FE_DIR, ROOT  # noqa: E402

I18N_DIR = os.path.join(FE_DIR, "i18n", "locales")

# ─────────────────────────────────────────────────────────────────────────────
# Transliterate Việt → ASCII để tạo slug key.
# ─────────────────────────────────────────────────────────────────────────────
_VN_MAP = str.maketrans({
    **{c: "a" for c in "àáảãạăằắẳẵặâầấẩẫậ"},
    **{c: "e" for c in "èéẻẽẹêềếểễệ"},
    **{c: "i" for c in "ìíỉĩị"},
    **{c: "o" for c in "òóỏõọôồốổỗộơờớởỡợ"},
    **{c: "u" for c in "ùúủũụưừứửữự"},
    **{c: "y" for c in "ỳýỷỹỵ"},
    "đ": "d",
})
_VN_MAP.update({ord(k.upper()): v.upper() for k, v in {
    "à":"a","è":"e","ì":"i","ò":"o","ù":"u","ỳ":"y","đ":"d"}.items()})
# đủ dùng: hàm slug sẽ lower() trước nên chỉ cần map thường; nhưng map hoa cho chắc.
for _base, _grp in {"a":"àáảãạăằắẳẵặâầấẩẫậ","e":"èéẻẽẹêềếểễệ","i":"ìíỉĩị",
                    "o":"òóỏõọôồốổỗộơờớởỡợ","u":"ùúủũụưừứửữự","y":"ỳýỷỹỵ","d":"đ"}.items():
    for _ch in _grp:
        _VN_MAP[ord(_ch.upper())] = _base.upper()

def slugify(text: str, maxlen: int = 40) -> str:
    t = text.translate(_VN_MAP).lower()
    t = re.sub(r"[^a-z0-9]+", "_", t).strip("_")
    if not t:
        t = "str"
    parts = t.split("_")
    out = []
    ln = 0
    for p in parts:
        if ln + len(p) + 1 > maxlen and out:
            break
        out.append(p); ln += len(p) + 1
    return "_".join(out) or "str"

# ─────────────────────────────────────────────────────────────────────────────
# File path → namespace.  Đi từ cụ thể → chung.
# ─────────────────────────────────────────────────────────────────────────────
def namespace_for(rel: str) -> str:
    p = rel.replace("\\", "/")
    base = os.path.splitext(os.path.basename(p))[0]

    # catalog tập trung
    if base in ("toolRegistry", "toolHelp"):
        return "catalog"
    if base == "SettingsModal":
        return "settings"
    if base in ("App",):
        return "shell"

    def camel(name: str) -> str:
        n = re.sub(r"(Tool|Panel|Section|Tab|Modal|Screen)$", "", name)
        return n[0].lower() + n[1:] if n else name.lower()

    if "/preprocess-tools/" in p:      return f"preprocess.{camel(base)}"
    if "/imposition-tools/" in p:      return f"imposition.{camel(base)}"
    if "/dieline-tool/" in p:          return f"dieline.{camel(base)}"
    if "/recipe/" in p:                return f"recipe.{camel(base)}"
    if "/preflight" in p.lower():      return f"preflight.{camel(base)}"
    if base.endswith("Tab"):           return f"tabs.{camel(base)}"
    if "/lib/" in p:                   return f"lib.{camel(base)}"
    if "/hooks/" in p:                 return f"hooks.{camel(base)}"
    return f"misc.{camel(base)}"

# ─────────────────────────────────────────────────────────────────────────────
def collect_fe_strings(path: str):
    """Trả list (kind, text) — text đã strip, chỉ chuỗi có dấu Việt, không trùng."""
    src = open(path, encoding="utf-8", errors="replace").read()
    seen = set(); out = []
    for kind, txt in tokenize_ts(src):
        if kind in ("string", "template"):
            inner = (txt[1:-1] if len(txt) >= 2 else txt).strip()
            if inner and has_vn(inner) and inner not in seen:
                seen.add(inner); out.append(("string", inner))
        elif kind == "code":
            for m in JSX_TEXT_RE.finditer(txt):
                t = m.group(1).strip()
                if t and has_vn(t) and t not in seen:
                    seen.add(t); out.append(("jsx", t))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="chỉ in thống kê, không ghi file")
    args = ap.parse_args()

    # keymap[ns][key] = {"vi":..., "files":[...], "kind":...}
    keymap: dict[str, dict] = {}
    # dedupe chuỗi giống nhau TRONG cùng namespace → 1 key; chuỗi giống ở ns khác → key riêng
    text_to_key: dict[tuple, str] = {}   # (ns, vi) -> key
    total_units = 0

    for path in walk(FE_DIR, (".ts", ".tsx")):
        rel = os.path.relpath(path, ROOT)
        rp = rel.replace("\\", "/")
        if rp.endswith((".test.ts", ".test.tsx")) or "/tests/" in rp or "/__tests__/" in rp:
            continue
        if "/i18n/" in rp:
            continue
        ns = namespace_for(rel)
        for kind, text in collect_fe_strings(path):
            total_units += 1
            if (ns, text) in text_to_key:
                key = text_to_key[(ns, text)]
                if rel not in keymap[ns][key]["files"]:
                    keymap[ns][key]["files"].append(rel)
                continue
            bucket = keymap.setdefault(ns, {})
            base_key = slugify(text)
            key = base_key; n = 2
            while key in bucket and bucket[key]["vi"] != text:
                key = f"{base_key}_{n}"; n += 1
            bucket[key] = {"vi": text, "files": [rel], "kind": kind}
            text_to_key[(ns, text)] = key

    ns_count = len(keymap)
    key_count = sum(len(v) for v in keymap.values())
    dup_saved = total_units - key_count

    print("═" * 60)
    print("  SKELETON LOCALE — kết quả")
    print("═" * 60)
    print(f"  namespace          : {ns_count}")
    print(f"  key duy nhất       : {key_count}")
    print(f"  chuỗi gộp (trùng)  : {dup_saved}")
    print("─" * 60)
    print("  Top namespace theo số key:")
    for ns, keys in sorted(keymap.items(), key=lambda x: -len(x[1]))[:15]:
        print(f"    {len(keys):4d}  {ns}")
    print("═" * 60)

    if args.dry:
        print("  (--dry: không ghi file)")
        return

    os.makedirs(I18N_DIR, exist_ok=True)
    # vi.json: nested {namespace: {key: vi}} — i18next dùng '.' làm keySeparator mặc định,
    # nên namespace 'preprocess.dataMerge' để FLAT ở tầng 1, không nest sâu tránh vỡ separator.
    vi = {ns: {k: v["vi"] for k, v in sorted(keys.items())} for ns, keys in sorted(keymap.items())}
    en = {ns: {k: "" for k in sorted(keys)} for ns, keys in sorted(keymap.items())}

    with open(os.path.join(I18N_DIR, "vi.json"), "w", encoding="utf-8") as f:
        json.dump(vi, f, ensure_ascii=False, indent=2)
    with open(os.path.join(I18N_DIR, "en.json"), "w", encoding="utf-8") as f:
        json.dump(en, f, ensure_ascii=False, indent=2)
    with open(os.path.join(ROOT, "scripts", "i18n_keymap.json"), "w", encoding="utf-8") as f:
        json.dump(keymap, f, ensure_ascii=False, indent=2)

    print(f"  → {os.path.relpath(os.path.join(I18N_DIR, 'vi.json'), ROOT)}")
    print(f"  → {os.path.relpath(os.path.join(I18N_DIR, 'en.json'), ROOT)}  (rỗng, chờ dịch)")
    print(f"  → scripts/i18n_keymap.json  (review: key ↔ vi ↔ file)")

if __name__ == "__main__":
    main()

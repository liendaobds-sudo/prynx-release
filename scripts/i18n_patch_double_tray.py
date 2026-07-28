#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""i18n_patch_double_tray.py — chèn key i18n cho boxType 'double_tray'.
[DOUBLE-TRAY 2026-07-26]

Chạy TRÊN MÁY ĐÍCH (repo thật):
    python3 scripts/i18n_patch_double_tray.py [repo_root]
repo_root mặc định = thư mục cha của thư mục chứa script này.

Đặc điểm:
  - Chèn theo ANCHOR văn bản (không json.dump lại toàn file → diff tối thiểu,
    giữ nguyên thứ tự/format hiện có).
  - Tự nhận EOL LF/CRLF của từng file và giữ nguyên.
  - IDEMPOTENT: key đã tồn tại trong đúng namespace thì bỏ qua (chạy 2 lần
    không nhân đôi).
  - Sau khi chèn: json.load lại + kiểm đủ key → in OK/FAIL từng file.
"""
import json
import os
import sys

# ──────────────────────────────────────────────────────────────
# Danh sách key cần chèn — (namespace, key) → {vi, en}
# ──────────────────────────────────────────────────────────────

KEYS = {}  # (ns, key) -> {"vi": ..., "en": ...}

def add(ns, key, vi, en):
    KEYS[(ns, key)] = {"vi": vi, "en": en}

# 1) dieline.param — option chọn loại + label field (anchor: hop_diem_khay)
add("dieline.param", "hop_am_duong_khay_nap",
    "⬛ Hộp âm dương (Khay + Nắp)", "⬛ Two-Piece Tray & Lid (Double Tray)")
add("dieline.param", "than_day_l_w_thanh_d_nap_tu_sinh_8t_2khe",
    "Thân đáy L × W, thành D. Nắp tự sinh: thân + 8T + 2×khe lỏng, thành D + 2T (lidD 0 = tự động).",
    "Base body L × W, wall D. Lid derived: body + 8T + 2×clearance, wall D + 2T (lidD 0 = auto).")
add("dieline.param", "cao_thanh_nap_lidd", "Cao thành nắp (0=auto)", "Lid wall height (0=auto)")
add("dieline.param", "khe_long_nap_lidgap", "Khe lỏng nắp", "Lid clearance")

# 1b) dieline.dielineCanvas2D — label preview 2D (anchor: hop_diem_khay)
add("dieline.dielineCanvas2D", "hop_am_duong_khay_nap",
    "Hộp Âm Dương (Khay + Nắp)", "Two-Piece Tray & Lid (Double Tray)")

# 2) dieline.dielineGallery — card thư viện (anchor: hop_diem_khay)
add("dieline.dielineGallery", "hop_am_duong_khay_nap",
    "Hộp Âm Dương (Khay + Nắp)", "Two-Piece Tray & Lid (Double Tray)")
add("dieline.dielineGallery", "khay_thanh_kep_nap_chup_roi",
    "Khay thành kép + nắp chụp rời", "Double-wall tray + telescoping lid")

# 3) lib.exportNestingPDF — dòng thông số trên bản in (anchor: dam_g_params_g_mm)
#    LƯU Ý: code staged truyền { lidGap } → template dùng {{lidGap}}.
add("lib.exportNestingPDF", "khe_long_nap_params_lidgap_mm",
    "Khe lỏng nắp: {{lidGap}} mm", "Lid clearance: {{lidGap}} mm")

# 4) lib.doubleTray — nhãn panel của generator (namespace MỚI, chèn theo ABC)
_SIDES = [("truoc", "trước", "Front"), ("sau", "sau", "Back"),
          ("trai", "trái", "Left"), ("phai", "phải", "Right")]
_PIECES = [("day", "đáy", "base"), ("nap", "nắp", "lid")]
for ps, pvi, pen in _PIECES:
    add("lib.doubleTray", f"than_{ps}", f"Thân {pvi}", f"{pen.capitalize()} body")
    for ss, svi, sen in _SIDES:
        add("lib.doubleTray", f"vach_{ss}_{ps}", f"Vách {svi} ({pvi})", f"{sen} wall ({pen})")
        add("lib.doubleTray", f"dam_{ss}_{ps}", f"Dầm {svi} ({pvi})", f"{sen} beam ({pen})")
        add("lib.doubleTray", f"thanh_trong_{ss}_{ps}", f"Thành trong {svi} ({pvi})", f"{sen} inner wall ({pen})")
        add("lib.doubleTray", f"mi_{ss}_{ps}", f"Mí {svi} ({pvi})", f"{sen} hem ({pen})")
    for ss, svi, sen in _SIDES[:2]:  # tai khóa: trước/sau × trái/phải
        for ls, lvi, len_ in [("trai", "trái", "left"), ("phai", "phải", "right")]:
            add("lib.doubleTray", f"tai_khoa_{ss}_{ls}_{ps}",
                f"Tai khóa {svi}-{lvi} ({pvi})", f"{sen}-{len_} lock tab ({pen})")
    for fs, fvi, fen in _SIDES[:2]:  # vạt góc: trước/sau × trái/phải
        for ls, lvi, len_ in [("trai", "trái", "left"), ("phai", "phải", "right")]:
            add("lib.doubleTray", f"vat_goc_{fs}_{ls}_{ps}",
                f"Vạt góc {fvi}-{lvi} ({pvi})", f"{fen}-{len_} corner flap ({pen})")
    # (nhãn generator: "Vạt góc trước-phải (đáy)" — cVi trước/sau, vi trái/phải)
add("lib.doubleTray", "double_tray_hop_am_duong",
    "Double Tray (Hộp Âm Dương)", "Double Tray (Two-Piece Tray & Lid)")
add("lib.doubleTray", "khay_day_nap_chup_roi_thanh_kep",
    "Khay đáy + nắp chụp rời, thành kép", "Base tray + telescoping lid, double wall")

# Anchor cấu hình: namespace → key mốc (chèn NGAY TRƯỚC dòng mốc → dấu phẩy luôn hợp lệ)
ANCHORS = {
    "dieline.param": "hop_diem_khay",
    "dieline.dielineCanvas2D": "hop_diem_khay",
    "dieline.dielineGallery": "hop_diem_khay",
    "lib.exportNestingPDF": "dam_g_params_g_mm",
}
# Namespace mới chèn nguyên block TRƯỚC một trong các namespace sau (thứ tự ABC)
NEW_NS = "lib.doubleTray"
NEW_NS_BEFORE = ["lib.envelope", "lib.exportNestingPDF", "lib.matchboxSleeve", "lib.matchboxTray"]


def patch_file(path, lang):
    raw = open(path, "rb").read()
    crlf = b"\r\n" in raw
    text = raw.decode("utf-8").replace("\r\n", "\n")
    lines = text.split("\n")

    # Dò block top-level: dòng dạng `  "ns": {` (indent 2) … đóng `  },`
    def find_block(ns):
        open_i = None
        for i, l in enumerate(lines):
            if l.strip().startswith(f'"{ns}"') and l.rstrip().endswith("{"):
                open_i = i
                break
        if open_i is None:
            return None
        depth = 0
        for j in range(open_i, len(lines)):
            depth += lines[j].count("{") - lines[j].count("}")
            if depth == 0:
                return (open_i, j)
        return None

    def block_has_key(bounds, key):
        return any(f'"{key}"' in lines[i] for i in range(bounds[0], bounds[1] + 1))

    inserted, skipped, errors = 0, 0, []

    # 1) Chèn key vào namespace sẵn có (trước dòng anchor)
    for ns, anchor in ANCHORS.items():
        pairs = [(k, v[lang]) for (n, k), v in KEYS.items() if n == ns]
        if not pairs:
            continue
        bounds = find_block(ns)
        if not bounds:
            errors.append(f"không tìm thấy block \"{ns}\"")
            continue
        anchor_i = None
        for i in range(bounds[0], bounds[1] + 1):
            if lines[i].strip().startswith(f'"{anchor}"'):
                anchor_i = i
                break
        if anchor_i is None:
            errors.append(f"không tìm thấy anchor \"{anchor}\" trong \"{ns}\"")
            continue
        indent = lines[anchor_i][: len(lines[anchor_i]) - len(lines[anchor_i].lstrip())]
        new_lines = []
        for k, val in sorted(pairs):
            if block_has_key(bounds, k):
                skipped += 1
                continue
            new_lines.append(f'{indent}"{k}": {json.dumps(val, ensure_ascii=False)},')
        if new_lines:
            lines[anchor_i:anchor_i] = new_lines
            inserted += len(new_lines)

    # 2) Namespace mới lib.doubleTray
    pairs = sorted((k, v[lang]) for (n, k), v in KEYS.items() if n == NEW_NS)
    bounds = find_block(NEW_NS)
    if bounds:
        # Block đã có (chạy lại) → chỉ bổ sung key thiếu, chèn trước key đầu tiên
        first_item = bounds[0] + 1
        indent = "    "
        for i in range(bounds[0] + 1, bounds[1]):
            if lines[i].strip().startswith('"'):
                first_item = i
                indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
                break
        new_lines = []
        for k, val in pairs:
            if block_has_key(bounds, k):
                skipped += 1
                continue
            new_lines.append(f'{indent}"{k}": {json.dumps(val, ensure_ascii=False)},')
        if new_lines:
            lines[first_item:first_item] = new_lines
            inserted += len(new_lines)
    else:
        target_i = None
        for cand in NEW_NS_BEFORE:
            b = find_block(cand)
            if b:
                target_i = b[0]
                break
        if target_i is None:
            errors.append(f"không tìm thấy vị trí chèn block \"{NEW_NS}\"")
        else:
            ns_indent = lines[target_i][: len(lines[target_i]) - len(lines[target_i].lstrip())]
            item_indent = ns_indent + "  " if ns_indent else "    "
            # dò indent item chuẩn của file (dòng đầu trong block đích)
            if target_i + 1 < len(lines):
                nxt = lines[target_i + 1]
                if nxt.strip().startswith('"'):
                    item_indent = nxt[: len(nxt) - len(nxt.lstrip())]
            block = [f'{ns_indent}"{NEW_NS}": {{']
            for idx, (k, val) in enumerate(pairs):
                comma = "," if idx < len(pairs) - 1 else ""
                block.append(f'{item_indent}"{k}": {json.dumps(val, ensure_ascii=False)}{comma}')
            block.append(f'{ns_indent}}},')
            lines[target_i:target_i] = block
            inserted += len(pairs)

    new_text = "\n".join(lines)

    # 3) Verify: parse lại + đủ key
    try:
        data = json.loads(new_text)
    except json.JSONDecodeError as e:
        print(f"FAIL {path}: JSON hỏng sau khi chèn — KHÔNG ghi file ({e})")
        return False
    missing = []
    for (ns, k) in KEYS:
        if ns not in data or k not in data[ns]:
            missing.append(f"{ns}.{k}")
    if missing:
        errors.append("thiếu key sau chèn: " + ", ".join(missing[:5]))
    if errors:
        print(f"FAIL {path}: " + "; ".join(errors))
        return False

    if inserted:
        out = new_text.replace("\n", "\r\n") if crlf else new_text
        open(path, "wb").write(out.encode("utf-8"))
    print(f"OK   {path}: chèn {inserted} key, bỏ qua {skipped} key đã có "
          f"({'CRLF' if crlf else 'LF'} giữ nguyên)")
    return True


def main():
    if len(sys.argv) > 1:
        repo = sys.argv[1]
    else:
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ok = True
    for lang in ("en", "vi"):
        path = os.path.join(repo, "desktop", "src", "i18n", "locales", f"{lang}.json")
        if not os.path.exists(path):
            print(f"FAIL {path}: không tồn tại")
            ok = False
            continue
        ok = patch_file(path, lang) and ok
    print("KẾT QUẢ:", "OK — đủ key double_tray ở cả 2 locale" if ok else "FAIL — xem lỗi ở trên")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

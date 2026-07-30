#!/usr/bin/env python3
"""Chặn lệch phiên bản crate dùng chung giữa các Cargo.lock độc lập.

KIENTRUC (audit 2026-07-29 §D.1)

Bối cảnh: repo có BỐN lockfile độc lập (`desktop/src-tauri`, `native`, `imposition_core`,
`print_engine`) chứ không phải một Cargo workspace. Hai crate lõi được dùng bởi HAI đồ thị
build khác nhau:

    imposition_core  ←  native (PyO3 → backend)  và  desktop/src-tauri (shell Tauri)
    print_engine     ←  native

Vì mỗi đồ thị tự resolve dependency, cùng một crate có thể được build trên hai nền phiên
bản khác nhau. Đã xảy ra thật: `serde` 1.0.228 (src-tauri, imposition_core) so với 1.0.229
(native, print_engine). Lệch patch thì vô hại, nhưng cơ chế sinh ra nó thì không: một ngày
nào đó `geo` hoặc `pdfium-render` lệch minor là hai bên tính hình học khác nhau — preview
đúng mà tờ in ra sai, đúng loại lỗi khó truy nhất.

Vì sao KHÔNG gộp workspace (thay vào đó là script này): workspace dồn `target/` về gốc và
xoá các lockfile con, trong khi `run_dev.bat`, `build_production.ps1` và `release_update.ps1`
gõ cứng `desktop\\src-tauri\\target\\{debug,release}` và `release_update.ps1` còn regex-sửa
`desktop\\src-tauri\\Cargo.lock`; CI cũng cố tình quét đúng bốn lockfile. Đổi sang workspace
là viết lại cả đường phát hành và phải kiểm bằng một lượt build + cài installer thật.
Script này chặn đúng RỦI RO mà workspace định chặn, với chi phí gần bằng không.

Cách dùng:
    python scripts/check_cargo_lock_skew.py            # chỉ báo lỗi khi lệch minor/major
    python scripts/check_cargo_lock_skew.py --strict    # lệch patch cũng báo lỗi

Thoát 0 = không có lệch đáng lo. Thoát 1 = có lệch (in bảng chi tiết).
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

# Crate cần canh: những crate quyết định KẾT QUẢ HÌNH HỌC / dữ liệu, được dùng bởi nhiều
# đồ thị build. Không canh toàn bộ vì hai đồ thị vốn có tập dependency khác nhau (tauri vs
# pyo3) — canh tất cả sẽ toàn nhiễu.
WATCHED = (
    "imposition_core",
    "print_engine",
    "geo",
    "pdfium-render",
    "serde",
    "serde_json",
    "image",
    "rayon",
    "lopdf",
    "tiny-skia",
    "lcms2",
    "ttf-parser",
)

LOCKFILES = (
    "desktop/src-tauri/Cargo.lock",
    "native/Cargo.lock",
    "imposition_core/Cargo.lock",
    "print_engine/Cargo.lock",
)

_ENTRY = re.compile(
    r'^\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"',
    re.MULTILINE,
)


def read_versions(lock_path: Path) -> dict[str, str]:
    text = lock_path.read_text(encoding="utf-8", errors="replace")
    return {name: version for name, version in _ENTRY.findall(text)}


def minor_key(version: str) -> str:
    """'1.0.229' → '1.0'. Dùng để phân biệt lệch patch (nhẹ) với lệch minor (nặng)."""
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="coi lệch patch cũng là lỗi (mặc định chỉ cảnh báo)",
    )
    parser.add_argument(
        "--root", default=".", help="thư mục gốc repo (mặc định: thư mục hiện tại)"
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    found: dict[str, dict[str, str]] = defaultdict(dict)
    missing: list[str] = []

    for rel in LOCKFILES:
        path = root / rel
        if not path.is_file():
            missing.append(rel)
            continue
        versions = read_versions(path)
        for crate in WATCHED:
            if crate in versions:
                found[crate][rel] = versions[crate]

    if missing:
        print("LOI: khong thay lockfile: " + ", ".join(missing))
        print("     Neu da chuyen sang Cargo workspace thi cap nhat LOCKFILES trong script nay.")
        return 1

    hard: list[str] = []
    soft: list[str] = []

    for crate in WATCHED:
        by_lock = found.get(crate)
        if not by_lock or len(by_lock) < 2:
            continue  # chỉ 1 đồ thị dùng → không có gì để lệch
        distinct = sorted(set(by_lock.values()))
        if len(distinct) == 1:
            continue
        detail = "; ".join(f"{lock} = {ver}" for lock, ver in sorted(by_lock.items()))
        line = f"  {crate}: {', '.join(distinct)}\n      {detail}"
        if len({minor_key(v) for v in distinct}) > 1:
            hard.append(line)
        else:
            soft.append(line)

    if hard:
        print("LOI: lech MINOR/MAJOR crate dung chung giua cac Cargo.lock:")
        print("\n".join(hard))
        print(
            "\n  Hai do thi build dang dung hai phien ban khac nhau cua cung mot crate.\n"
            "  Voi crate hinh hoc (geo, imposition_core, pdfium-render) day la nguy hiem THAT:\n"
            "  preview va to in co the tinh khac nhau. Dong bo bang `cargo update -p <crate>`\n"
            "  trong tung crate, hoac gop Cargo workspace (xem docstring)."
        )

    if soft:
        label = "LOI" if args.strict else "CANH BAO"
        print(f"{label}: lech PATCH crate dung chung:")
        print("\n".join(soft))
        if not args.strict:
            print("  (lech patch chua chan merge; chay voi --strict de siet)")

    if hard or (soft and args.strict):
        return 1

    if not soft:
        print("OK: khong co lech phien ban crate dung chung giua 4 lockfile.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

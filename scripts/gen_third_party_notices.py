"""Sinh THIRD_PARTY_NOTICES.md từ dữ liệu THẬT trong repo.

Vì sao phải generate thay vì viết tay: một file NOTICE viết tay sẽ lạc hậu ngay
sau lần `pip install` hoặc `npm i` kế tiếp, và một NOTICE sai còn tệ hơn không có
— nó là tuyên bố bằng văn bản rằng ta đã kiểm mà thực ra chưa.

Nguồn dữ liệu:

* Python  — `importlib.metadata` của backend/venv (đúng những gì Nuitka gói).
* Rust    — `cargo metadata` của native/, print_engine/, desktop/src-tauri/.
* npm     — desktop/package-lock.json, bù bằng node_modules/<pkg>/package.json.
* Nhị phân— scripts/bundled_components.json (khai bằng tay, xem chú thích trong đó).

Cách chạy:

    backend/venv/Scripts/python.exe scripts/gen_third_party_notices.py
    ...                            scripts/gen_third_party_notices.py --check

`--check` không ghi file, chỉ báo NOTICE có lệch thực tế hay không (dùng trong CI
và trong build_production.ps1). Thành phần có `bundled=false` luôn bị loại tự động.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "THIRD_PARTY_NOTICES.md"
COMPONENTS = Path(__file__).resolve().parent / "bundled_components.json"

CARGO_MANIFESTS = [
    REPO_ROOT / "native" / "Cargo.toml",
    REPO_ROOT / "print_engine" / "Cargo.toml",
    REPO_ROOT / "imposition_core" / "Cargo.toml",
    REPO_ROOT / "desktop" / "src-tauri" / "Cargo.toml",
]
# Crate nội bộ của PrynX — không phải third party.
OWN_CRATES = {"pdfcompare_native", "print_engine", "imposition_core", "pdf-inspector"}

# Giấy phép cần chú ý về nghĩa vụ (copyleft mạnh / lây nhiễm khi liên kết).
COPYLEFT_MARKERS = ("AGPL", "GPL-2", "GPL-3", "SSPL", "CC-BY-SA")
# MPL/LGPL/EPL: copyleft yếu — nghĩa vụ chỉ phát sinh khi SỬA source thư viện.
WEAK_COPYLEFT_MARKERS = ("MPL", "LGPL", "EPL", "CDDL")
_GENERATED_DATE_PREFIX = "*Sinh tự động ngày "


def _without_generated_date(content: str) -> str:
    """Bỏ metadata thời điểm, giữ nguyên payload pháp lý để so sánh."""
    return "\n".join(
        line
        for line in content.splitlines()
        if not line.startswith(_GENERATED_DATE_PREFIX)
    )


def _write_notice_if_changed(out_path: Path, content: str) -> bool:
    """Chỉ ghi khi payload dependency đổi; ngày chạy build không làm bẩn source."""
    if out_path.is_file():
        old = out_path.read_text(encoding="utf-8")
        if _without_generated_date(old) == _without_generated_date(content):
            return False
    out_path.write_text(content, encoding="utf-8")
    return True


def _is_strong_copyleft(license_text: str) -> bool:
    up = (license_text or "").upper()
    # "LGPL" chứa "GPL" nhưng là copyleft yếu ⇒ loại trước khi so.
    up = up.replace("LGPL", "@LGPL@")
    return any(m in up for m in COPYLEFT_MARKERS)


def _is_weak_copyleft(license_text: str) -> bool:
    up = (license_text or "").upper()
    return any(m in up for m in WEAK_COPYLEFT_MARKERS)


# ── Python ───────────────────────────────────────────────────────────────────

def _declared_python_requirements() -> set[str]:
    """Tên package khai trong requirements*.txt của backend.

    Dùng để phân biệt phụ thuộc **runtime** (Nuitka gói vào bản ship) với phụ
    thuộc chỉ có trong venv để chạy test (pytest, hypothesis…). Phân biệt này
    quan trọng: một thư viện copyleft chỉ dùng khi test thì KHÔNG phải rủi ro
    phát hành, và gộp chung sẽ tạo báo động giả.
    """
    names: set[str] = set()
    for req in (REPO_ROOT / "backend").glob("requirements*.txt"):
        for line in req.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line or line.startswith("-"):
                continue
            for sep in ("==", ">=", "<=", "~=", "!=", ">", "<", "[", ";", " "):
                if sep in line:
                    line = line.split(sep, 1)[0]
            if line:
                names.add(line.strip().lower().replace("_", "-"))
    return names


def collect_python() -> list[dict]:
    from importlib import metadata

    declared = _declared_python_requirements()
    out: list[dict] = []
    seen: set[str] = set()
    for dist in metadata.distributions():
        try:
            name = dist.metadata["Name"]
        except Exception:  # noqa: BLE001
            continue
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        canonical = name.lower().replace("_", "-")
        out.append(
            {
                "name": name,
                "version": dist.version or "?",
                "license": _python_license(dist),
                "homepage": _python_url(dist),
                # Không khai trong requirements ⇒ hoặc là phụ thuộc gián tiếp,
                # hoặc chỉ dùng để chạy test. Không chắc chắn ship.
                "declared": canonical in declared,
            }
        )
    return sorted(out, key=lambda d: d["name"].lower())


def _python_license(dist) -> str:
    meta = dist.metadata
    # PEP 639: License-Expression là nguồn chuẩn nhất khi có.
    for key in ("License-Expression", "License"):
        val = meta.get(key)
        if val and val.strip() and len(val.strip()) < 80 and "\n" not in val.strip():
            return val.strip()
    # Rất nhiều package chỉ khai giấy phép qua Trove classifier.
    classifiers = meta.get_all("Classifier") or []
    licenses = [
        c.split("::")[-1].strip()
        for c in classifiers
        if c.startswith("License ::")
    ]
    if licenses:
        return "; ".join(dict.fromkeys(licenses))
    return "CHƯA XÁC ĐỊNH"


def _python_url(dist) -> str:
    meta = dist.metadata
    if meta.get("Home-page"):
        return meta["Home-page"]
    for entry in meta.get_all("Project-URL") or []:
        if "," in entry:
            label, url = entry.split(",", 1)
            if label.strip().lower() in ("homepage", "source", "repository"):
                return url.strip()
    return ""


# ── Rust ─────────────────────────────────────────────────────────────────────

def collect_rust() -> list[dict]:
    merged: dict[str, dict] = {}
    for manifest in CARGO_MANIFESTS:
        if not manifest.is_file():
            continue
        try:
            raw = subprocess.run(
                [
                    "cargo", "metadata", "--format-version", "1",
                    "--manifest-path", str(manifest),
                ],
                capture_output=True,
                check=True,
                timeout=900,
            ).stdout
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as exc:
            print(f"  [cảnh báo] không đọc được cargo metadata cho {manifest.parent.name}: {exc}",
                  file=sys.stderr)
            continue
        data = json.loads(raw)
        for pkg in data.get("packages", []):
            name = pkg.get("name", "")
            if name in OWN_CRATES:
                continue
            key = f"{name}@{pkg.get('version', '')}"
            merged[key] = {
                "name": name,
                "version": pkg.get("version", "?"),
                "license": pkg.get("license") or pkg.get("license_file") or "CHƯA XÁC ĐỊNH",
                "homepage": pkg.get("repository") or pkg.get("homepage") or "",
            }
    return sorted(merged.values(), key=lambda d: (d["name"].lower(), d["version"]))


# ── npm ──────────────────────────────────────────────────────────────────────

def collect_npm() -> list[dict]:
    lock = REPO_ROOT / "desktop" / "package-lock.json"
    if not lock.is_file():
        return []
    data = json.loads(lock.read_text(encoding="utf-8"))
    node_modules = REPO_ROOT / "desktop" / "node_modules"
    merged: dict[str, dict] = {}

    for path, info in (data.get("packages") or {}).items():
        if not path.startswith("node_modules/"):
            continue  # gói gốc của chính dự án
        name = path.split("node_modules/")[-1]
        version = info.get("version", "?")
        license_ = info.get("license") or _npm_license_from_disk(node_modules, name)
        merged[f"{name}@{version}"] = {
            "name": name,
            "version": version,
            "license": _normalize_npm_license(license_),
            "homepage": _npm_repo(info),
            # `dev`/`devOptional` trong lockfile: chỉ cài để build/test, KHÔNG
            # nằm trong bundle Vite ⇒ không phát sinh nghĩa vụ phân phối.
            "dev_only": bool(info.get("dev") or info.get("devOptional")),
        }
    return sorted(merged.values(), key=lambda d: (d["name"].lower(), d["version"]))


def _npm_license_from_disk(node_modules: Path, name: str) -> str:
    pkg_json = node_modules / name / "package.json"
    if not pkg_json.is_file():
        return ""
    try:
        return json.loads(pkg_json.read_text(encoding="utf-8")).get("license", "")
    except (json.JSONDecodeError, OSError):
        return ""


def _normalize_npm_license(value) -> str:
    if isinstance(value, dict):
        return value.get("type", "CHƯA XÁC ĐỊNH")
    if isinstance(value, list):
        return "; ".join(_normalize_npm_license(v) for v in value)
    return (value or "CHƯA XÁC ĐỊNH").strip() or "CHƯA XÁC ĐỊNH"


def _npm_repo(info: dict) -> str:
    repo = info.get("repository")
    if isinstance(repo, dict):
        return repo.get("url", "")
    if isinstance(repo, str):
        return repo
    return info.get("homepage", "") or ""


# ── Kết xuất ─────────────────────────────────────────────────────────────────

def load_native() -> list[dict]:
    data = json.loads(COMPONENTS.read_text(encoding="utf-8"))
    out = []
    for c in data["native_components"]:
        if not c.get("bundled", True):
            continue
        out.append(c)
    return out


def _ships(kind: str, item: dict) -> bool:
    """Thành phần này có nằm trong bản phát hành không?

    Chỉ thứ **thực sự ship** mới được đưa vào mục cảnh báo giấy phép. Gộp cả công
    cụ chỉ dùng lúc build vào đó sẽ tạo báo động giả, và một danh sách cảnh báo
    đầy thứ vô hại là danh sách sẽ bị bỏ qua.
    """
    if kind == "npm":
        return not item.get("dev_only", False)
    if kind == "python":
        return item.get("declared", False)
    # Nhị phân đóng gói và crate Rust: đều nằm trong binary phát hành.
    return True


def license_summary(
    groups: dict[str, list[dict]]
) -> tuple[list[str], list[str], list[str]]:
    """Trả (copyleft mạnh khi ship, copyleft yếu khi ship, copyleft mạnh chỉ build)."""
    strong: set[str] = set()
    weak: set[str] = set()
    build_only_strong: set[str] = set()

    for kind, items in groups.items():
        for it in items:
            lic = it.get("license", "")
            label = f"{it['name']} {it.get('version', '')} — {lic}"
            if _is_strong_copyleft(lic):
                if _ships(kind, it):
                    strong.add(label)
                else:
                    build_only_strong.add(label)
            elif _is_weak_copyleft(lic) and _ships(kind, it):
                weak.add(label)
    return sorted(strong), sorted(weak), sorted(build_only_strong)


def render() -> str:
    native = load_native()
    python_pkgs = collect_python()
    rust_pkgs = collect_rust()
    npm_pkgs = collect_npm()

    groups = {
        "native": native,
        "python": python_pkgs,
        "rust": rust_pkgs,
        "npm": npm_pkgs,
    }
    strong, weak, build_only_strong = license_summary(groups)

    lines: list[str] = []
    add = lines.append

    add("# Thông báo về phần mềm của bên thứ ba (Third-Party Notices)")
    add("")
    add("PrynX sử dụng các thành phần mã nguồn mở dưới đây. Bản quyền thuộc về các")
    add("tác giả tương ứng; mỗi thành phần được phân phối theo giấy phép của nó.")
    add("")
    add(f"*Sinh tự động ngày {date.today().isoformat()} bằng "
        "`scripts/gen_third_party_notices.py`. Đừng sửa tay — sửa nguồn dữ liệu "
        "rồi chạy lại script.*")
    add("")
    add("> Đây không phải tư vấn pháp lý. Tài liệu này liệt kê thành phần và giấy")
    add("> phép để phục vụ nghĩa vụ ghi công; việc đánh giá tuân thủ là việc riêng.")
    add("")

    # ── Phần quan trọng nhất: đặt lên đầu ─────────────────────────────────
    add("## 1. Thành phần cần chú ý nghĩa vụ giấy phép")
    add("")
    add("Mục này chỉ tính thành phần **có trong bản phát hành**. Công cụ chỉ dùng")
    add("lúc build/test được tách riêng ở cuối mục, vì chúng không phát sinh nghĩa")
    add("vụ phân phối.")
    add("")
    add("### Copyleft mạnh — CÓ trong bản phát hành")
    add("")
    if strong:
        add("Nghĩa vụ có thể lan sang sản phẩm khi phân phối. Cần xử lý dứt điểm,")
        add("không để tồn tại trong bản phát hành mà chưa có quyết định.")
        add("")
        for item in strong:
            add(f"- **{item}**")
        add("")
    else:
        add("Không có. Bản đóng gói này không chứa thành phần copyleft mạnh.")
        add("")

    if build_only_strong:
        add("### Copyleft mạnh — CHỈ dùng lúc build/test (không phát sinh nghĩa vụ)")
        add("")
        for item in build_only_strong:
            add(f"- {item}")
        add("")

    if weak:
        add("### Copyleft yếu (MPL / LGPL / EPL / CDDL)")
        add("")
        add("Nghĩa vụ chỉ phát sinh khi **sửa** mã nguồn của chính thư viện đó.")
        add("PrynX dùng nguyên bản, không sửa.")
        add("")
        for item in weak:
            add(f"- {item}")
        add("")

    # ── Nhị phân đóng gói ─────────────────────────────────────────────────
    add("## 2. Thành phần nhị phân đóng gói trong installer")
    add("")
    add("| Thành phần | Phiên bản | Giấy phép | Cách dùng | Vị trí |")
    add("|---|---|---|---|---|")
    for c in native:
        add(
            f"| [{c['name']}]({c['homepage']}) | {c['version']} | {c['license']} "
            f"| {c['used_for']} | `{c['bundled_path']}` |"
        )
    add("")
    for c in native:
        if not c.get("notes") and not c.get("source"):
            continue
        add(f"### {c['name']}")
        add("")
        add(f"- Giấy phép: **{c['license']}**")
        add(f"- Liên kết: {c['linkage']}")
        if c.get("source"):
            add(f"- Mã nguồn: {c['source']}")
        if c.get("notes"):
            add(f"- Ghi chú: {c['notes']}")
        if c.get("license_text"):
            license_text = c["license_text"]
            if isinstance(license_text, list):
                license_text = "\n".join(license_text)
            add("- Toàn văn giấy phép đi kèm bản phân phối:")
            add("")
            add("```text")
            add(str(license_text))
            add("```")
        add("")

    # ── Danh sách phụ thuộc ───────────────────────────────────────────────
    add("## 3. Thư viện Python")
    add("")
    add("Cột *Phạm vi*: `phát hành` = khai trong `backend/requirements*.txt`;")
    add("`build/test` = phụ thuộc gián tiếp hoặc chỉ dùng để chạy test.")
    add("")
    add(_table(python_pkgs, "python"))
    add("")
    add("## 4. Crate Rust")
    add("")
    add("Toàn bộ crate được liên kết vào `pdfcompare_native` và bản Tauri, nên coi")
    add("là có trong bản phát hành.")
    add("")
    add(_table(rust_pkgs, "rust"))
    add("")
    add("## 5. Gói npm (giao diện)")
    add("")
    add("Danh sách gồm **toàn bộ** đồ thị phụ thuộc. Liệt kê thừa là an toàn; thiếu")
    add("thì không. Cột *Phạm vi* lấy từ cờ `dev` trong `package-lock.json`.")
    add("")
    add(_table(npm_pkgs, "npm"))
    add("")

    add("## 6. Thống kê")
    add("")
    add(f"- Nhị phân đóng gói: {len(native)}")
    add(f"- Thư viện Python: {len(python_pkgs)}")
    add(f"- Crate Rust: {len(rust_pkgs)}")
    add(f"- Gói npm: {len(npm_pkgs)}")
    add("")
    add(_license_histogram(groups))
    add("")
    return "\n".join(lines) + "\n"


def _table(items: list[dict], kind: str = "") -> str:
    if not items:
        return "*(không có)*"
    show_scope = kind in ("npm", "python")
    header = "| Tên | Phiên bản | Giấy phép |"
    sep = "|---|---|---|"
    if show_scope:
        header += " Phạm vi |"
        sep += "---|"
    rows = [header, sep]
    for it in items:
        name = it["name"]
        if it.get("homepage"):
            url = it["homepage"].removeprefix("git+").removesuffix(".git")
            if url.startswith(("http://", "https://")):
                name = f"[{name}]({url})"
        row = f"| {name} | {it['version']} | {it['license']} |"
        if show_scope:
            row += f" {'phát hành' if _ships(kind, it) else 'build/test'} |"
        rows.append(row)
    return "\n".join(rows)


def _license_histogram(groups: dict[str, list[dict]]) -> str:
    counter: dict[str, int] = defaultdict(int)
    for items in groups.values():
        for it in items:
            counter[it.get("license", "CHƯA XÁC ĐỊNH")] += 1
    top = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:15]
    rows = ["| Giấy phép | Số thành phần |", "|---|---|"]
    rows += [f"| {lic} | {n} |" for lic, n in top]
    unknown = counter.get("CHƯA XÁC ĐỊNH", 0)
    out = "\n".join(rows)
    if unknown:
        out += (
            f"\n\n{unknown} thành phần không khai giấy phép trong metadata — "
            "cần tra thủ công trước khi phát hành."
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Sinh THIRD_PARTY_NOTICES.md")
    ap.add_argument("--check", action="store_true",
                    help="chỉ kiểm tra NOTICE có khớp thực tế, không ghi file")
    ap.add_argument("--out", default=str(OUTPUT))
    args = ap.parse_args()

    content = render()
    out_path = Path(args.out)

    if args.check:
        if not out_path.is_file():
            print(f"THIẾU {out_path.name} — chạy scripts/gen_third_party_notices.py")
            return 1
        old = out_path.read_text(encoding="utf-8")
        if _without_generated_date(old) != _without_generated_date(content):
            print(f"{out_path.name} đã LỆCH so với phụ thuộc thực tế — chạy lại generator.")
            return 1
        print(f"{out_path.name} khớp với phụ thuộc thực tế.")
        return 0

    if _write_notice_if_changed(out_path, content):
        print(f"Đã ghi {out_path} ({len(content.splitlines())} dòng)")
    else:
        print(f"{out_path.name} đã khớp payload; giữ nguyên để build không tự làm bẩn source.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

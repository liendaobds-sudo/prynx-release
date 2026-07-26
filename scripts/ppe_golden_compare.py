"""So sánh kẽm của PrynX Print Engine (PPE) với Ghostscript tiffsep.

Đây là bộ đo golden của Phase 0: nó KHÔNG kết luận PPE đúng hay sai, nó cho ra
con số để quyết định. Ghostscript ở đây chỉ là **công cụ tham chiếu ở máy dev** —
không được đóng gói vào bản ship, và không đọc source GS (clean-room).

Cách chạy:

    python scripts/ppe_golden_compare.py backend/tests/preflight_fixtures/pdfs
    python scripts/ppe_golden_compare.py file.pdf --page 1 --dpi 100

Cột kết quả:

    max_tac    Tổng mực lớn nhất trên trang (%) — chỉ số quyết định gate TAC.
    d_tac      Sai lệch TAC của PPE so với GS, tính theo ĐIỂM phần trăm.
               Dấu ÂM là nguy hiểm (PPE báo ít mực hơn thực tế → false-clean).
    mae        Sai lệch tuyệt đối trung bình trên từng kẽm, thang 0..255.
    plates     Số kẽm hai bên tìm được (phải khớp; lệch nghĩa là mất spot).

Ngưỡng đề xuất (khớp phản biện plan §6.2):
    - vùng solid: mae < 3/255
    - TAC: under-report <= 2 điểm (cứng), over-report <= 10 điểm
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover
    print("Cần numpy + Pillow. Chạy bằng backend/venv/Scripts/python.exe.", file=sys.stderr)
    raise

REPO_ROOT = Path(__file__).resolve().parent.parent
PROCESS_NAMES = ("Cyan", "Magenta", "Yellow", "Black")
SRGB_PROFILE = REPO_ROOT / "backend" / "app" / "assets" / "icc" / "sRGB.icc"
# Profile CMYK dùng làm **ánh xạ đồng nhất** ở chế độ đo mực. Xem `run_gs_tiffsep`.
CMYK_IDENTITY_PROFILE = REPO_ROOT / "backend" / "app" / "assets" / "icc" / "FOGRA39.icc"
# Cùng font thay thế mà facade dùng ở đường chạy thật.
FALLBACK_FONT = REPO_ROOT / "backend" / "app" / "assets" / "fonts" / "DejaVuSans.ttf"

# Ngưỡng gate — cố tình BẤT ĐỐI XỨNG cho TAC.
# Báo thiếu mực khiến file quá ngưỡng bị coi là đạt (false-clean) → hỏng lô in.
# Báo thừa mực chỉ gây cảnh báo oan → tốn thời gian, không tốn tiền giấy.
TAC_UNDER_REPORT_LIMIT = 2.0
TAC_OVER_REPORT_LIMIT = 10.0
PLATE_MAE_LIMIT = 3.0

# Fixture mà PPE **cố ý** khác Ghostscript, kèm con số lệch mong đợi.
#
# Vì sao pin bằng số thay vì chỉ ghi tên: một danh sách miễn trừ theo tên sẽ che luôn
# mọi hồi quy trên fixture đó. Pin `(d_tac, dung_sai)` thì lệch đúng như dự kiến là
# PASS, còn lệch khác đi vẫn FAIL.
#
# `oc_print_state_off`: lớp hiện trên màn hình nhưng khai `/Usage /Print /PrintState
# /OFF`. Ghostscript đọc cấu hình mặc định `/D` và **bỏ qua** `/AS`, nên nó vẫn in lớp
# đó (100% mực). PPE đọc cấu hình in vì nó đo mực sẽ lên giấy (0%). Acrobat và các RIP
# hiện đại theo phía PPE.
INTENTIONAL_DIVERGENCE: dict[str, tuple[float, float, str]] = {
    "oc_print_state_off.pdf": (
        -100.0,
        1.0,
        "GS bỏ qua /AS nên vẫn in lớp khai không-in; PPE theo cấu hình in",
    ),
}


@dataclass
class PlateStats:
    name: str
    is_spot: bool
    ink: "np.ndarray"  # 0..255, 255 = 100% mực


@dataclass
class PageStats:
    width: int
    height: int
    plates: dict[str, PlateStats] = field(default_factory=dict)
    degraded: bool = False
    dropped_objects: int = 0
    skipped_ops: list[str] = field(default_factory=list)
    approximated_colorspaces: list[str] = field(default_factory=list)
    colorspaces_used: list[str] = field(default_factory=list)
    ink_unsound: bool = False
    geometry_approximate: bool = False
    substituted_fonts: list[str] = field(default_factory=list)

    def max_tac(self) -> float:
        if not self.plates:
            return 0.0
        total = None
        for p in self.plates.values():
            arr = p.ink.astype(np.float32)
            total = arr if total is None else total + arr
        return float(total.max()) / 255.0 * 100.0


def find_ghostscript() -> str | None:
    """Dò Ghostscript theo đúng thứ tự backend/app/config.py dùng."""
    env = os.environ.get("GHOSTSCRIPT_PATH", "")
    if env and os.path.isfile(env):
        return env
    for name in ("gswin64c", "gswin32c", "gs"):
        found = shutil.which(name)
        if found:
            return found
    base = Path(r"C:\Program Files\gs")
    if base.is_dir():
        cands = sorted(base.glob("gs*/bin/gswin64c.exe"), reverse=True)
        if cands:
            return str(cands[0])
    return None


def run_gs_tiffsep(gs: str, pdf: Path, page: int, dpi: int, icc: Path | None = None) -> PageStats:
    """Chạy tiffsep với ĐÚNG cờ mà app đang dùng.

    Bất kỳ lệch cờ nào ở đây (ICC, alpha bits, UseFastColor) sẽ làm phép so sánh
    vô nghĩa. Khử răng cưa luôn tắt ở cả hai bên để chỉ còn khác biệt về màu.

    Hai chế độ:

    * `icc = None` — đường **đo mực**: `-dUseFastColor=true`, không ICC. Đúng cho
      nội dung DeviceCMYK (vùng đặc phải đọc 400%), nhưng với RGB thì GS không
      sinh đen (RGB đen → C+M+Y = 300%) nên số đó không dùng để đối chiếu được.
    * `icc = FOGRA39.icc` — đường **quản lý màu**: cả hai bên quy đổi RGB qua ICC.
      Lưu ý GS ở chế độ này cũng đưa DeviceCMYK qua ICC, nén vùng đặc xuống ~292%;
      PPE cố ý KHÔNG làm vậy. Nên chế độ này chỉ dùng để đối chiếu nội dung RGB.
    """
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / "plate"
        cmd = [
            gs,
            "-sDEVICE=tiffsep",
            "-dNOPAUSE", "-dBATCH", "-dNOSAFER", "-dQUIET",
            f"-dFirstPage={page}", f"-dLastPage={page}",
            f"-r{dpi}",
            "-dGraphicsAlphaBits=1",
            "-dTextAlphaBits=1",
            "-dMaxSpots=32",
            # `-dSimulateOverprint` đã bị GS 10.x loại bỏ — nó chỉ in cảnh báo rồi
            # chạy tiếp với mặc định, nên bộ đo đã im lặng so PPE (có overprint) với
            # GS (không overprint) trong suốt thời gian dùng cờ đó.
            "-sOverprint=simulate",
        ]
        if icc:
            cmd += [
                "-dUseFastColor=false",
                f"-sDefaultCMYKProfile={icc}",
                "-dOverrideICC=true",
            ]
            # Ép GS dùng đúng profile RGB nguồn mà PPE dùng. Không có dòng này,
            # GS dùng `default_rgb.icc` riêng của nó và phép so sẽ đo chênh lệch
            # giữa hai profile chứ không đo chất lượng engine.
            if SRGB_PROFILE.is_file():
                cmd += [f"-sDefaultRGBProfile={SRGB_PROFILE}"]
            # Profile ĐÍCH. Đây là chỗ dễ hiểu sai nhất trong kiến trúc màu của
            # Ghostscript: `-sDefaultCMYKProfile` là profile **nguồn** để hiểu dữ
            # liệu DeviceCMYK trong file, KHÔNG phải profile để kết xuất. Không
            # đặt `-sOutputICCProfile` thì GS kết xuất ra profile CMYK mặc định
            # dựng sẵn của nó, và mọi so sánh "theo FOGRA39" trở thành so với một
            # profile khác.
            cmd += [f"-sOutputICCProfile={icc}"]
            # Và ép luôn intent + bù điểm đen cho khớp ColorManager của PPE.
            cmd += ["-dRenderIntent=1", "-dBlackPtComp=1"]
        else:
            # KHÔNG dùng `-dUseFastColor=true`: đường fast color của Ghostscript bỏ
            # qua toàn bộ logic overprint (đo được: K-only overprint trên Cyan cho
            # 100% thay vì 200%). Thay vào đó tắt fast color và đặt **cùng một**
            # profile CMYK cho nguồn và đích ⇒ DeviceCMYK→DeviceCMYK là ánh xạ đồng
            # nhất, vùng đặc vẫn đọc đúng 400%, mà overprint được tính.
            cmd += ["-dUseFastColor=false"]
            if CMYK_IDENTITY_PROFILE.is_file():
                cmd += [
                    f"-sDefaultCMYKProfile={CMYK_IDENTITY_PROFILE}",
                    f"-sOutputICCProfile={CMYK_IDENTITY_PROFILE}",
                    "-dOverrideICC=true",
                    "-dRenderIntent=1",
                    "-dBlackPtComp=1",
                ]
            else:
                cmd = [c for c in cmd if c != "-dUseFastColor=false"]
                cmd += ["-dUseFastColor=true"]
                print(
                    "  CẢNH BÁO: không có FOGRA39.icc ⇒ dùng fast color, GS sẽ KHÔNG "
                    "tính overprint.",
                    file=sys.stderr,
                )
        cmd += [
            f"-sOutputFile={base}.tif",
            str(pdf),
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=600)
        stderr_text = proc.stderr.decode("utf-8", "replace")
        if proc.returncode != 0:
            raise RuntimeError(f"GS thất bại ({proc.returncode}): {stderr_text[:300]}")
        # Cờ đã bị loại bỏ KHÔNG làm GS trả mã lỗi. Không đọc stderr thì bộ đo sẽ
        # tiếp tục so với một cấu hình khác cấu hình mình nghĩ mình đang dùng.
        if "no longer supported" in stderr_text:
            dead = [
                ln.strip() for ln in stderr_text.splitlines() if "no longer supported" in ln
            ]
            raise RuntimeError("GS có cờ đã bị loại bỏ: " + "; ".join(dead[:3]))

        stats = PageStats(width=0, height=0)
        for entry in sorted(os.listdir(tmp)):
            if not entry.endswith(".tif") or entry == "plate.tif":
                continue
            name = _plate_name(entry)
            if name is None:
                continue
            img = Image.open(Path(tmp) / entry)
            arr = np.array(img)
            if stats.width == 0:
                stats.width, stats.height = img.size
            # tiffsep nghịch đảo: 255 = KHÔNG mực.
            ink = (255 - arr).astype(np.uint8)
            stats.plates[name] = PlateStats(name, name not in PROCESS_NAMES, ink)
        return stats


def _plate_name(filename: str) -> str | None:
    for pattern in (r"^plate\((.+)\)\.tif$", r"^plate\.(.+)\.tif$", r"^plate\d*\((.+)\)\.tif$"):
        m = re.match(pattern, filename)
        if m:
            return m.group(1)
    return None


def run_ppe(pdf: Path, page: int, dpi: int, icc: Path | None = None) -> PageStats:
    """Chạy PPE qua example `plate_stats`.

    Dùng đường JSON thay vì FFI để bộ đo golden không phụ thuộc việc đã build
    xong lớp binding Python — đo được engine từ rất sớm.
    """
    exe = _ppe_binary()
    proc = subprocess.run(
        [
            str(exe),
            str(pdf),
            str(page),
            str(dpi),
            "ink",
            str(icc) if icc else "",
            # Cùng profile RGB nguồn với GS: nếu hai bên khác profile nguồn thì
            # chênh lệch đo được là chênh lệch profile, không phải chất lượng.
            str(SRGB_PROFILE) if icc and SRGB_PROFILE.is_file() else "",
            # Font thay thế — PHẢI khớp thứ facade truyền ở đường chạy thật.
            # Ghostscript cũng thay font không nhúng bằng bộ font URW của nó, nên
            # nếu PPE không thay thì phép so là so "có vẽ chữ" với "không vẽ chữ",
            # và bộ đo lại đang đo một cấu hình khác cấu hình sản phẩm.
            str(FALLBACK_FONT) if FALLBACK_FONT.is_file() else "",
        ],
        capture_output=True,
        timeout=600,
    )
    out = proc.stdout.decode("utf-8", "replace").strip()
    if not out:
        raise RuntimeError(
            f"PPE không trả kết quả: {proc.stderr.decode('utf-8', 'replace')[:300]}"
        )
    data = json.loads(out.splitlines()[-1])
    if "error" in data:
        raise RuntimeError(f"PPE lỗi: {data['error']}")

    stats = PageStats(
        width=data["width"],
        height=data["height"],
        degraded=data.get("degraded", False),
        dropped_objects=data.get("dropped_objects", 0),
        skipped_ops=[o["op"] for o in data.get("skipped_ops", [])],
        approximated_colorspaces=data.get("approximated_colorspaces", []),
        colorspaces_used=data.get("colorspaces_used", []),
        ink_unsound=data.get("ink_unsound", False),
        geometry_approximate=data.get("geometry_approximate", False),
        substituted_fonts=data.get("substituted_fonts", []),
    )
    # `plate_stats` chỉ trả thống kê, không trả pixel — đủ để so TAC/max/mean.
    stats._summary = {p["name"]: p for p in data["plates"]}  # type: ignore[attr-defined]
    stats._max_tac = data["max_tac_pct"]  # type: ignore[attr-defined]
    return stats


def _ppe_binary() -> Path:
    """Build (nếu cần) và trả đường dẫn example đã compile."""
    manifest = REPO_ROOT / "print_engine" / "Cargo.toml"
    subprocess.run(
        ["cargo", "build", "--release", "--quiet", "--example", "plate_stats",
         "--manifest-path", str(manifest)],
        check=True,
        timeout=1800,
    )
    exe = REPO_ROOT / "print_engine" / "target" / "release" / "examples"
    for name in ("plate_stats.exe", "plate_stats"):
        if (exe / name).is_file():
            return exe / name
    raise FileNotFoundError("không tìm thấy example plate_stats đã build")


@dataclass
class Comparison:
    pdf: str
    gs_tac: float
    ppe_tac: float
    gs_plates: list[str]
    ppe_plates: list[str]
    worst_mae: float
    degraded: bool
    skipped: list[str]
    approximated: list[str] = field(default_factory=list)
    colorspaces_used: list[str] = field(default_factory=list)
    dropped: int = 0
    color_managed: bool = False
    ink_unsound: bool = False
    geometry_approximate: bool = False
    substituted_fonts: list[str] = field(default_factory=list)
    note: str = ""

    @property
    def d_tac(self) -> float:
        return self.ppe_tac - self.gs_tac

    @property
    def plates_match(self) -> bool:
        return sorted(self.gs_plates) == sorted(self.ppe_plates)

    def verdict(self) -> str:
        # Thứ tự kiểm rất quan trọng: phải phân biệt "PPE chưa vẽ được" với "phép
        # so sánh vô nghĩa". Gộp hai thứ này lại sẽ che mất việc pipeline hình học
        # đã đúng và chỉ còn thiếu quản lý màu.
        # Chỉ trục `ink_unsound` mới làm kết quả không so được. `geometry_approximate`
        # (font không nhúng đã thay) VẪN so được: chữ đã lên mực, đỉnh TAC vẫn đúng,
        # chỉ diện tích phủ là xấp xỉ — và chính đó là cấu hình sản phẩm đang chạy.
        expected = INTENTIONAL_DIVERGENCE.get(self.pdf)
        if expected is not None:
            want, tol, _ = expected
            if abs(self.d_tac - want) <= tol:
                return "KHÁC GS (có chủ ý)"
            return "FAIL (lệch khác dự kiến)"
        if self.ink_unsound:
            return "CHƯA ĐỦ TÍNH NĂNG"
        if self.dropped > 0 and not self.approximated:
            return "CHƯA ĐỦ TÍNH NĂNG"
        # Ghi chú: trước đây ở đây có luật loại nội dung DeviceCMYK khỏi phép so,
        # vì GS nén vùng đặc 400% → ~292%. Nguyên nhân thật không phải "GS nén
        # CMYK" mà là bộ đo thiếu `-sOutputICCProfile`, khiến GS kết xuất ra
        # profile CMYK mặc định của nó thay vì FOGRA39. Sau khi đặt đúng profile
        # đích, đường CMYK→CMYK thành ánh xạ đồng nhất và hai bên khớp 0.00.
        # Luật đó đã bỏ: nó che một lỗi cấu hình thay vì phơi ra.
        if self.approximated:
            # Nội dung RGB/Lab: cả GS (UseFastColor) và PPE đều đang quy đổi
            # KHÔNG qua ICC, mỗi bên một công thức tuỳ tiện. So hai con số đó
            # không nói được bên nào đúng — chỉ ICC mới trả lời được.
            return "KHÔNG SO ĐƯỢC (thiếu ICC)"
        if self.d_tac < -TAC_UNDER_REPORT_LIMIT:
            return "FAIL (báo thiếu mực)"
        if self.d_tac > TAC_OVER_REPORT_LIMIT:
            return "FAIL (báo thừa mực)"
        if not self.plates_match:
            return "FAIL (lệch số kẽm)"
        if self.worst_mae > PLATE_MAE_LIMIT:
            return "FAIL (mean kẽm)"
        if self.geometry_approximate:
            # Đạt ngưỡng, nhưng nói rõ là đạt với font thay thế: hình glyph khác
            # bản gốc nên con số diện tích phủ không phải con số của file thật.
            return "PASS (font thay thế)"
        return "PASS"


def compare(pdf: Path, gs: str, page: int, dpi: int, icc: Path | None = None) -> Comparison:
    gs_stats = run_gs_tiffsep(gs, pdf, page, dpi, icc)
    ppe_stats = run_ppe(pdf, page, dpi, icc)

    gs_tac = gs_stats.max_tac()
    ppe_tac = getattr(ppe_stats, "_max_tac", 0.0)
    summary = getattr(ppe_stats, "_summary", {})

    note = ""
    if (gs_stats.width, gs_stats.height) != (ppe_stats.width, ppe_stats.height):
        note = f"khổ raster lệch: GS {gs_stats.width}x{gs_stats.height} vs PPE {ppe_stats.width}x{ppe_stats.height}"

    # So mean mỗi kẽm (thang 0..255) cho các kẽm có ở cả hai bên.
    worst = 0.0
    for name, gp in gs_stats.plates.items():
        if name not in summary:
            continue
        gs_mean = float(gp.ink.mean())
        ppe_mean = float(summary[name]["mean_pct"]) / 100.0 * 255.0
        worst = max(worst, abs(gs_mean - ppe_mean))

    return Comparison(
        pdf=pdf.name,
        gs_tac=gs_tac,
        ppe_tac=ppe_tac,
        gs_plates=list(gs_stats.plates.keys()),
        ppe_plates=list(summary.keys()),
        worst_mae=worst,
        degraded=ppe_stats.degraded,
        skipped=ppe_stats.skipped_ops,
        approximated=ppe_stats.approximated_colorspaces,
        colorspaces_used=ppe_stats.colorspaces_used,
        dropped=ppe_stats.dropped_objects,
        color_managed=icc is not None,
        ink_unsound=ppe_stats.ink_unsound,
        geometry_approximate=ppe_stats.geometry_approximate,
        substituted_fonts=ppe_stats.substituted_fonts,
        note=note,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="So kẽm PPE vs Ghostscript tiffsep")
    ap.add_argument("target", help="file .pdf hoặc thư mục chứa .pdf")
    ap.add_argument("--page", type=int, default=1)
    ap.add_argument("--dpi", type=int, default=100)
    ap.add_argument("--json", help="ghi kết quả ra file JSON (baseline)")
    ap.add_argument(
        "--color-managed",
        nargs="?",
        const=str(REPO_ROOT / "backend" / "app" / "assets" / "icc" / "FOGRA39.icc"),
        help="so ở chế độ quản lý màu: cả GS và PPE dùng ICC (mặc định FOGRA39)",
    )
    args = ap.parse_args()

    icc: Path | None = None
    if args.color_managed:
        icc = Path(args.color_managed)
        if not icc.is_file():
            print(f"Không tìm thấy ICC: {icc}", file=sys.stderr)
            return 2

    gs = find_ghostscript()
    if not gs:
        print("Không tìm thấy Ghostscript — không so được golden.", file=sys.stderr)
        return 2
    print(f"Ghostscript tham chiếu: {gs}")
    if icc:
        print(f"Chế độ QUẢN LÝ MÀU — ICC: {icc}")
        print(
            "Lưu ý: ở chế độ này GS cũng đưa DeviceCMYK qua ICC (vùng đặc nén\n"
            "xuống ~292%), còn PPE cố ý KHÔNG làm vậy để giữ TAC trung thực.\n"
            "Vì vậy chỉ đọc kết quả của các file nội dung RGB; file CMYK sẽ lệch\n"
            "và đó là PPE đúng, không phải PPE sai."
        )
    else:
        print("Chế độ ĐO MỰC — không ICC (đúng cho nội dung DeviceCMYK)")
    print()

    target = Path(args.target)
    pdfs = sorted(target.glob("*.pdf")) if target.is_dir() else [target]
    if not pdfs:
        print("Không có PDF nào để so.", file=sys.stderr)
        return 2

    rows: list[Comparison] = []
    for pdf in pdfs:
        try:
            rows.append(compare(pdf, gs, args.page, args.dpi, icc))
        except Exception as exc:  # noqa: BLE001
            print(f"  {pdf.name}: LỖI — {exc}")

    header = f"{'file':<28} {'gs_tac':>8} {'ppe_tac':>8} {'d_tac':>8} {'meanΔ':>7} {'kẽm':>7}  kết luận"
    print(header)
    print("-" * len(header))
    failures = 0
    for r in rows:
        verdict = r.verdict()
        if verdict.startswith("FAIL"):
            failures += 1
        plates = f"{len(r.gs_plates)}/{len(r.ppe_plates)}"
        print(
            f"{r.pdf:<28} {r.gs_tac:>8.1f} {r.ppe_tac:>8.1f} {r.d_tac:>+8.1f} "
            f"{r.worst_mae:>7.2f} {plates:>7}  {verdict}"
        )
        if r.note:
            print(f"{'':<28} ↳ {r.note}")
        if verdict.startswith("KHÁC GS"):
            print(f"{'':<28} ↳ {INTENTIONAL_DIVERGENCE[r.pdf][2]}")
        if verdict == "CHƯA ĐỦ TÍNH NĂNG" and r.skipped:
            print(f"{'':<28} ↳ PPE chưa bảo đảm: {', '.join(r.skipped[:4])}")
        elif r.approximated:
            print(f"{'':<28} ↳ {', '.join(r.approximated[:2])}")
        if r.substituted_fonts:
            print(f"{'':<28} ↳ font đã thay: {', '.join(r.substituted_fonts[:4])}")

    print()
    incomplete = sum(1 for r in rows if r.verdict() == "CHƯA ĐỦ TÍNH NĂNG")
    no_ref = sum(1 for r in rows if r.verdict().startswith("KHÔNG SO ĐƯỢC"))
    passed = sum(1 for r in rows if r.verdict().startswith("PASS"))
    substituted = sum(1 for r in rows if r.verdict() == "PASS (font thay thế)")
    divergent = sum(1 for r in rows if r.verdict().startswith("KHÁC GS"))
    print(
        f"Tổng {len(rows)} file: {passed} PASS ({substituted} với font thay thế), "
        f"{failures} FAIL, {divergent} khác GS có chủ ý, "
        f"{incomplete} chưa đủ tính năng, {no_ref} không so được (thiếu ICC)."
    )

    if args.json:
        Path(args.json).write_text(
            json.dumps(
                [
                    {
                        "pdf": r.pdf,
                        "gs_max_tac_pct": round(r.gs_tac, 3),
                        "ppe_max_tac_pct": round(r.ppe_tac, 3),
                        "delta_tac_points": round(r.d_tac, 3),
                        "worst_plate_mae_255": round(r.worst_mae, 3),
                        "worst_plate_mean_delta_255": round(r.worst_mae, 3),
                        "gs_plates": r.gs_plates,
                        "ppe_plates": r.ppe_plates,
                        "ppe_degraded": r.degraded,
                        "ppe_dropped_objects": r.dropped,
                        "ppe_skipped_ops": r.skipped,
                        "ppe_approximated_colorspaces": r.approximated,
                        "ppe_colorspaces_used": r.colorspaces_used,
                        "ppe_ink_unsound": r.ink_unsound,
                        "ppe_geometry_approximate": r.geometry_approximate,
                        "ppe_substituted_fonts": r.substituted_fonts,
                        "color_managed": r.color_managed,
                        "verdict": r.verdict(),
                    }
                    for r in rows
                ],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Đã ghi baseline: {args.json}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

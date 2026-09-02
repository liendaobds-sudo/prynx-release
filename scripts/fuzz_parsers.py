"""Harness fuzz cho các parser file KHÔNG tin cậy (PDFium / qpdf / Pillow).

Bối cảnh (pentest 2026-08-28 §ATK.04): sidecar mở file do khách đưa vào bằng những
thư viện C/C++ lớn (PDFium qua pypdfium2, qpdf qua pikepdf, codec ảnh của Pillow).
An toàn bộ nhớ *nội tại* của chúng KHÔNG kiểm được bằng đọc source — chỉ fuzz mới
lộ ra. Đây là công cụ để chạy việc đó, không phải test chặn build.

Cách dùng:

    python scripts/fuzz_parsers.py                      # 300 ca, hạt giống tự sinh
    python scripts/fuzz_parsers.py --iterations 5000    # chạy dài (theo lịch)
    python scripts/fuzz_parsers.py --seed 1234          # tái lập đúng một lượt
    python scripts/fuzz_parsers.py --corpus <thư_mục>   # dùng file mẫu của mình
    python scripts/fuzz_parsers.py --target pdfium      # chỉ một parser

Thiết kế — vì sao làm như thế này:

1. **Mỗi ca parse chạy trong MỘT PROCESS CON riêng.** Lỗi bộ nhớ của thư viện C
   không raise exception Python mà giết cả tiến trình (access violation / abort).
   Nếu fuzz trong chính process này thì lần crash đầu tiên là kết thúc phiên fuzz.
   Chạy con còn cho ta đọc **mã thoát** — đúng tín hiệu cần tìm.
2. **Phân biệt "từ chối sạch" và "sập".** Parser raise `PdfError`/`UnidentifiedImageError`
   là hành vi ĐÚNG với file rác — không tính là phát hiện. Chỉ tính khi process con
   chết bởi tín hiệu/mã thoát bất thường, hoặc treo quá `--timeout`.
3. **Đột biến chứ không sinh từ đầu.** Bắt đầu từ PDF/PNG/JPEG hợp lệ tối giản rồi
   lật byte, cắt cụt, phóng to số trong từ điển. Cách này chạm sâu vào parser hơn là
   ném byte ngẫu nhiên (byte ngẫu nhiên bị loại ngay ở bước kiểm header).
4. **Mọi ca gây sập được LƯU LẠI** vào `--outdir` kèm file `.json` mô tả (seed, target,
   mã thoát, stderr) để tái lập và báo lỗi ngược lên thượng nguồn.

KHÔNG chặn CI: script luôn trả 0 khi không phát hiện gì; trả 1 khi CÓ phát hiện, để
người chạy theo lịch dùng làm tín hiệu. Đây là công cụ điều tra, không phải cổng build.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"

TARGETS = ("pdfium", "qpdf", "pillow")

# ─────────────────────────────────────────────────────────────────────────────
# Mẫu hợp lệ tối giản để đột biến. Cố ý viết tay (không phụ thuộc fixture) để
# harness chạy được trên checkout trống.
# ─────────────────────────────────────────────────────────────────────────────


def _seed_pdf() -> bytes:
    """PDF một trang hợp lệ, có content stream + ảnh nhúng nhỏ."""
    image_raw = bytes((x * 9 + y * 5) % 256 for y in range(8) for x in range(8) for _ in range(3))
    image_data = zlib.compress(image_raw)
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources "
        b"<< /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length 74 >>\nstream\nq 60 0 0 30 10 10 cm /Im0 Do Q\nBT /F1 12 Tf 20 70 Td (fuzz) Tj ET\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB "
        b"/BitsPerComponent 8 /Filter /FlateDecode /Length "
        + str(len(image_data)).encode("ascii")
        + b" >>\nstream\n"
        + image_data
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.7\n")
    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n".encode("ascii")
        + b"%%EOF\n"
    )
    return bytes(out)


def _seed_png() -> bytes:
    """PNG 8×8 RGBA hợp lệ (có alpha để chạm nhánh mask/soft-mask)."""
    from PIL import Image

    image = Image.new("RGBA", (8, 8))
    image.putdata([((x * 31) % 256, (y * 17) % 256, 128, (x * y * 4) % 256)
                   for y in range(8) for x in range(8)])
    buffer = tempfile.SpooledTemporaryFile()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer.read()


def _seed_jpeg() -> bytes:
    from PIL import Image

    image = Image.new("RGB", (16, 16), (200, 40, 90))
    buffer = tempfile.SpooledTemporaryFile()
    image.save(buffer, format="JPEG", quality=88)
    buffer.seek(0)
    return buffer.read()


# ─────────────────────────────────────────────────────────────────────────────
# Đột biến
# ─────────────────────────────────────────────────────────────────────────────

_BIG_NUMBERS = (b"2147483647", b"-2147483648", b"4294967295", b"999999999999", b"0", b"-1")
_PDF_KEYS = (b"/Width", b"/Height", b"/Length", b"/BitsPerComponent", b"/Count", b"/Size")


def _mutate(data: bytes, rng: random.Random) -> bytes:
    """Một đột biến ngẫu nhiên. Giữ đủ 'hình dáng' file để vào sâu parser."""
    out = bytearray(data)
    strategy = rng.choice(("bitflip", "byteset", "truncate", "number", "chunkdup", "insert"))

    if strategy == "bitflip" and out:
        for _ in range(rng.randint(1, 8)):
            index = rng.randrange(len(out))
            out[index] ^= 1 << rng.randrange(8)
    elif strategy == "byteset" and out:
        for _ in range(rng.randint(1, 16)):
            out[rng.randrange(len(out))] = rng.randrange(256)
    elif strategy == "truncate" and len(out) > 32:
        # Cắt cụt: bắt các nhánh đọc quá biên/đọc thiếu.
        out = out[: rng.randint(16, len(out) - 1)]
    elif strategy == "number":
        # Thay số sau một khoá quen thuộc bằng giá trị biên — nhắm integer overflow
        # và tính toán kích thước cấp phát.
        key = rng.choice(_PDF_KEYS)
        at = out.find(key)
        if at >= 0:
            start = at + len(key)
            end = start
            while end < len(out) and out[end : end + 1] in b" 0123456789-":
                end += 1
            out[start:end] = b" " + rng.choice(_BIG_NUMBERS)
    elif strategy == "chunkdup" and len(out) > 64:
        at = rng.randrange(len(out) - 32)
        size = rng.randint(8, 32)
        out[at:at] = out[at : at + size]
    else:
        at = rng.randrange(len(out) + 1) if out else 0
        out[at:at] = bytes(rng.randrange(256) for _ in range(rng.randint(1, 24)))

    return bytes(out)


# ─────────────────────────────────────────────────────────────────────────────
# Chạy một ca trong process con
# ─────────────────────────────────────────────────────────────────────────────

# Mã thoát 7 = parser từ chối sạch (hành vi ĐÚNG). Bất kỳ mã nào khác 0/7 nghĩa là
# tiến trình chết bất thường ⇒ nghi có lỗi bộ nhớ.
_CLEAN_REJECT_EXIT = 7

_CHILD_SOURCE = r'''
import sys
target, path = sys.argv[1], sys.argv[2]
try:
    if target == "pdfium":
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(path)
        try:
            count = len(doc)
            for index in range(min(count, 2)):
                page = doc[index]
                try:
                    page.get_size()
                    bitmap = page.render(scale=0.5)
                    try:
                        bitmap.to_pil().tobytes()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        finally:
            doc.close()
    elif target == "qpdf":
        import pikepdf
        with pikepdf.Pdf.open(path) as pdf:
            len(pdf.pages)
            for obj in list(pdf.objects)[:64]:
                if isinstance(obj, pikepdf.Stream):
                    try:
                        obj.read_bytes()
                    except Exception:
                        pass
            for page in list(pdf.pages)[:2]:
                try:
                    for _ in pikepdf.parse_content_stream(page):
                        pass
                except Exception:
                    pass
    elif target == "pillow":
        from PIL import Image
        with Image.open(path) as image:
            image.load()
            image.convert("RGB").tobytes()
    else:
        sys.exit(9)
except MemoryError:
    # Bom giải nén: đây là chủ đề của §ATK.03 (đã có trần), không phải lỗi bộ nhớ.
    sys.exit(7)
except Exception:
    sys.exit(7)
sys.exit(0)
'''


@dataclass
class Findings:
    executed: int = 0
    clean_rejects: int = 0
    parsed_ok: int = 0
    timeouts: int = 0
    crashes: int = 0
    saved: list[str] = field(default_factory=list)


def _run_case(target: str, sample: bytes, suffix: str, timeout: float,
              outdir: Path, seed: int, index: int, report: Findings) -> None:
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(sample)
        case_path = Path(handle.name)

    try:
        completed = subprocess.run(
            [sys.executable, "-c", _CHILD_SOURCE, target, str(case_path)],
            capture_output=True,
            timeout=timeout,
            cwd=str(BACKEND_ROOT),
            check=False,
        )
        report.executed += 1
        code = completed.returncode
        if code == 0:
            report.parsed_ok += 1
            return
        if code == _CLEAN_REJECT_EXIT:
            report.clean_rejects += 1
            return

        report.crashes += 1
        outdir.mkdir(parents=True, exist_ok=True)
        stem = f"crash_{target}_seed{seed}_case{index}"
        crash_file = outdir / f"{stem}{suffix}"
        crash_file.write_bytes(sample)
        (outdir / f"{stem}.json").write_text(
            json.dumps(
                {
                    "target": target,
                    "seed": seed,
                    "case_index": index,
                    "exit_code": code,
                    "stderr_tail": completed.stderr.decode("utf-8", "replace")[-2000:],
                    "sample_bytes": len(sample),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        report.saved.append(str(crash_file))
        print(f"  [SẬP] {target} mã thoát {code} → đã lưu {crash_file.name}", flush=True)
    except subprocess.TimeoutExpired:
        report.executed += 1
        report.timeouts += 1
        outdir.mkdir(parents=True, exist_ok=True)
        stem = f"hang_{target}_seed{seed}_case{index}"
        hang_file = outdir / f"{stem}{suffix}"
        hang_file.write_bytes(sample)
        report.saved.append(str(hang_file))
        print(f"  [TREO] {target} vượt {timeout}s → đã lưu {hang_file.name}", flush=True)
    finally:
        try:
            case_path.unlink()
        except OSError:
            pass


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Fuzz parser file không tin cậy của PrynX")
    parser.add_argument("--iterations", type=int, default=300, help="số ca mỗi target")
    parser.add_argument("--seed", type=int, default=None, help="hạt giống để tái lập")
    parser.add_argument("--timeout", type=float, default=20.0, help="giây cho mỗi ca")
    parser.add_argument("--target", choices=TARGETS, action="append", default=None)
    parser.add_argument("--corpus", type=Path, default=None, help="thư mục file mẫu bổ sung")
    parser.add_argument(
        "--outdir",
        type=Path,
        default=ROOT / "tmp" / "fuzz_findings",
        help="nơi lưu ca gây sập/treo",
    )
    args = parser.parse_args()

    seed = args.seed if args.seed is not None else random.randrange(2**31)
    targets = tuple(dict.fromkeys(args.target)) if args.target else TARGETS
    rng = random.Random(seed)

    seeds: dict[str, list[tuple[bytes, str]]] = {
        "pdfium": [(_seed_pdf(), ".pdf")],
        "qpdf": [(_seed_pdf(), ".pdf")],
        "pillow": [(_seed_png(), ".png"), (_seed_jpeg(), ".jpg")],
    }
    if args.corpus and args.corpus.is_dir():
        for path in sorted(args.corpus.iterdir()):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            data = path.read_bytes()
            if suffix == ".pdf":
                seeds["pdfium"].append((data, ".pdf"))
                seeds["qpdf"].append((data, ".pdf"))
            elif suffix in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"):
                seeds["pillow"].append((data, suffix))

    print(f"[FUZZ] seed={seed} targets={','.join(targets)} iterations={args.iterations}/target")
    print(f"[FUZZ] phát hiện sẽ lưu vào: {args.outdir}")

    report = Findings()
    started = time.monotonic()
    for target in targets:
        pool = seeds.get(target) or []
        if not pool:
            continue
        print(f"[FUZZ] → {target} ({len(pool)} mẫu gốc)")
        for index in range(args.iterations):
            base, suffix = rng.choice(pool)
            sample = _mutate(base, rng)
            for _ in range(rng.randint(0, 2)):  # chồng nhiều lớp đột biến
                sample = _mutate(sample, rng)
            _run_case(target, sample, suffix, args.timeout, args.outdir, seed, index, report)

    elapsed = time.monotonic() - started
    print("\n[FUZZ] ── Tổng kết ──")
    print(f"  ca đã chạy      : {report.executed}")
    print(f"  parse thành công: {report.parsed_ok}")
    print(f"  từ chối sạch    : {report.clean_rejects}  (hành vi ĐÚNG với file rác)")
    print(f"  TREO            : {report.timeouts}")
    print(f"  SẬP             : {report.crashes}")
    print(f"  thời gian       : {elapsed:.1f}s")

    if report.saved:
        print("\n[FUZZ] Cần điều tra (tái lập bằng --seed ở trên):")
        for path in report.saved[:20]:
            print(f"  - {path}")
        print(
            "\n  Ca sập/treo là tín hiệu lỗi bộ nhớ trong thư viện thượng nguồn. Bước tiếp:\n"
            "  (1) kiểm bản parser đã mới nhất chưa; (2) thu nhỏ ca tái lập;\n"
            "  (3) báo lên thượng nguồn (pypdfium2/pikepdf/Pillow); (4) nếu chưa có bản vá,\n"
            "      cân nhắc cách ly process cho đúng đường parse đó."
        )
        return 1

    print("\n[FUZZ] Không phát hiện sập/treo trong lượt này.")
    print("  Lưu ý: không phát hiện KHÔNG chứng minh là an toàn — chỉ nghĩa là lượt fuzz")
    print("  này chưa chạm tới lỗi. Chạy dài hơn (--iterations lớn) và đổi seed định kỳ.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

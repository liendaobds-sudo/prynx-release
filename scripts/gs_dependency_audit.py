"""Đo phụ thuộc Ghostscript thật trên corpus — Bước 0 của lộ trình gỡ hẳn GS.

# Vì sao cần bộ đo này thay vì đọc code

Đếm số nhánh `gs_path` trong code chỉ cho biết *có bao nhiêu nhánh*, không cho biết
*nhánh nào còn được đi trên file thật*. Hai con số đó khác nhau rất xa: phần lớn
nhánh GS còn lại là fallback không bao giờ chạm tới, và một vài nhánh trông vô hại
lại là phụ thuộc cứng. Không có số đo thì mọi ước lượng công việc là đoán — và tài
liệu đã có sẵn một ví dụ: con số "22/33 file" của `OUTLINE_FONTS` là của bản
fontTools, lạc hậu ngay khi engine đổi.

# Cách đo

Chặn Ghostscript ở mức **cấu hình sản phẩm** (`PRYNX_NO_GS_BUILD=1` ⇒
`GHOSTSCRIPT_PATH` rỗng; cấu hình fallback GS đã bị xoá) rồi chạy từng đường sản
xuất trên từng file. Bốn kết quả có thể:

* `OK`      — chạy xong bằng engine nội bộ.
* `REFUSED` — dừng an toàn có lý do (fail-closed). Đây **không** phải phụ thuộc GS,
              nhưng là chức năng chưa phủ.
* `GS`      — cần Ghostscript: đường này còn phụ thuộc thật.
* `ERROR`   — nổ ngoài dự kiến; phải xem từng ca.

Bộ đếm `gs_usage` được reset trước mỗi thao tác nên `GS` là số đo, không phải suy
diễn từ thông điệp lỗi.

Chạy:
    backend\\venv\\Scripts\\python.exe scripts\\gs_dependency_audit.py private_test_corpus\\incoming
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import os
import re
import sys
import time
import traceback
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

def _configure_stdio_utf8() -> None:
    """Giữ bảng audit đọc được trên Windows PowerShell dùng bảng mã cũ."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, io.UnsupportedOperation):
            pass


_configure_stdio_utf8()

REPO = Path(__file__).resolve().parent.parent

# PHẢI đặt trước khi import app.config: `Settings` đọc marker no-GS ngay lúc dựng
# class, nên đặt sau đó thì đo một cấu hình khác cấu hình sản phẩm.
os.environ["PRYNX_NO_GS_BUILD"] = "1"
os.environ.pop("GHOSTSCRIPT_PATH", None)

sys.path.insert(0, str(REPO / "backend"))


@dataclass
class Outcome:
    status: str  # OK | REFUSED | GS | ERROR
    detail: str = ""
    gs_calls: int = 0
    seconds: float = 0.0
    extra: dict = field(default_factory=dict)


class _PpeOutlineCounter(logging.Handler):
    """Đếm glyph dùng hình học PPE so với glyph lùi về fontTools.

    Con số này là thứ quyết định `OUTLINE_FONTS` còn cần fontTools tới mức nào —
    không có nó thì "đã nối PPE" chỉ là lời khai, không phải số đo.
    """

    PATTERN = re.compile(r"(\d+) glyph dùng hình học PPE, (\d+) lùi về fontTools")

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.ppe = 0
        self.fallback = 0

    def reset(self) -> None:
        self.ppe = self.fallback = 0

    def emit(self, record) -> None:
        try:
            m = self.PATTERN.search(record.getMessage())
        except Exception:  # noqa: BLE001
            return
        if m:
            self.ppe += int(m.group(1))
            self.fallback += int(m.group(2))


OUTLINE_COUNTER = _PpeOutlineCounter()


def _run(fn) -> Outcome:
    """Chạy một thao tác, phân loại kết quả, đo số lần GS bị gọi."""
    from app.core import gs_usage
    from app.core.gs_availability import GhostscriptUnavailable, InternalEngineUnsupported

    gs_usage.reset_for_tests()
    OUTLINE_COUNTER.reset()
    started = time.perf_counter()
    try:
        status, detail, extra = fn()
    except InternalEngineUnsupported as exc:
        return Outcome("REFUSED", str(exc)[:200], gs_usage.summary()["total_gs_calls"],
                       time.perf_counter() - started)
    except GhostscriptUnavailable as exc:
        return Outcome("GS", str(exc)[:160], gs_usage.summary()["total_gs_calls"],
                       time.perf_counter() - started)
    except Exception as exc:  # noqa: BLE001
        # Thông điệp GS có thể bị nuốt rồi bọc lại ở tầng trên; nhận cả hai dấu hiệu.
        text = f"{type(exc).__name__}: {exc}"
        calls = gs_usage.summary()["total_gs_calls"]
        status = "GS" if calls or "Ghostscript" in text or "ghostscript" in text else "ERROR"
        return Outcome(status, text[:200], calls,
                       time.perf_counter() - started)
    calls = gs_usage.summary()["total_gs_calls"]
    if calls:
        status = "GS"
    if OUTLINE_COUNTER.ppe or OUTLINE_COUNTER.fallback:
        extra = dict(extra or {})
        extra["ppe_glyphs"] = OUTLINE_COUNTER.ppe
        extra["fallback_glyphs"] = OUTLINE_COUNTER.fallback
    return Outcome(status, detail[:200], calls, time.perf_counter() - started, extra or {})


# ─────────────────────────────────────────────────────────────────────────────
#  Từng đường sản xuất
# ─────────────────────────────────────────────────────────────────────────────

def op_separations(pdf: str):
    from app.core.separations import SeparationEngine

    r = asyncio.run(SeparationEngine().extract_separations(pdf, 1, 100, ink_accurate=True))
    engine = str(r.get("engine"))
    if not r.get("plates"):
        return ("REFUSED", "không tách được kẽm", {})
    if engine != "ppe":
        # `pdfium_approx` không phải phụ thuộc GS, nhưng cũng KHÔNG đủ tin để đo mực
        # — TAC sẽ bị bỏ. Ghi riêng để không lẫn với OK.
        return ("REFUSED", f"engine={engine} accuracy={r.get('accuracy')}", {})
    return ("OK", f"{len(r['plates'])} kẽm, TAC {r.get('max_tac_pct')}", {})


def op_softproof(pdf: str):
    from app.core.softproof import SoftProofEngine

    r = asyncio.run(SoftProofEngine().render_softproof(pdf, 1, "fogra39"))
    if not r.get("success"):
        return ("REFUSED", str(r.get("warning"))[:160], {})
    if r.get("engine") != "ppe+lcms":
        return ("REFUSED", f"engine={r.get('engine')}", {})
    return ("OK", "", {})


def op_overprint_preview(pdf: str):
    from app.api.routes import preflight as routes

    original = routes._get_file_path
    routes._get_file_path = lambda _id: pdf  # type: ignore[assignment]
    try:
        r = asyncio.run(
            routes.render_overprint_preview(
                routes.OverprintPreviewRequest(file_id="corpus", page=1, dpi=72)
            )
        )
    finally:
        routes._get_file_path = original  # type: ignore[assignment]
    if not r.get("success"):
        return ("REFUSED", str(r.get("error"))[:160], {})
    return ("OK", f"diff={r.get('diff_pixel_count')}", {})


def op_preflight(pdf: str):
    from app.core.preflight_engine import PreflightEngine

    report = PreflightEngine().run(pdf)
    if report is None:
        return ("REFUSED", "không dựng được báo cáo", {})
    return ("OK", "", {})


def make_action_op(action: str):
    def op(pdf: str):
        from app.core.action_engine import ActionEngine

        engine = ActionEngine()
        result = asyncio.run(engine.execute(pdf, action))
        out = getattr(result, "output_path", None)
        try:
            if not result.success:
                err = str(result.error)
                # `_run` nâng thành GS nếu engine thực sự ghi nhận một lần gọi.
                return ("REFUSED", err[:160], {})
            log0 = result.log[0] if result.log else None
            used = getattr(log0, "engine", "?")
            report = getattr(log0, "report", None) or {}
            extra = {"engine": used}
            if report.get("warnings"):
                extra["warnings"] = list(report["warnings"])[:3]
            return ("OK", f"engine={used}", extra)
        finally:
            if out and os.path.isfile(out) and out != pdf:
                try:
                    os.remove(out)
                except OSError:
                    pass

    op.__name__ = f"op_action_{action.lower()}"
    return op


def make_pdfx_op(standard: str):
    def op(pdf: str):
        from app.core.pdfx_export import PdfxExportEngine

        engine = PdfxExportEngine()
        out = asyncio.run(engine.export_pdfx(pdf, standard))
        try:
            report = engine.check_compliance(out, standard)
            # `check_compliance` trả khoá `id`/`label`, KHÔNG có `name`. Đọc sai khoá
            # ở đây từng làm bộ đo ném `KeyError` rồi tự phân loại thành ERROR — tức
            # bộ đo báo lỗi sản phẩm cho lỗi của chính nó.
            failed = [c.get("label") or c.get("id", "?") for c in report["checks"]
                      if not c["passed"]]
            extra = {"engine": engine.last_engine, "warnings": list(engine.last_warnings or [])[:3]}
            if not report["passed"]:
                return ("REFUSED", "không đạt: " + ", ".join(failed[:4]), extra)
            return ("OK", f"engine={engine.last_engine}", extra)
        finally:
            if out and os.path.isfile(out):
                try:
                    os.remove(out)
                except OSError:
                    pass

    op.__name__ = f"op_pdfx_{standard}"
    return op


def op_convert_cmyk(pdf: str):
    import tempfile

    from app.core import icc_profiles, pdf_actions_native

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "cmyk.pdf")
        r = pdf_actions_native.convert_to_cmyk(
            pdf, out,
            icc_profiles.resolve_cmyk_profile_path(),
            icc_profiles.resolve_srgb_profile_path(),
        )
        if not r.get("supported"):
            return ("REFUSED", "; ".join(r.get("blockers", []))[:160], {})
        return ("OK", "", {})


def op_convert_gray(pdf: str):
    import tempfile

    from app.core import pdf_actions_native

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "gray.pdf")
        r = pdf_actions_native.convert_to_grayscale(pdf, out)
        if not r.get("supported"):
            return ("REFUSED", "; ".join(r.get("blockers", []))[:160], {})
        return ("OK", "", {})


def op_optimize(pdf: str):
    import tempfile

    from app.core import pdf_actions_native

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "opt.pdf")
        r = pdf_actions_native.optimize_pdf(pdf, out, "ebook")
        if not r.get("supported"):
            return ("REFUSED", "; ".join(r.get("warnings", []))[:160], {})
        return ("OK", "", {})


def op_spot_to_cmyk(pdf: str):
    from app.core.ink_manager import InkManagerEngine

    out = asyncio.run(InkManagerEngine().convert_spot_to_cmyk(pdf, None))
    try:
        if not out or not os.path.isfile(out):
            return ("REFUSED", "không tạo được file", {})
        return ("OK", "", {})
    finally:
        if out and os.path.isfile(out):
            try:
                os.remove(out)
            except OSError:
                pass


OPERATIONS = [
    ("separations_ink", op_separations),
    ("softproof", op_softproof),
    ("overprint_preview", op_overprint_preview),
    ("preflight", op_preflight),
    ("act:CONVERT_TO_CMYK", make_action_op("CONVERT_TO_CMYK")),
    ("act:DOWNSCALE_IMAGES", make_action_op("DOWNSCALE_IMAGES")),
    ("act:EMBED_FONTS", make_action_op("EMBED_FONTS")),
    ("act:SET_BLACK_OVERPRINT", make_action_op("SET_BLACK_OVERPRINT")),
    ("act:FLATTEN_TRANSPARENCY", make_action_op("FLATTEN_TRANSPARENCY")),
    ("act:OUTLINE_FONTS", make_action_op("OUTLINE_FONTS")),
    ("pdfx:x4", make_pdfx_op("x4")),
    ("pdfx:x1a", make_pdfx_op("x1a")),
    ("convert_colors:cmyk", op_convert_cmyk),
    ("convert_colors:gray", op_convert_gray),
    ("optimize", op_optimize),
    ("spot_to_cmyk", op_spot_to_cmyk),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Đo phụ thuộc Ghostscript trên corpus")
    ap.add_argument("target", help="thư mục chứa .pdf hoặc một file .pdf")
    ap.add_argument("--only", help="lọc theo tên thao tác (khớp chuỗi con)")
    ap.add_argument("--limit", type=int, default=0, help="chỉ chạy N file đầu")
    ap.add_argument(
        "--resume",
        action="store_true",
        help="đọc artifact cũ và chỉ chạy file chưa có kết quả",
    )
    ap.add_argument(
        "--gate",
        action="store_true",
        help="trả mã 1 nếu còn kết quả GS hoặc ERROR; REFUSED được phép",
    )
    ap.add_argument(
        "--out",
        default=str(REPO / "tmp" / "gs_dependency_audit.json"),
        help="nơi ghi artifact JSON",
    )
    args = ap.parse_args()

    target = Path(args.target)
    files = sorted(target.glob("*.pdf")) if target.is_dir() else [target]
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("không có PDF nào để đo", file=sys.stderr)
        return 2

    ops = [(n, f) for n, f in OPERATIONS if not args.only or args.only in n]
    if not ops:
        print("không có thao tác nào khớp bộ lọc --only", file=sys.stderr)
        return 2

    from app.config import settings

    # Chốt: nếu vẫn còn đường dẫn GS thì phép đo vô nghĩa (mọi thứ sẽ báo OK nhờ GS).
    if settings.GHOSTSCRIPT_PATH:
        print(
            f"DỪNG: GHOSTSCRIPT_PATH vẫn có giá trị ({settings.GHOSTSCRIPT_PATH!r}) — "
            "phép đo sẽ sai. Kiểm PRYNX_NO_GS_BUILD.",
            file=sys.stderr,
        )
        return 2
    # GS-SUNSET (audit 2026-07-28 §FL.4): thuộc tính fallback đã bị xoá khỏi Settings.
    # getattr giữ cổng audit tương thích và không crash với hợp đồng no-GS cố định.
    if getattr(settings, "PRYNX_ALLOW_GS_FALLBACK", False):
        print("DỪNG: PRYNX_ALLOW_GS_FALLBACK vẫn bật.", file=sys.stderr)
        return 2

    logging.basicConfig(level=logging.CRITICAL)
    outline_log = logging.getLogger("app.core.outline_text")
    outline_log.addHandler(OUTLINE_COUNTER)
    outline_log.setLevel(logging.INFO)
    # Không cho log của outline nổi lên root: bảng đo phải đọc được, và bộ đếm ở
    # trên đã lấy đúng con số cần từ chính các dòng log đó.
    outline_log.propagate = False

    print(f"Corpus: {len(files)} file | thao tác: {len(ops)}")
    print(f"GHOSTSCRIPT_PATH = {settings.GHOSTSCRIPT_PATH!r}  (đã chặn)")
    print()

    out_path = Path(args.out)
    results: dict[str, dict[str, dict]] = {}
    if args.resume and out_path.is_file():
        try:
            results = json.loads(out_path.read_text(encoding="utf-8")).get("files", {})
            print(f"Tiếp tục: đã có kết quả cho {len(results)} file")
        except Exception as exc:  # noqa: BLE001
            print(f"không đọc được artifact cũ ({exc}) — chạy lại từ đầu")

    for i, pdf in enumerate(files, 1):
        if args.resume and pdf.name in results:
            continue
        print(f"[{i}/{len(files)}] {pdf.name}", flush=True)
        per_file: dict[str, dict] = {}
        for name, fn in ops:
            buf = io.StringIO()
            with _silence(buf):
                outcome = _run(lambda fn=fn: fn(str(pdf)))
            per_file[name] = {
                "status": outcome.status,
                "detail": outcome.detail,
                "gs_calls": outcome.gs_calls,
                "seconds": round(outcome.seconds, 2),
                **({"extra": outcome.extra} if outcome.extra else {}),
            }
            flag = {"OK": "  ", "REFUSED": " ~", "GS": " GS", "ERROR": " !!"}[outcome.status]
            print(f"    {flag} {name:<26} {outcome.detail[:90]}", flush=True)
        results[pdf.name] = per_file
        # Ghi sau MỖI file: một đợt đo dài bị ngắt giữa đường không được mất sạch
        # công đã chạy (đo lại corpus tốn hàng chục phút).
        _write_artifact(out_path, results, files)

    # ── Tổng hợp ───────────────────────────────────────────────────────────
    print("\n" + "=" * 78)
    print(f"{'thao tác':<26} {'OK':>4} {'REFUSED':>8} {'GS':>4} {'ERROR':>6}")
    print("-" * 78)
    files = [f for f in files if f.name in results]
    summary: dict[str, dict] = {}
    for name, _fn in ops:
        c = Counter(
            results[f.name].get(name, {}).get("status", "ERROR") for f in files
        )
        summary[name] = dict(c)
        print(f"{name:<26} {c['OK']:>4} {c['REFUSED']:>8} {c['GS']:>4} {c['ERROR']:>6}")
    print("=" * 78)

    gs_ops = [n for n, s in summary.items() if s.get("GS")]
    if gs_ops:
        print("\nCÒN PHỤ THUỘC GHOSTSCRIPT:")
        for n in gs_ops:
            bad = [
                f.name for f in files
                if results[f.name].get(n, {}).get("status") == "GS"
            ]
            print(f"  {n}: {len(bad)} file — {', '.join(bad[:4])}"
                  + (" …" if len(bad) > 4 else ""))
    else:
        print("\nKhông thao tác nào cần Ghostscript trên corpus này.")

    ppe = sum(
        (results[f.name].get("act:OUTLINE_FONTS", {}).get("extra", {}) or {}).get("ppe_glyphs", 0)
        for f in files
    )
    fb = sum(
        (results[f.name].get("act:OUTLINE_FONTS", {}).get("extra", {}) or {}).get("fallback_glyphs", 0)
        for f in files
    )
    if ppe or fb:
        print(f"\nOUTLINE_FONTS: {ppe} glyph dùng hình học PPE, {fb} lùi về fontTools")

    _write_artifact(out_path, results, files, summary)
    print(f"\nArtifact: {out_path}")
    blocking = [
        name for name, counts in summary.items()
        if counts.get("GS", 0) or counts.get("ERROR", 0)
    ]
    if args.gate and blocking:
        print("GATE THẤT BẠI: còn GS/ERROR ở " + ", ".join(blocking), file=sys.stderr)
        return 1
    return 0


def _write_artifact(out_path: Path, results: dict, files, summary: dict | None = None) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"files": results, "corpus": [f.name for f in files]}
    if summary is not None:
        payload["summary"] = summary
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )


class _silence:
    """Nuốt stdout/stderr của engine để bảng đo đọc được.

    Không nuốt logging: `OUTLINE_COUNTER` cần đọc log, và log cấu hình ở mức
    CRITICAL nên không làm bẩn màn hình.
    """

    def __init__(self, buf):
        self._buf = buf

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = self._buf

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self._out, self._err
        return False


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nđã dừng theo yêu cầu", file=sys.stderr)
        traceback.print_exc(limit=0)
        raise SystemExit(130)

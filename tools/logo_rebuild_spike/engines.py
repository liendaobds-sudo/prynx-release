"""Adapter cho các đường tích hợp VTracer, để so head-to-head trên cùng corpus.

Hai đường có NĂNG LỰC KHÁC NHAU, không phải hai bản của cùng một thứ:

* `wheel` — `vtracer==0.6.15` từ PyPI (bánh xe prebuilt cp312, không cần Rust
  toolchain lúc build). Dòng 0.6.x **không có** `max_colors`, `palette`,
  `adaptive` threshold hay `simplify`. Muốn giới hạn số màu thì **ta phải tự
  lượng tử hoá trước** — nên adapter này làm đúng thế và ghi rõ vào tham số.
* `cli` — `vtracer-cli 1.0.0-alpha.2` biên dịch từ crates.io. Có đủ
  `--max-colors`, `--palette`, `--adaptive`, `--simplify`, `cutout` seam-free
  thật, nhưng là bản **alpha**.

Cả hai đường đều đi qua `normalize_svg()` trước khi đo: VTracer 0.6.x gắn
`transform="translate(...)"` lên từng path, và mọi so sánh hình học phải làm trên
toạ độ đã phẳng.

Đo tài nguyên:

* **thời gian** — đo trong tiến trình (wheel) hoặc thời gian tiến trình con (cli).
  Với `cli` thời gian bao gồm cả khởi động tiến trình; báo cáo phải nói rõ.
* **peak RAM** — chỉ đo được trung thực ở mức tiến trình, vì vtracer cấp phát bên
  trong Rust nên `tracemalloc` của Python không thấy. Dùng
  `GetProcessMemoryInfo().PeakWorkingSetSize` qua ctypes, không thêm dependency.

Self-test:

    backend\\venv\\Scripts\\python.exe tools\\logo_rebuild_spike\\engines.py --self-test
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

from svg_raster import SvgSubsetError, normalize_svg, parse_svg  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = Path(os.environ.get(
    "VTRACER_CLI", REPO_ROOT / "tmp" / "vtracer_cli" / "bin" / "vtracer.exe"
))


def set_cli_path(path: Path) -> None:
    """Đặt binary CLI cho phiên benchmark hiện tại."""
    global CLI_PATH
    CLI_PATH = path.resolve()

# Mã thoát riêng để phân biệt "hết hạn" với "lỗi engine".
TIMEOUT_EXIT = -9999
# Hạn thời gian một lượt vector hóa. Căn cứ sản phẩm, không phải con số tuỳ ý: kế
# hoạch đòi "thời gian preview chấp nhận được trên CPU", nên một cấu hình cần hơn
# 30 giây cho một ảnh 1400 px đã là không dùng được cho preview tương tác — ghi
# nhận là hết hạn rồi đi tiếp còn hữu ích hơn là chờ nó xong.
DEFAULT_TIMEOUT_S = 30.0


# ── Cấu hình mức "giao diện" ─────────────────────────────────────────────────

@dataclass(frozen=True)
class TraceConfig:
    """Tham số ở mức người dùng, độc lập với engine.

    Đây là hợp đồng mà UI sẽ phơi ra. Việc mỗi engine hiện thực bằng cờ nào là
    chuyện của adapter — nếu để tham số engine lọt lên UI thì đổi engine là đổi UI.
    """

    colors: int = 8              # 1..12, số màu tối đa
    smoothing: float = 0.5       # 0..1 → simplify tolerance / corner threshold
    despeckle_px: int = 4        # bỏ vùng nhỏ hơn (px)
    cutout: bool = False         # True = mosaic không khe, False = xếp lớp
    binary: bool = False         # nhị phân (line art / đen trắng)
    adaptive: bool = False       # ngưỡng thích ứng cho ánh sáng không đều
    polygon: bool = False        # True = polygon, False = spline
    palette: tuple[str, ...] | None = None  # palette khóa tay dạng #RRGGBB

    def __post_init__(self) -> None:
        if self.palette is not None:
            normalized = tuple(color.lower() for color in self.palette)
            if not normalized or any(
                len(color) != 7 or not color.startswith("#") or
                any(ch not in "0123456789abcdef" for ch in color[1:])
                for color in normalized
            ):
                raise ValueError("Palette phải gồm mã màu #RRGGBB")
            if self.binary:
                raise ValueError("Không dùng palette màu với chế độ nhị phân")
            object.__setattr__(self, "palette", normalized)

    def label(self) -> str:
        bits = [f"c{self.colors}", f"s{self.smoothing:g}", f"d{self.despeckle_px}"]
        if self.cutout:
            bits.append("cutout")
        if self.binary:
            bits.append("bw")
        if self.adaptive:
            bits.append("adapt")
        if self.polygon:
            bits.append("poly")
        if self.palette:
            digest = hashlib.sha256(",".join(self.palette).encode("ascii")).hexdigest()[:8]
            bits.append(f"pal{len(self.palette)}-{digest}")
        return "-".join(bits)


@dataclass
class TraceResult:
    engine: str
    config: TraceConfig
    ok: bool
    svg: str = ""                # đã chuẩn hoá, sẵn sàng đo
    raw_bytes: int = 0
    elapsed_s: float = 0.0
    peak_rss_mb: float | None = None
    error: str | None = None
    notes: list[str] = field(default_factory=list)


# ── Đo peak RAM tiến trình (Windows) ─────────────────────────────────────────

_ULONG_PTR = ctypes.c_size_t


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", _ULONG_PTR),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9


def run_and_measure(cmd: list[str],
                    timeout_s: float | None = None) -> tuple[int, str, float, float | None]:
    """Chạy tiến trình con, trả (exit, output, giây, peak commit MB).

    Đo bằng **Job Object** (`PeakProcessMemoryUsed`), không dùng
    `GetProcessMemoryInfo` sau khi tiến trình thoát: cách đó trả counter vô nghĩa
    (đo được 4,2 MB cho một interpreter Python và 5,8 MB cho một binary Rust xử lý
    ảnh — cả hai đều không thể). Job Object giữ số đỉnh sau khi tiến trình kết
    thúc nên đọc được chính xác.

    Con số là *peak commit* của tiến trình, gồm cả bộ nhớ riêng chưa nằm trong
    working set. Đây là con số đúng để lập ngân sách RAM.
    """
    kernel32 = ctypes.windll.kernel32
    job = kernel32.CreateJobObjectW(None, None)

    started = time.perf_counter()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if job:
        # Gán ngay khi vừa tạo: đỉnh bộ nhớ xảy ra trong lúc xử lý, muộn hơn nhiều.
        kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(job), wintypes.HANDLE(int(proc._handle))  # type: ignore[attr-defined]
        )
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        out, _ = proc.communicate()
    elapsed = time.perf_counter() - started

    peak_mb: float | None = None
    if job:
        try:
            info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            returned = wintypes.DWORD(0)
            ok = kernel32.QueryInformationJobObject(
                wintypes.HANDLE(job), _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(returned),
            )
            if ok and info.PeakProcessMemoryUsed > 0:
                peak_mb = info.PeakProcessMemoryUsed / (1024 * 1024)
        finally:
            kernel32.CloseHandle(wintypes.HANDLE(job))

    code = TIMEOUT_EXIT if timed_out else proc.returncode
    return code, out.decode("utf-8", errors="replace"), elapsed, peak_mb


# ── Lượng tử hoá màu (phần dòng 0.6.x KHÔNG có) ──────────────────────────────

def quantize_to_n_colors(img: Image.Image, n: int) -> tuple[Image.Image, int]:
    """Giảm về tối đa `n` màu. Trả (ảnh RGB, số màu thực tế).

    Dòng vtracer 0.6.x không có `max_colors`/`palette`, nên muốn kiểm soát số màu
    thì phải làm ở đây. Dùng lượng tử hoá median-cut của Pillow không dither —
    dither tạo hạt giả và biến thành hàng nghìn path rác khi trace.
    """
    if n < 1:
        raise ValueError("Số màu phải >= 1")
    rgba = img.convert("RGBA")
    rgb = rgba.convert("RGB")
    pal = rgb.quantize(colors=n, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = pal.convert("RGB")
    # Giữ alpha gốc; lượng tử hoá chỉ áp dụng lên các kênh màu.
    if rgba.getchannel("A").getextrema() != (255, 255):
        out = out.convert("RGBA")
        out.putalpha(rgba.getchannel("A"))
    actual = len(out.convert("RGB").getcolors(maxcolors=4096) or [])
    return out, actual


def quantize_to_palette(img: Image.Image, palette: tuple[str, ...]) -> tuple[Image.Image, int]:
    """Ánh xạ ảnh vào palette cố định, không dither và vẫn giữ alpha gốc."""
    if not 1 <= len(palette) <= 256:
        raise ValueError("Palette phải có 1..256 màu")
    rgba = img.convert("RGBA")
    rgb = rgba.convert("RGB")
    values = [int(color[i:i + 2], 16) for color in palette for i in (1, 3, 5)]
    palette_image = Image.new("P", (1, 1))
    palette_image.putpalette(values + values[:3] * (256 - len(palette)))
    quantized = rgb.quantize(palette=palette_image, dither=Image.Dither.NONE)
    out = quantized.convert("RGB")
    if rgba.getchannel("A").getextrema() != (255, 255):
        out = out.convert("RGBA")
        out.putalpha(rgba.getchannel("A"))
    actual = len(out.convert("RGB").getcolors(maxcolors=4096) or [])
    return out, actual


# ── Engine: wheel PyPI 0.6.15 ────────────────────────────────────────────────

def trace_wheel(image_path: Path, cfg: TraceConfig,
                timeout_s: float | None = DEFAULT_TIMEOUT_S) -> TraceResult:
    """Chạy đường wheel ở TIẾN TRÌNH CON để đặt được hạn thời gian.

    Vì sao không gọi thẳng trong tiến trình: `convert_raw_image_to_svg` là một lời
    gọi native **chặn**, không có cancel token và không thể ngắt từ Python. Đo thực
    tế: một cấu hình 12 màu trên ảnh chữ trên vải chạy quá 10 phút không dừng, và
    cách duy nhất để bỏ nó là hạ tiến trình. Đây chính là điểm §LR.07 của báo cáo
    khảo sát, và là điểm khác biệt then chốt so với crate 1.0 (có `CancelToken`).

    Thời gian engine do chính tiến trình con đo, nên không tính chi phí khởi động
    interpreter — số vẫn so được với đường CLI.
    """
    if timeout_s is None:
        return _trace_wheel_inproc(image_path, cfg)

    res = TraceResult(engine="wheel", config=cfg, ok=False)
    with tempfile.TemporaryDirectory(prefix="wheel_spike_") as tmp:
        out_svg = Path(tmp) / "out.svg"
        payload = json.dumps({
            "image": str(image_path), "out": str(out_svg),
            "cfg": {k: getattr(cfg, k) for k in
                    ("colors", "smoothing", "despeckle_px", "cutout",
                     "binary", "adaptive", "polygon", "palette")},
        })
        code, output, wall, peak = run_and_measure(
            [sys.executable, str(Path(__file__).resolve()), "--child-wheel", payload],
            timeout_s=timeout_s,
        )
        res.peak_rss_mb = peak
        if code == TIMEOUT_EXIT:
            res.error = (f"hết hạn {timeout_s:.0f}s — lời gọi native không hủy được, "
                         "phải hạ tiến trình")
            res.elapsed_s = wall
            res.notes = ["timeout"]
            return res
        line = ""
        for candidate in output.splitlines():
            if candidate.startswith("{"):
                line = candidate
        if code != 0 or not line:
            res.error = f"exit {code}: {output.strip()[:200]}"
            res.elapsed_s = wall
            return res
        try:
            info = json.loads(line)
        except json.JSONDecodeError:
            res.error = f"đầu ra tiến trình con không đọc được: {line[:160]}"
            return res
        res.elapsed_s = float(info.get("elapsed_s", wall))
        res.notes = list(info.get("notes", []))
        if not info.get("ok"):
            res.error = info.get("error") or "lỗi không rõ trong tiến trình con"
            return res
        raw = out_svg.read_text(encoding="utf-8", errors="replace")

    res.raw_bytes = len(raw.encode("utf-8"))
    try:
        res.svg = normalize_svg(raw)
        res.ok = True
    except SvgSubsetError as exc:
        res.error = f"SVG ngoài tập con an toàn: {exc}"
    except Exception as exc:  # noqa: BLE001
        res.error = f"{type(exc).__name__}: {exc}"
    return res


class CapabilityMissing(RuntimeError):
    """Engine không có năng lực được yêu cầu — khác hẳn lỗi khi chạy."""


def _wheel_raw(image_path: Path, cfg: TraceConfig) -> tuple[str, float, list[str]]:
    """Lõi đường wheel: trả (SVG thô, giây engine, ghi chú). Dùng chung cho cả
    lời gọi trong tiến trình và tiến trình con."""
    import vtracer

    notes: list[str] = []
    if cfg.adaptive:
        raise CapabilityMissing(
            "dòng 0.6.x không có ngưỡng thích ứng — năng lực thiếu, không phải lỗi chạy"
        )
    img = Image.open(image_path)
    if cfg.cutout:
        notes.append("hierarchical=cutout của 0.6.x là bản re-cluster cũ, "
                     "KHÔNG phải mosaic không khe của 1.0")
    # Giới hạn/khóa màu ở phía ta, vì wheel 0.6.x không có API palette.
    if cfg.palette:
        img, actual = quantize_to_palette(img, cfg.palette)
        notes.append(f"tự ánh xạ vào palette khóa {len(cfg.palette)} màu (thực tế {actual})")
    elif not cfg.binary:
        img, actual = quantize_to_n_colors(img, cfg.colors)
        notes.append(f"tự lượng tử về {cfg.colors} màu (thực tế {actual})")

    buf = io.BytesIO()
    (img if img.mode == "RGBA" else img.convert("RGB")).save(buf, format="PNG")
    payload = buf.getvalue()

    # smoothing 0..1 → corner_threshold: mượt cao = ngưỡng góc cao = ít góc nhọn.
    corner = int(round(30 + cfg.smoothing * 80))       # 30..110
    length = 3.5 + cfg.smoothing * 6.0                 # 3.5..9.5
    started = time.perf_counter()
    raw = vtracer.convert_raw_image_to_svg(
        payload,
        img_format="png",
        colormode="binary" if cfg.binary else "color",
        hierarchical="cutout" if cfg.cutout else "stacked",
        mode="polygon" if cfg.polygon else "spline",
        filter_speckle=max(0, min(128, cfg.despeckle_px)),
        # Lượng tử đã làm ở trên ⇒ để engine giữ nguyên màu, đừng gộp thêm.
        color_precision=8,
        layer_difference=0 if not cfg.binary else 16,
        corner_threshold=corner,
        length_threshold=length,
        max_iterations=10,
        splice_threshold=45,
        path_precision=4,
    )
    return raw, time.perf_counter() - started, notes


def _trace_wheel_inproc(image_path: Path, cfg: TraceConfig) -> TraceResult:
    res = TraceResult(engine="wheel", config=cfg, ok=False)
    try:
        raw, elapsed, notes = _wheel_raw(image_path, cfg)
        res.elapsed_s = elapsed
        res.raw_bytes = len(raw.encode("utf-8"))
        res.svg = normalize_svg(raw)
        res.notes = notes
        res.ok = True
    except CapabilityMissing as exc:
        res.error = str(exc)
    except SvgSubsetError as exc:
        res.error = f"SVG ngoài tập con an toàn: {exc}"
    except Exception as exc:  # noqa: BLE001 - spike: ghi lại mọi lỗi engine
        res.error = f"{type(exc).__name__}: {exc}"
    return res


def _child_wheel(payload: str) -> int:
    """Chế độ tiến trình con: vector hóa rồi báo kết quả bằng một dòng JSON."""
    spec = json.loads(payload)
    cfg = TraceConfig(**spec["cfg"])
    info: dict = {"ok": False, "elapsed_s": 0.0, "notes": [], "error": None}
    try:
        raw, elapsed, notes = _wheel_raw(Path(spec["image"]), cfg)
        Path(spec["out"]).write_text(raw, encoding="utf-8")
        info.update(ok=True, elapsed_s=elapsed, notes=notes)
    except CapabilityMissing as exc:
        info["error"] = str(exc)
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"{type(exc).__name__}: {exc}"
    print(json.dumps(info, ensure_ascii=False), flush=True)
    return 0


# ── Engine: CLI 1.0.0-alpha.2 ────────────────────────────────────────────────

def trace_cli(image_path: Path, cfg: TraceConfig) -> TraceResult:
    res = TraceResult(engine="cli", config=cfg, ok=False)
    if not CLI_PATH.is_file():
        res.error = f"chưa có {CLI_PATH} — cargo install vtracer-cli trước"
        return res

    with tempfile.TemporaryDirectory(prefix="vtracer_spike_") as tmp:
        out_svg = Path(tmp) / "out.svg"
        cmd = [str(CLI_PATH), str(image_path), str(out_svg)]
        if cfg.binary:
            cmd += ["--clustering", "bw"]
            if cfg.adaptive:
                cmd += ["--adaptive"]
        else:
            cmd += ["--clustering", "color-cluster"]
            if cfg.palette:
                cmd += ["--palette", ",".join(cfg.palette)]
            else:
                cmd += ["--max-colors", str(cfg.colors)]
        cmd += ["--hierarchical", "cutout" if cfg.cutout else "stacked"]
        cmd += ["--mode", "polygon" if cfg.polygon else "spline"]
        cmd += ["--filter-speckle", str(max(0, min(128, cfg.despeckle_px)))]
        # smoothing 0..1 → simplify tolerance px (README khuyên thử 1–2.5).
        cmd += ["--simplify", f"{0.5 + cfg.smoothing * 2.0:.2f}"]
        cmd += ["--path-precision", "4"]

        code, output, elapsed, peak = run_and_measure(cmd, timeout_s=DEFAULT_TIMEOUT_S)
        res.elapsed_s = elapsed
        res.peak_rss_mb = peak
        if code == TIMEOUT_EXIT:
            res.error = f"hết hạn {DEFAULT_TIMEOUT_S:.0f}s"
            res.notes = ["timeout"]
            return res
        if code != 0 or not out_svg.is_file():
            res.error = f"exit {code}: {output.strip()[:200]}"
            return res
        raw = out_svg.read_text(encoding="utf-8", errors="replace")

    res.raw_bytes = len(raw.encode("utf-8"))
    try:
        res.svg = normalize_svg(raw)
        res.ok = True
    except SvgSubsetError as exc:
        res.error = f"SVG ngoài tập con an toàn: {exc}"
    except Exception as exc:  # noqa: BLE001
        res.error = f"{type(exc).__name__}: {exc}"
    return res


ENGINES = {"wheel": trace_wheel, "cli": trace_cli}


def trace(engine: str, image_path: Path, cfg: TraceConfig) -> TraceResult:
    if engine not in ENGINES:
        raise KeyError(f"Engine không biết: {engine} (có: {sorted(ENGINES)})")
    return ENGINES[engine](image_path, cfg)


def measure_wheel_peak_rss(image_path: Path, cfg: TraceConfig) -> tuple[float | None, float | None]:
    """Peak RSS của đường wheel, đo ở tiến trình con.

    Trả (peak khi trace, peak nền của interpreter+import). Chênh hai số mới là
    lượng RAM engine thực dùng — báo con số tuyệt đối sẽ gộp cả ~40 MB Python.
    """
    script = (
        "import sys, io; sys.path.insert(0, r'{d}');\n"
        "from pathlib import Path\n"
        "import engines\n"
        "cfg = engines.TraceConfig(colors={c}, smoothing={s}, despeckle_px={p}, "
        "cutout={co}, binary={b}, polygon={pg})\n"
        "{body}\n"
    )
    here = Path(__file__).parent
    common = dict(d=str(here), c=cfg.colors, s=cfg.smoothing, p=cfg.despeckle_px,
                  co=cfg.cutout, b=cfg.binary, pg=cfg.polygon)
    # Gọi bản TRONG TIẾN TRÌNH: nếu gọi `trace_wheel` thì nó lại sinh tiến trình
    # cháu và ta sẽ đo RAM của một tiến trình không làm gì.
    work = script.format(body=f"engines._trace_wheel_inproc(Path(r'{image_path}'), cfg)",
                         **common)
    idle = script.format(body="pass", **common)

    peaks: list[float | None] = []
    for code_str in (work, idle):
        _, _, _, peak = run_and_measure([sys.executable, "-c", code_str])
        peaks.append(peak)
    return peaks[0], peaks[1]


# ── Self-test ────────────────────────────────────────────────────────────────

def _self_test() -> int:
    from PIL import ImageDraw

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    with tempfile.TemporaryDirectory(prefix="engines_selftest_") as tmp:
        # Ảnh mẫu: 4 ô màu rõ ràng + một chấm 2px (kiểm despeckle).
        img = Image.new("RGB", (200, 200), (255, 255, 255))
        d = ImageDraw.Draw(img)
        d.rectangle([10, 10, 95, 95], fill=(200, 20, 20))
        d.rectangle([105, 10, 190, 95], fill=(20, 90, 200))
        d.rectangle([10, 105, 95, 190], fill=(240, 190, 20))
        d.ellipse([120, 130, 170, 180], fill=(20, 140, 60))
        d.rectangle([98, 98, 100, 100], fill=(0, 0, 0))
        src = Path(tmp) / "sample.png"
        img.save(src)

        cfg = TraceConfig(colors=5, smoothing=0.5, despeckle_px=4)

        # 1) Lượng tử hoá phải tôn trọng số màu yêu cầu.
        q, actual = quantize_to_n_colors(img, 5)
        check("lượng tử về đúng <= 5 màu", actual <= 5, f"{actual} màu")

        fixed = ("#c81414", "#145ac8")
        q_fixed, actual_fixed = quantize_to_palette(img, fixed)
        fixed_pixels = {f"#{r:02x}{g:02x}{b:02x}" for _, (r, g, b) in
                        (q_fixed.convert("RGB").getcolors(maxcolors=16) or [])}
        check("lượng tử palette chỉ sinh màu đã khóa",
              actual_fixed <= len(fixed) and fixed_pixels <= set(fixed),
              str(sorted(fixed_pixels)))
        wheel_fixed = trace("wheel", src, TraceConfig(colors=2, palette=fixed))
        check("wheel: palette khóa chạy được", wheel_fixed.ok, wheel_fixed.error or "")
        check("wheel: ghi rõ adapter tự ánh xạ palette",
              any("palette khóa" in note for note in wheel_fixed.notes),
              str(wheel_fixed.notes))
        cli_fixed = trace("cli", src, TraceConfig(colors=2, palette=fixed))
        check("cli: --palette chạy được", cli_fixed.ok, cli_fixed.error or "")

        # 2) Đường wheel chạy được và SVG qua được parser nghiêm ngặt.
        rw = trace("wheel", src, cfg)
        check("wheel: trace thành công", rw.ok, rw.error or "")
        if rw.ok:
            doc = parse_svg(rw.svg)
            check("wheel: SVG chuẩn hoá parse được", doc.path_count > 0,
                  f"{doc.path_count} path, {doc.node_count} node")
            check("wheel: có ghi chú tự lượng tử",
                  any("tự lượng tử" in n for n in rw.notes), str(rw.notes))

        # 3) Đường CLI chạy được, và --max-colors là năng lực của riêng 1.0.
        rc = trace("cli", src, cfg)
        check("cli: trace thành công", rc.ok, rc.error or "")
        if rc.ok:
            doc = parse_svg(rc.svg)
            check("cli: SVG chuẩn hoá parse được", doc.path_count > 0,
                  f"{doc.path_count} path, {doc.node_count} node")
            check("cli: đo được peak RAM", rc.peak_rss_mb is not None,
                  f"{rc.peak_rss_mb:.1f} MB" if rc.peak_rss_mb else "None")

        # 4) Năng lực thiếu phải báo rõ là THIẾU, không phải im lặng chạy khác đi.
        r_adapt = trace("wheel", src, TraceConfig(binary=True, adaptive=True))
        check("wheel: báo thiếu ngưỡng thích ứng",
              (not r_adapt.ok) and "không có ngưỡng thích ứng" in (r_adapt.error or ""),
              r_adapt.error or "")
        r_adapt_cli = trace("cli", src, TraceConfig(binary=True, adaptive=True))
        check("cli: ngưỡng thích ứng chạy được", r_adapt_cli.ok, r_adapt_cli.error or "")

        # 5) Despeckle mạnh phải giảm số path so với despeckle 0.
        low = trace("cli", src, TraceConfig(colors=5, despeckle_px=0))
        high = trace("cli", src, TraceConfig(colors=5, despeckle_px=64))
        if low.ok and high.ok:
            n_low = parse_svg(low.svg).path_count
            n_high = parse_svg(high.svg).path_count
            check("cli: despeckle giảm số path", n_high <= n_low,
                  f"{n_low} → {n_high}")

        # 6) Kết quả phải tái lập: cùng ảnh + cùng cấu hình ⇒ cùng SVG.
        again = trace("wheel", src, cfg)
        if rw.ok and again.ok:
            check("wheel: đơn định (cùng input ⇒ cùng SVG)", rw.svg == again.svg,
                  "khác nhau" if rw.svg != again.svg else "")
        again_cli = trace("cli", src, cfg)
        if rc.ok and again_cli.ok:
            check("cli: đơn định (cùng input ⇒ cùng SVG)", rc.svg == again_cli.svg,
                  "khác nhau" if rc.svg != again_cli.svg else "")

        # 6b) Chốt chống số RAM rác: peak phải TĂNG THEO số pixel.
        #     Một ngưỡng sàn tuyệt đối không đủ — bản đo cũ (GetProcessMemoryInfo
        #     sau khi tiến trình thoát) trả một hằng số vô nghĩa cho mọi đầu vào và
        #     test vẫn xanh. Tính đơn điệu mới chứng minh cơ chế đo thật sự chạy.
        big = Image.new("RGB", (1600, 1600), (255, 255, 255))
        db = ImageDraw.Draw(big)
        for i in range(10):
            db.ellipse([32 * i, 32 * i, 1600 - 32 * i, 1600 - 32 * i],
                       outline=(25 * i % 255, 90, 200 - 12 * i), width=12)
        big_src = Path(tmp) / "big.png"
        big.save(big_src)
        r_big = trace("cli", big_src, TraceConfig(colors=8, despeckle_px=2))
        if rc.peak_rss_mb is not None and r_big.peak_rss_mb is not None:
            check("cli: peak RAM tăng theo số pixel (64× pixel ⇒ ≥4× RAM)",
                  r_big.peak_rss_mb > rc.peak_rss_mb * 4,
                  f"200px {rc.peak_rss_mb:.1f} MB → 1600px {r_big.peak_rss_mb:.1f} MB")

        # 7) Peak RAM đường wheel: phải tách được phần engine khỏi phần Python,
        #    và cả hai số phải nằm trong khoảng hợp lý cho một interpreter thật.
        work, idle = measure_wheel_peak_rss(src, cfg)
        have = work is not None and idle is not None
        check("wheel: nền interpreter là số thật (>8 MB)",
              have and idle > 8.0, f"{idle:.1f} MB" if have else "None")
        check("wheel: trace tốn RAM hơn nền",
              have and work > idle,
              f"trace {work:.1f} MB > nền {idle:.1f} MB" if have else f"{work}/{idle}")

    print()
    if failures:
        print(f"SELF-TEST THẤT BẠI: {len(failures)} mục — {', '.join(failures)}")
        return 1
    print("SELF-TEST ĐẠT — hai adapter dùng được cho benchmark.")
    return 0


def main(argv: list[str]) -> int:
    if "--child-wheel" in argv:
        return _child_wheel(argv[argv.index("--child-wheel") + 1])
    if "--self-test" in argv:
        return _self_test()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

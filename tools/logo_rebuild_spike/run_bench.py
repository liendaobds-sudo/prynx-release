"""Benchmark VTracer trên corpus spike — sinh số liệu cho cổng G1.

Chiến lược hai chặng, vì ma trận đầy đủ (32 ca × 36 cấu hình × 2 engine) mất hàng
giờ mà phần lớn là cấu hình hiển nhiên kém:

* **Chặng 1 — quét cấu hình.** Chạy ma trận đầy đủ trên một ca đại diện của mỗi
  thiết kế để tìm preset tốt nhất cho từng loại logo.
* **Chặng 2 — chạy toàn corpus.** Áp preset đã chọn lên cả 32 ca, hai engine, để
  ra tỷ lệ đạt theo nhóm.
* **Chặng 3 — đo RAM.** Đo riêng peak RAM theo kích thước ảnh, vì đo tài nguyên
  cần tiến trình sạch còn ma trận cần chạy nhanh trong tiến trình.

Ảnh được **dựng lại phối cảnh bằng bốn góc đã lưu** trước khi trace. Chủ ý: ở G1
ta đo chất lượng *vector hóa*, không đo chất lượng tự tìm bốn góc. Trộn hai thứ
lại thì một engine tốt sẽ bị trừ điểm vì lỗi của bước khác.

Tiêu chí đạt của từng ca — tự hiệu chuẩn, không phải con số cảm tính:

* hồ sơ `clean` (trần thật 1.000): boundary F ≥ 0,95;
* hồ sơ suy giảm: boundary F ≥ **mốc ngưỡng thô của chính ca đó**, tức engine phải
  ít nhất bằng phép phân ngưỡng đơn giản trên cùng ảnh đã dựng lại. Vượt mốc là
  engine có lọc tốt; dưới mốc là engine còn kém hơn không làm gì;
* thêm điều kiện màu khi có ground truth: ΔE50 ≤ 3,0;
* ca `reject` không tính vào tỷ lệ đạt — tính vào cột "phát hiện đúng", đo bằng
  dấu hiệu số path / tỷ lệ vùng vụn.

Chạy:

    backend\\venv\\Scripts\\python.exe tools\\logo_rebuild_spike\\run_bench.py
    ... run_bench.py --quick          # ma trận nhỏ, để thử đường ống
    ... run_bench.py --stage 2        # chỉ chạy lại chặng 2
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as importlib_metadata
import json
import math
import re
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

from corpus_spec import CorpusCase, from_json  # noqa: E402
from engines import (CLI_PATH as DEFAULT_CLI, TraceConfig, measure_wheel_peak_rss,  # noqa: E402
                     set_cli_path, trace)
from make_synthetic_corpus import background_color, ink_mask, rectify  # noqa: E402
from metrics import boundary_f_score, delta_e_stats, svg_complexity  # noqa: E402
from svg_raster import render_svg_to_png  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS = REPO_ROOT / "private_test_corpus" / "logo_rebuild" / "synthetic"
OUT_DIR = CORPUS / "bench"
RENDER_PX = 700          # cỡ raster để so; nhỏ hơn GT 1400 để chạy nhanh, đủ để đo biên
CLEAN_PASS_BF = 0.95
DELTA_E_PASS = 3.0
# Kết quả được phép phức tạp hơn ground truth bao nhiêu lần thì vẫn còn chỉnh tay
# được. 20× là rộng rãi: ground truth là mức tối thiểu lý tưởng, còn ảnh chụp thật
# luôn cần thêm node cho biên không hoàn hảo.
NODE_BUDGET_FACTOR = 20
# Sàn ngân sách. Ground truth synthetic là mức tối thiểu lý tưởng (logo 4 ô vuông
# + vành khuyên chỉ 28 node), nên nhân hệ số với nó cho ra ngân sách phi thực tế
# với ảnh chụp. 1500 node là mức một logo chi tiết vẫn còn chỉnh tay được trong
# Illustrator/CorelDRAW. NGƯỠNG ĐỀ XUẤT — cần chốt ở cổng duyệt.
NODE_BUDGET_FLOOR = 1500
# Trên mức này thì không render để đo nữa — vừa vô ích (đã trượt tiêu chí chỉnh
# tay được) vừa cực đắt. Đặt cao hơn ngân sách nhiều lần để vẫn thấy được "engine
# vượt bao xa" ở dải còn ý nghĩa.
HARD_NODE_CAP = 40_000

ENGINE_ORDER = ("cli", "wheel")
CACHE_SCHEMA = 2
METRIC_SCHEMA = "ink-deltae-v2+alpha-iou-v1"
RUN_ID = ""
RUN_PROVENANCE: dict = {}
ACTIVE_CLI_PATH = DEFAULT_CLI


def _digest_paths(paths: list[Path], root: Path) -> str:
    """Băm nội dung và tên tương đối của một tập file theo thứ tự ổn định."""
    digest = hashlib.sha256()
    for path in sorted({p.resolve() for p in paths}, key=lambda p: str(p).lower()):
        try:
            label = path.relative_to(root.resolve()).as_posix()
        except ValueError:
            label = path.name
        digest.update(label.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def build_provenance(cases: list[CorpusCase]) -> dict:
    """Dấu vân tay đủ để không tái dùng kết quả sau khi dữ liệu hoặc metric đổi."""
    corpus_files = [CORPUS / "corpus.json"]
    for case in cases:
        corpus_files.append(CORPUS / case.image)
        if case.ground_truth_png:
            corpus_files.append(CORPUS / case.ground_truth_png)
        if case.ground_truth_svg:
            corpus_files.append(CORPUS / case.ground_truth_svg)
    source_files = [Path(__file__)] + [
        Path(__file__).with_name(name) for name in (
            "engines.py", "metrics.py", "svg_raster.py", "make_synthetic_corpus.py",
        )
    ]
    try:
        wheel_version = importlib_metadata.version("vtracer")
    except importlib_metadata.PackageNotFoundError:
        wheel_version = "missing"
    payload = {
        "cache_schema": CACHE_SCHEMA,
        "metric_schema": METRIC_SCHEMA,
        "reject_rules": REJECT_RULES_VERSION,
        "render_px": RENDER_PX,
        "clean_pass_bf": CLEAN_PASS_BF,
        "delta_e_pass": DELTA_E_PASS,
        "corpus_sha256": _digest_paths(corpus_files, CORPUS),
        "source_sha256": _digest_paths(source_files, REPO_ROOT),
        "wheel_version": wheel_version,
        "cli_sha256": (_digest_paths([ACTIVE_CLI_PATH], ACTIVE_CLI_PATH.parent)
                       if ACTIVE_CLI_PATH.is_file() else None),
    }
    cache_id = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {"cache_id": cache_id, **payload}


# ── Ma trận cấu hình ─────────────────────────────────────────────────────────

def config_matrix(quick: bool) -> list[TraceConfig]:
    colors = [2, 4, 8, 12]
    # despeckle tới 48 px và smoothing tới 1.0 (simplify 2,5 px) là cần thiết:
    # ảnh dựng lại ở 1400 px, và mức 4 px không đủ để dọn hạt vải — đo ở vòng
    # trước cho 7.644 node trên một thiết kế chỉ 28 node.
    smooth = [0.5] if quick else [0.2, 0.5, 0.8, 1.0]
    # despeckle=0 ĐÃ BỊ LOẠI khỏi vòng quét sau khi đo trên 3 ca đầu (bw, flat12,
    # flat2 × 2 engine = 414 lượt, còn trong stage1.jsonl): nó cho ~29.000 node
    # trên thiết kế chỉ 23 node, tức trace thẳng hạt vải, và đồng thời là nhóm cấu
    # hình đắt nhất (~35 s/lượt do phải rasterize kết quả khổng lồ để đo). Bằng
    # chứng đã đủ, giữ lại chỉ tốn hàng giờ mà không thêm thông tin.
    speckle = [4] if quick else [4, 16, 48]
    out = [
        TraceConfig(colors=c, smoothing=s, despeckle_px=d)
        for c in colors for s in smooth for d in speckle
    ]
    # Biến thể riêng cho line art / đen trắng: nhị phân + ngưỡng thích ứng.
    out += [
        TraceConfig(binary=True, smoothing=0.5, despeckle_px=4),
        TraceConfig(binary=True, smoothing=0.5, despeckle_px=4, adaptive=True),
    ]
    if not quick:
        # cutout: mosaic không khe — chỉ 1.0 làm thật, đo để so với stacked.
        out += [TraceConfig(colors=c, smoothing=0.5, despeckle_px=4, cutout=True)
                for c in (4, 8)]
        out += [TraceConfig(colors=8, smoothing=0.5, despeckle_px=4, polygon=True)]
    return out


def expected_colors_by_design(cases: list[CorpusCase]) -> dict[str, int | None]:
    """Số màu kỳ vọng theo từng thiết kế, lấy từ metadata corpus."""
    out: dict[str, int | None] = {}
    for case in cases:
        out.setdefault(case.case_id.split("__")[0], case.expected_colors)
    return out


def profile_of(case: CorpusCase) -> str:
    return case.notes.replace("hồ sơ suy giảm: ", "") if case.notes else "-"


# ── Chuẩn bị đầu vào và mốc tham chiếu ───────────────────────────────────────

def prepare(case: CorpusCase) -> tuple[Image.Image, Image.Image, np.ndarray, float, int, Image.Image] | None:
    """Trả (ảnh đã dựng lại, GT phẳng, màu nền tham chiếu, mốc bF ngưỡng thô, node GT).

    `node GT` là số node của chính SVG ground truth — dùng làm **ngân sách node**
    tự hiệu chuẩn. Không thể lấy một con số cố định cho mọi thiết kế: logo 4 ô
    vuông cần vài chục node, còn logo nhiều vành khuyên cần vài trăm.
    """
    if not case.has_ground_truth or case.quad_normalized is None:
        return None
    gt_nodes = svg_complexity(
        (CORPUS / case.ground_truth_svg).read_bytes()  # type: ignore[arg-type]
    ).node_count
    gt = Image.open(CORPUS / case.ground_truth_png)  # type: ignore[arg-type]
    bg_layer = Image.new("RGBA", gt.size, (255, 255, 255, 255))
    gt_flat = Image.alpha_composite(bg_layer, gt.convert("RGBA")).convert("RGB")

    src = Image.open(CORPUS / case.image)
    rect = rectify(src, case.quad_normalized, gt.width)

    gt_small = gt_flat.resize((RENDER_PX, RENDER_PX), Image.Resampling.LANCZOS)
    gt_alpha_small = gt.convert("RGBA").resize((RENDER_PX, RENDER_PX), Image.Resampling.LANCZOS)
    rect_small = rect.resize((RENDER_PX, RENDER_PX), Image.Resampling.LANCZOS)

    bg_ref = background_color(gt_small)
    tol = max(1, int(round(math.hypot(RENDER_PX, RENDER_PX) * 0.0075)))
    ref_bf, _, _ = boundary_f_score(
        ink_mask(gt_small, bg_ref), ink_mask(rect_small, bg_ref), tol
    )
    return rect, gt_small, bg_ref, ref_bf, gt_nodes, gt_alpha_small


def evaluate(svg: str, gt_small: Image.Image, bg_ref: np.ndarray, gt_alpha_small: Image.Image) -> dict:
    """Đo một SVG kết quả so với ground truth.

    Chặn cứng theo số node TRƯỚC khi render: một kết quả vài trăm nghìn node mất
    hàng chục giây để rasterize qua reportlab + PDFium, mà nó đã trượt tiêu chí
    "còn chỉnh tay được" từ trước nên điểm biên của nó không dùng để làm gì. Bỏ
    bước render ở đây rút thời gian benchmark từ hàng giờ xuống vài phút.
    """
    cx_first = svg_complexity(svg)
    if cx_first.node_count > HARD_NODE_CAP:
        return {
            "boundary_f": 0.0, "boundary_precision": 0.0, "boundary_recall": 0.0,
            "delta_e50": 999.0, "delta_e95": 999.0,
            "path_count": cx_first.path_count, "node_count": cx_first.node_count,
            "tiny_path_ratio": round(cx_first.tiny_path_ratio, 4),
            "has_nonfinite": cx_first.has_nonfinite,
            "open_path_count": cx_first.open_path_count,
            "svg_bytes": cx_first.svg_bytes,
            "alpha_iou": None,
            "skipped_render": True,
        }

    tol = max(1, int(round(math.hypot(RENDER_PX, RENDER_PX) * 0.0075)))
    pred = render_svg_to_png(svg, RENDER_PX, transparent=False).convert("RGB")
    if pred.size != gt_small.size:
        pred = pred.resize(gt_small.size, Image.Resampling.LANCZOS)
    gt_ink = ink_mask(gt_small, bg_ref)
    bf, prec, rec = boundary_f_score(
        gt_ink, ink_mask(pred, bg_ref), tol
    )
    # Đo ΔE trên vùng mực của GT; nền trắng chiếm đa số sẽ không che lỗi màu nhỏ.
    de50, de95 = delta_e_stats(gt_small, pred, gt_ink)
    alpha_iou = None
    if np.asarray(gt_alpha_small.getchannel("A")).min() < 255:
        pred_alpha = render_svg_to_png(svg, RENDER_PX, transparent=True).getchannel("A")
        gt_alpha_mask = np.asarray(gt_alpha_small.getchannel("A")) > 16
        pred_alpha_mask = np.asarray(pred_alpha) > 16
        union = np.logical_or(gt_alpha_mask, pred_alpha_mask).sum()
        alpha_iou = (1.0 if union == 0 else
                     float(np.logical_and(gt_alpha_mask, pred_alpha_mask).sum() / union))
    cx = svg_complexity(svg)
    return {
        "boundary_f": round(bf, 4),
        "boundary_precision": round(prec, 4),
        "boundary_recall": round(rec, 4),
        "delta_e50": round(de50, 3),
        "delta_e95": round(de95, 3),
        "path_count": cx.path_count,
        "node_count": cx.node_count,
        "tiny_path_ratio": round(cx.tiny_path_ratio, 4),
        "has_nonfinite": cx.has_nonfinite,
        "open_path_count": cx.open_path_count,
        "svg_bytes": cx.svg_bytes,
        "alpha_iou": None if alpha_iou is None else round(alpha_iou, 4),
        "skipped_render": False,
    }


def node_budget(gt_nodes: int) -> int:
    """Ngân sách node: gấp `NODE_BUDGET_FACTOR` lần ground truth, sàn 300.

    Vì sao cần: boundary F một mình QUÁ DỄ DÃI. Đo thực tế cho thấy một kết quả
    20.032 node vẫn đạt bF = 1.000 — biên khớp trong sai số cho phép nhưng thực
    chất engine đang vector hóa nhiễu JPEG, và artwork đó không ai chỉnh tay được.
    Kế hoạch nêu rõ "số node/path không vượt mức khó chỉnh sửa" là điều kiện GO,
    nên ngân sách này là một phần của tiêu chí đạt, không phải thông tin thêm.
    """
    return max(NODE_BUDGET_FLOOR, gt_nodes * NODE_BUDGET_FACTOR)


def case_passes(profile: str, ref_bf: float, gt_nodes: int, m: dict) -> bool:
    if m["has_nonfinite"]:
        return False
    threshold = CLEAN_PASS_BF if profile in ("clean", "alpha") else ref_bf
    if m["boundary_f"] < threshold:
        return False
    if m["delta_e50"] > DELTA_E_PASS:
        return False
    if profile == "alpha" and (m.get("alpha_iou") is None or m["alpha_iou"] < 0.99):
        return False
    if m["node_count"] > node_budget(gt_nodes):
        return False
    # Phần lớn path là vụn ⇒ đang trace texture, không phải thiết kế.
    return m["tiny_path_ratio"] <= 0.5


# ── Chặng 1: quét cấu hình trên ca đại diện ──────────────────────────────────

def representative_cases(cases: list[CorpusCase]) -> list[CorpusCase]:
    """Một ca cho mỗi thiết kế, ưu tiên hồ sơ khó nhất có sẵn."""
    priority = ["fabric_uneven", "lowres_jpeg", "wrinkle_light", "fabric_light",
                "persp_strong", "persp_mild", "clean", "alpha"]
    by_design: dict[str, list[CorpusCase]] = {}
    for c in cases:
        if c.split == "train" and c.has_ground_truth and c.quad_normalized is not None:
            by_design.setdefault(c.case_id.split("__")[0], []).append(c)
    out: list[CorpusCase] = []
    for design in sorted(by_design):
        group = by_design[design]
        group.sort(key=lambda c: priority.index(profile_of(c))
                   if profile_of(c) in priority else 99)
        out.append(group[0])
    return out


def _jsonl_path(stage: int) -> Path:
    return OUT_DIR / f"stage{stage}.jsonl"


def load_done(stage: int) -> tuple[list[dict], set[tuple]]:
    """Đọc các lượt đã hoàn thành từ JSONL để chạy lại mà không làm lại.

    Vì sao append-only JSONL thay vì ghi một lần cuối: một lần quét mất ~30 phút,
    và đã có lần tiến trình bị dừng giữa đường (exit 1, không traceback, không
    APPCRASH — không tái hiện được). Mất 30 phút công vì một lần dừng bất thường
    là không chấp nhận được, nên trạng thái phải bền sau từng lượt.
    """
    path = _jsonl_path(stage)
    rows: list[dict] = []
    keys: set[tuple] = set()
    if not path.is_file():
        return rows, keys
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            # Dòng cuối có thể bị cắt giữa nếu tiến trình chết đúng lúc ghi.
            continue
        if row.get("_cache_id") != RUN_ID:
            continue
        rows.append(row)
        keys.add((row.get("case_id"), row.get("engine"), row.get("config")))
    return rows, keys


def append_row(stage: int, row: dict) -> None:
    cached_row = dict(row)
    cached_row["_cache_id"] = RUN_ID
    with _jsonl_path(stage).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(cached_row, ensure_ascii=False) + "\n")
        fh.flush()


def stage1(cases: list[CorpusCase], quick: bool) -> dict:
    matrix = config_matrix(quick)
    reps = representative_cases(cases)
    rows, done = load_done(1)
    total = len(matrix) * len(reps) * len(ENGINE_ORDER)
    print(f"[Chặng 1] quét {len(matrix)} cấu hình × {len(reps)} ca đại diện "
          f"× {len(ENGINE_ORDER)} engine = {total} lượt")
    if done:
        print(f"  đã có {len(done)} lượt trong stage1.jsonl — bỏ qua, chạy tiếp phần còn lại")
    started = time.perf_counter()
    for case in reps:
        prep = prepare(case)
        if prep is None:
            continue
        rect, gt_small, bg_ref, ref_bf, gt_nodes, gt_alpha_small = prep
        tmp_png = OUT_DIR / f"_rect_{case.case_id}.png"
        rect.save(tmp_png)
        print(f"  {case.case_id:26} (mốc ngưỡng thô bF={ref_bf:.3f}, "
              f"node GT={gt_nodes}, ngân sách={node_budget(gt_nodes)})")
        for engine in ENGINE_ORDER:
            best = None
            engine_started = time.perf_counter()
            for idx, cfg in enumerate(matrix, 1):
                if (case.case_id, engine, cfg.label()) in done:
                    continue
                r = trace(engine, tmp_png, cfg)
                if idx % 10 == 0 or idx == len(matrix):
                    print(f"      {engine} {idx}/{len(matrix)} cấu hình "
                          f"({time.perf_counter() - engine_started:.0f}s)", flush=True)
                row = {
                    "stage": 1, "case_id": case.case_id,
                    "design": case.case_id.split("__")[0],
                    "logo_type": case.logo_type, "profile": profile_of(case),
                    "split": case.split,
                    "engine": engine, "config": cfg.label(),
                    "config_full": asdict(cfg),
                    "ref_bf": round(ref_bf, 4), "gt_nodes": gt_nodes,
                    "node_budget": node_budget(gt_nodes),
                    "ok": r.ok, "error": r.error,
                    "elapsed_s": round(r.elapsed_s, 4),
                    "peak_rss_mb": r.peak_rss_mb,
                    "raw_bytes": r.raw_bytes,
                    "notes": r.notes,
                }
                if r.ok:
                    row.update(evaluate(r.svg, gt_small, bg_ref, gt_alpha_small))
                    row["passed"] = case_passes(profile_of(case), ref_bf, gt_nodes, row)
                rows.append(row)
                append_row(1, row)
            # Chọn tốt nhất trên TOÀN BỘ lượt đã có của cặp này (gồm cả lượt từ
            # lần chạy trước), không chỉ lượt vừa chạy trong phiên hiện tại.
            pool = [x for x in rows
                    if x.get("case_id") == case.case_id and x.get("engine") == engine
                    and x.get("ok") and "boundary_f" in x]
            if pool:
                best = max(pool, key=lambda x: (bool(x.get("passed")),
                                                x["boundary_f"], -x["node_count"]))
            if best:
                print(f"    {engine:6} tốt nhất: {best['config']:22} "
                      f"{'ĐẠT' if best['passed'] else 'ko đạt'} "
                      f"bF={best['boundary_f']:.3f} ΔE={best['delta_e50']:5.2f} "
                      f"node={best['node_count']:5} t={best['elapsed_s']:.2f}s")
        tmp_png.unlink(missing_ok=True)
    print(f"[Chặng 1] xong trong {time.perf_counter() - started:.0f}s")
    return {"rows": rows}


def best_presets(rows: list[dict],
                 expected_by_design: dict[str, int | None] | None = None
                 ) -> dict[str, dict[str, dict]]:
    """Preset tốt nhất theo (engine, logo_type).

    Chấm theo thứ tự: **tỷ lệ đạt** → boundary F → **ít node hơn**.

    Không chấm bằng boundary F đơn thuần. Bản đầu làm thế và chọn ra preset 2 màu
    cho nhóm logo 4 màu, 4 màu cho nhóm 12 màu — vì bF là chỉ số biên, nó không
    phạt việc phá màu. Một preset "thắng" bằng cách xoá màu và bằng cách trace
    nhiễu thành 20.000 node là preset sai, dù điểm đẹp.

    Và SỐ MÀU KHÔNG được đưa vào vòng tối ưu. Trong sản phẩm số màu do người dùng
    chọn (hoặc do bước gợi ý tự động ước lượng), nên để harness tự chọn số màu là
    đo sai đối tượng: nó vẫn chọn 4 màu cho nhóm 5–12 màu rồi trượt ΔE ở ca sạch.
    Ở đây chỉ xét cấu hình có `colors` khớp `expected_colors` của thiết kế, và
    preset trả về chỉ mang độ mượt/despeckle/chế độ — chặng 2 tự đặt số màu đúng.
    """
    max_expected_by_type: dict[str, int] = {}
    if expected_by_design is not None:
        for r in rows:
            want = expected_by_design.get(r.get("design") or "")
            if want is not None:
                logo_type = r.get("logo_type") or ""
                max_expected_by_type[logo_type] = max(max_expected_by_type.get(logo_type, 0), want)
    agg: dict[tuple[str, str, str], dict] = {}
    for r in rows:
        if not r.get("ok") or "boundary_f" not in r:
            continue
        cfg_full = r.get("config_full") or {}
        # despeckle=0 là nhóm ĐỐI CHỨNG, không phải ứng viên preset. Đã bị bác bỏ
        # bằng số đo: ~29.000 node trên thiết kế 23 node ở ba ca đầu, và 5.000–9.000
        # node ở chặng 2. Các dòng d0 còn trong stage1.jsonl là dữ liệu lịch sử của
        # ba ca chạy trước khi loại nó khỏi ma trận — giữ để tra cứu, nhưng để nó
        # thắng vòng chọn preset thì hoá ra đề xuất đúng thứ đã chứng minh là sai.
        if cfg_full.get("despeckle_px") == 0:
            continue
        if r.get("skipped_render"):
            continue
        if expected_by_design is not None:
            want = expected_by_design.get(r.get("design") or "")
            logo_type = r.get("logo_type") or ""
            if cfg_full.get("binary"):
                # Không cho preset nhị phân thắng nhóm có thiết kế nhiều hơn 2 màu.
                if max_expected_by_type.get(logo_type, 0) > 2:
                    continue
            elif want is not None and cfg_full.get("colors") != want:
                continue
        key = (r["engine"], r["logo_type"], r["config"])
        slot = agg.setdefault(key, {"bf": [], "nodes": [], "passed": [],
                                    "config_full": r["config_full"]})
        slot["bf"].append(r["boundary_f"])
        slot["nodes"].append(r["node_count"])
        slot["passed"].append(bool(r.get("passed")))

    out: dict[str, dict[str, dict]] = {}
    for (engine, logo_type, label), slot in agg.items():
        n = len(slot["bf"])
        entry = {
            "config": label,
            "pass_rate": round(sum(slot["passed"]) / n, 4),
            "mean_bf": round(sum(slot["bf"]) / n, 4),
            "mean_nodes": round(sum(slot["nodes"]) / n, 1),
            "config_full": slot["config_full"],
        }
        rank = (entry["pass_rate"], entry["mean_bf"], -entry["mean_nodes"])
        bucket = out.setdefault(engine, {})
        cur = bucket.get(logo_type)
        cur_rank = ((cur["pass_rate"], cur["mean_bf"], -cur["mean_nodes"])
                    if cur else (-1.0, -1.0, -1e18))
        if rank > cur_rank:
            bucket[logo_type] = entry
    return out


# ── Bộ phát hiện ca phải từ chối ───────────────────────────────────────────

REJECT_RULES_VERSION = "pilot-synthetic-v2"


def reject_decision(engine: str, metrics: dict) -> tuple[bool, list[str]]:
    """Quy tắc pilot có thể kiểm thử; không tự nhận là classifier tổng quát."""
    paths = int(metrics.get("path_count") or 0)
    nodes = int(metrics.get("node_count") or 0)
    tiny = float(metrics.get("tiny_path_ratio") or 0.0)
    avg_nodes = nodes / max(paths, 1)
    reasons: list[str] = []
    if engine == "cli":
        if nodes > 8000:
            reasons.append("node>8000")
        if tiny > 0.88 and nodes < 1000:
            reasons.append("tiny_path_ratio>0.88 và node<1000")
    elif engine == "wheel":
        if nodes > 5000 and avg_nodes > 50:
            reasons.append("node>5000 và node/path>50")
        if paths > 1000:
            reasons.append("path>1000")
        if tiny > 0.9 and nodes < 1000:
            reasons.append("tiny_path_ratio>0.9 và node<1000")
    else:
        raise KeyError(f"Engine không có quy tắc reject: {engine}")
    return bool(reasons), reasons


# ── Chặng 2: toàn corpus với preset đã chọn ──────────────────────────────────

def stage2(cases: list[CorpusCase], presets: dict[str, dict[str, dict]]) -> dict:
    rows, done = load_done(2)
    print(f"[Chặng 2] {len(cases)} ca × {len(ENGINE_ORDER)} engine")
    if done:
        print(f"  đã có {len(done)} lượt — chạy tiếp phần còn lại")
    for case in cases:
        prep = prepare(case)
        for engine in ENGINE_ORDER:
            preset = presets.get(engine, {}).get(case.logo_type)
            if preset is None:
                # Không có preset cho nhóm này (ca reject không vào chặng 1).
                cfg = TraceConfig(colors=case.expected_colors or 8,
                                  smoothing=0.5, despeckle_px=4)
            else:
                full = dict(preset["config_full"])
                # Số màu lấy theo ĐÚNG ca, không lấy theo preset: preset chỉ mang
                # độ mượt/despeckle/chế độ. Chế độ nhị phân bỏ qua số màu.
                if not full.get("binary") and case.expected_colors:
                    full["colors"] = case.expected_colors
                cfg = TraceConfig(**full)
            if (case.case_id, engine, cfg.label()) in done:
                continue

            if prep is None:
                # Ca hard-fail: không có ground truth ⇒ chỉ thu dấu hiệu phát hiện.
                src = CORPUS / case.image
                r = trace(engine, src, cfg)
                row = {
                    "stage": 2, "case_id": case.case_id, "logo_type": case.logo_type,
                    "profile": profile_of(case), "split": case.split,
                    "engine": engine,
                    "config": cfg.label(), "expectation": case.expectation,
                    "ok": r.ok, "error": r.error,
                    "elapsed_s": round(r.elapsed_s, 4),
                    "peak_rss_mb": r.peak_rss_mb, "raw_bytes": r.raw_bytes,
                }
                if r.ok:
                    cx = svg_complexity(r.svg)
                    row.update({
                        "path_count": cx.path_count, "node_count": cx.node_count,
                        "tiny_path_ratio": round(cx.tiny_path_ratio, 4),
                        "has_nonfinite": cx.has_nonfinite,
                        "svg_bytes": cx.svg_bytes,
                    })
                    detected, reasons = reject_decision(engine, row)
                    row["reject_detected"] = detected
                    row["reject_reasons"] = reasons
                rows.append(row)
                append_row(2, row)
                print(f"  {case.case_id:26} {engine:6} reject-signal "
                      f"path={row.get('path_count')} node={row.get('node_count')}",
                      flush=True)
                continue

            rect, gt_small, bg_ref, ref_bf, gt_nodes, gt_alpha_small = prep
            tmp_png = OUT_DIR / f"_rect2_{case.case_id}.png"
            rect.save(tmp_png)
            r = trace(engine, tmp_png, cfg)
            row = {
                "stage": 2, "case_id": case.case_id, "logo_type": case.logo_type,
                "profile": profile_of(case), "split": case.split,
                "engine": engine,
                "config": cfg.label(), "expectation": case.expectation,
                "ref_bf": round(ref_bf, 4), "gt_nodes": gt_nodes,
                "node_budget": node_budget(gt_nodes),
                "ok": r.ok, "error": r.error,
                "elapsed_s": round(r.elapsed_s, 4),
                "peak_rss_mb": r.peak_rss_mb, "raw_bytes": r.raw_bytes,
            }
            if r.ok:
                row.update(evaluate(r.svg, gt_small, bg_ref, gt_alpha_small))
                detected, reasons = reject_decision(engine, row)
                row["reject_detected"] = detected
                row["reject_reasons"] = reasons
                row["passed"] = (
                    case_passes(profile_of(case), ref_bf, gt_nodes, row) and not detected
                )
                if not row.get("skipped_render"):
                    # Lưu ảnh so sánh cho báo cáo: GT | đã dựng lại | vector.
                    save_comparison(case, engine, gt_small, rect, r.svg)
            rows.append(row)
            append_row(2, row)
            print(f"  {case.case_id:26} {engine:6} {cfg.label():22} "
                  f"{'ĐẠT' if row.get('passed') else 'ko đạt'} "
                  f"bF={row.get('boundary_f', 0):.3f} node={row.get('node_count', 0)}",
                  flush=True)
            tmp_png.unlink(missing_ok=True)
    return {"rows": rows}


def save_comparison(case: CorpusCase, engine: str, gt: Image.Image,
                    rect: Image.Image, svg: str) -> None:
    """Ghép 3 khung cạnh nhau để soi mắt: ground truth | đầu vào | kết quả."""
    px = 380
    pred = render_svg_to_png(svg, px, transparent=False).convert("RGB")
    tiles = [gt.resize((px, px), Image.Resampling.LANCZOS),
             rect.convert("RGB").resize((px, px), Image.Resampling.LANCZOS),
             pred.resize((px, px), Image.Resampling.LANCZOS)]
    sheet = Image.new("RGB", (px * 3 + 16, px), (245, 245, 245))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * (px + 8), 0))
    (OUT_DIR / "compare").mkdir(parents=True, exist_ok=True)
    sheet.save(OUT_DIR / "compare" / f"{case.case_id}__{engine}.jpg", quality=88)


# ── Chặng 4: A/B palette khóa (oracle synthetic) ───────────────────────────

_FILL_COLOR_RE = re.compile(r'fill="(#[0-9a-fA-F]{6})"')


def ground_truth_palette(case: CorpusCase) -> tuple[str, ...]:
    """Lấy palette từ SVG synthetic; đây là oracle để đo trần lợi ích, không phải dự đoán AI."""
    if not case.ground_truth_svg or not case.expected_colors:
        return ()
    text = (CORPUS / case.ground_truth_svg).read_text(encoding="utf-8")
    colors: list[str] = []
    for color in _FILL_COLOR_RE.findall(text):
        normalized = color.lower()
        if normalized not in colors:
            colors.append(normalized)
    if len(colors) != case.expected_colors:
        raise ValueError(
            f"{case.case_id}: SVG có {len(colors)} màu fill, metadata cần {case.expected_colors}"
        )
    return tuple(colors)


def stage4_palette_ab(cases: list[CorpusCase],
                      presets: dict[str, dict[str, dict]]) -> dict:
    """So cùng preset auto-color với palette ground truth trên logo màu."""
    rows, done = load_done(4)
    stage2_rows, _ = load_done(2)
    baseline = {(r.get("case_id"), r.get("engine")): r for r in stage2_rows
                if r.get("ok") and "delta_e50" in r}
    eligible = [c for c in cases if c.has_ground_truth and c.expected_colors
                and c.logo_type in ("flat_1_4", "flat_5_12", "text")]
    print(f"[Chặng 4] A/B palette oracle trên {len(eligible)} ca màu × {len(ENGINE_ORDER)} engine")
    for case in eligible:
        prep = prepare(case)
        if prep is None:
            continue
        rect, gt_small, bg_ref, ref_bf, gt_nodes, gt_alpha_small = prep
        palette = ground_truth_palette(case)
        for engine in ENGINE_ORDER:
            auto = baseline.get((case.case_id, engine))
            preset = presets.get(engine, {}).get(case.logo_type)
            if auto is None or preset is None:
                continue
            full = dict(preset["config_full"])
            if full.get("binary"):
                continue
            full["colors"] = case.expected_colors
            full["palette"] = palette
            cfg = TraceConfig(**full)
            if (case.case_id, engine, cfg.label()) in done:
                continue
            tmp_png = OUT_DIR / f"_palette_{case.case_id}.png"
            rect.save(tmp_png)
            result = trace(engine, tmp_png, cfg)
            row = {
                "stage": 4, "variant": "fixed_palette_oracle",
                "case_id": case.case_id, "logo_type": case.logo_type,
                "profile": profile_of(case), "split": case.split,
                "engine": engine, "config": cfg.label(), "palette": list(palette),
                "ok": result.ok, "error": result.error,
                "elapsed_s": round(result.elapsed_s, 4),
                "delta_e50_auto": auto["delta_e50"],
                "passed_auto": bool(auto.get("passed")),
            }
            if result.ok:
                row.update(evaluate(result.svg, gt_small, bg_ref, gt_alpha_small))
                detected, reasons = reject_decision(engine, row)
                row["reject_detected"] = detected
                row["reject_reasons"] = reasons
                row["passed_palette"] = (
                    case_passes(profile_of(case), ref_bf, gt_nodes, row) and not detected
                )
                row["delta_e50_gain"] = round(auto["delta_e50"] - row["delta_e50"], 3)
            rows.append(row)
            append_row(4, row)
            tmp_png.unlink(missing_ok=True)
    return {"rows": rows}


def summarize_palette_ab(rows: list[dict]) -> str:
    lines = ["A/B palette khóa dùng palette ground truth (oracle upper-bound):"]
    for split in ("train", "holdout"):
        for engine in ENGINE_ORDER:
            selected = [r for r in rows if r.get("ok") and r.get("split") == split
                        and r.get("engine") == engine]
            if not selected:
                continue
            auto = sum(r["delta_e50_auto"] for r in selected) / len(selected)
            fixed = sum(r["delta_e50"] for r in selected) / len(selected)
            improved = sum(r["delta_e50_gain"] > 0.1 for r in selected)
            pass_gain = (sum(bool(r.get("passed_palette")) for r in selected) -
                         sum(bool(r.get("passed_auto")) for r in selected))
            lines.append(f"  {split:7} {engine:6}: ΔE50 {auto:.2f} → {fixed:.2f}; "
                         f"cải thiện {improved}/{len(selected)}; chênh ca đạt {pass_gain:+d}")
    return "\n".join(lines)


# ── Chặng 3: RAM theo kích thước ─────────────────────────────────────────────

def stage3(cases: list[CorpusCase]) -> dict:
    print("[Chặng 3] đo peak RAM theo kích thước ảnh")
    from PIL import ImageDraw

    rows: list[dict] = []
    cfg = TraceConfig(colors=8, smoothing=0.5, despeckle_px=4)
    tmp_dir = OUT_DIR / "_ram"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    for px in (500, 1000, 2000, 4000, 6000):
        img = Image.new("RGB", (px, px), (255, 255, 255))
        d = ImageDraw.Draw(img)
        for i in range(10):
            pad = px * 0.03 * i
            d.ellipse([pad, pad, px - pad, px - pad],
                      outline=(25 * i % 255, 90, 200 - 12 * i),
                      width=max(1, px // 120))
        p = tmp_dir / f"{px}.png"
        img.save(p)
        row: dict = {"stage": 3, "pixels": px * px, "side_px": px}
        r_cli = trace("cli", p, cfg)
        row["cli_ok"] = r_cli.ok
        row["cli_s"] = round(r_cli.elapsed_s, 3)
        row["cli_peak_mb"] = round(r_cli.peak_rss_mb, 1) if r_cli.peak_rss_mb else None
        work, idle = measure_wheel_peak_rss(p, cfg)
        row["wheel_peak_mb"] = round(work, 1) if work else None
        row["wheel_idle_mb"] = round(idle, 1) if idle else None
        if work and idle:
            row["wheel_engine_mb"] = round(work - idle, 1)
        r_wheel = trace("wheel", p, cfg)
        row["wheel_ok"] = r_wheel.ok
        row["wheel_s"] = round(r_wheel.elapsed_s, 3)
        rows.append(row)
        print(f"  {px:5}px  cli {row['cli_s']:6.2f}s / {row['cli_peak_mb']} MB   "
              f"wheel {row['wheel_s']:6.2f}s / engine ~{row.get('wheel_engine_mb')} MB")
        p.unlink(missing_ok=True)
    return {"rows": rows}


# ── Tổng hợp ─────────────────────────────────────────────────────────────────

def summarize(stage2_rows: list[dict]) -> str:
    lines: list[str] = []
    groups = ["flat_1_4", "flat_5_12", "bw", "line_art", "text"]
    for split in ("train", "holdout"):
        lines.append(f"Tỷ lệ đạt split={split} (không gồm expectation=reject):")
        lines.append(f'  {"nhóm":12} {"engine":7} {"đạt":>7} {"bF tb":>7} {"node tb":>8} {"t tb":>7}')
        for group in groups:
            for engine in ENGINE_ORDER:
                sel = [r for r in stage2_rows
                       if r["logo_type"] == group and r["engine"] == engine
                       and r.get("split", "train") == split
                       and r.get("expectation") != "reject" and r.get("ok")]
                if not sel:
                    continue
                n_pass = sum(bool(r.get("passed")) for r in sel)
                bf = sum(r["boundary_f"] for r in sel) / len(sel)
                nodes = sum(r["node_count"] for r in sel) / len(sel)
                secs = sum(r["elapsed_s"] for r in sel) / len(sel)
                lines.append(f'  {group:12} {engine:7} {n_pass}/{len(sel):<5} '
                             f'{bf:7.3f} {nodes:8.0f} {secs:7.2f}')
        lines.append("")

    classified = [r for r in stage2_rows if r.get("ok") and "reject_detected" in r]
    tp = sum(r.get("expectation") == "reject" and r["reject_detected"] for r in classified)
    fp = sum(r.get("expectation") != "reject" and r["reject_detected"] for r in classified)
    fn = sum(r.get("expectation") == "reject" and not r["reject_detected"] for r in classified)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    lines.append(f"Reject classifier {REJECT_RULES_VERSION}: precision={precision:.3f} "
                 f"recall={recall:.3f} (TP={tp}, FP={fp}, FN={fn})")
    lines.append(f'  {"ca":16} {"engine":7} {"phát hiện":10} {"path":>6} {"node":>7} {"vụn":>6}')
    for r in classified:
        if r.get("expectation") != "reject" and not r["reject_detected"]:
            continue
        lines.append(f'  {r["case_id"]:16} {r["engine"]:7} '
                     f'{str(r["reject_detected"]):10} {r.get("path_count", 0):6} '
                     f'{r.get("node_count", 0):7} {r.get("tiny_path_ratio", 0):6.2f}')
    lines.append("")
    nonfinite = [r for r in stage2_rows if r.get("has_nonfinite")]
    lines.append(f"SVG chứa NaN/Inf: {len(nonfinite)}")
    failed = [r for r in stage2_rows if not r.get("ok")]
    lines.append(f"Lượt lỗi engine: {len(failed)}")
    for r in failed[:10]:
        lines.append(f"  {r['case_id']} [{r['engine']}] {r.get('error')}")
    return "\n".join(lines)

def main(argv: list[str]) -> int:
    global CORPUS, OUT_DIR, ACTIVE_CLI_PATH, RUN_ID, RUN_PROVENANCE
    ap = argparse.ArgumentParser(description="Benchmark VTracer cho cổng G1")
    ap.add_argument("--quick", action="store_true", help="ma trận nhỏ để thử đường ống")
    ap.add_argument("--stage", type=int, default=0, help="chỉ chạy một chặng (1/2/3/4)")
    ap.add_argument("--corpus", type=Path, default=CORPUS,
                    help="thư mục corpus; mặc định tính từ gốc repo")
    ap.add_argument("--cli", type=Path, default=DEFAULT_CLI,
                    help="đường dẫn vtracer CLI; cũng có thể đặt VTRACER_CLI")
    args = ap.parse_args(argv[1:])

    CORPUS = args.corpus.resolve()
    OUT_DIR = CORPUS / "bench"
    ACTIVE_CLI_PATH = args.cli.resolve()
    set_cli_path(ACTIVE_CLI_PATH)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cases = from_json(CORPUS / "corpus.json")
    RUN_PROVENANCE = build_provenance(cases)
    RUN_ID = RUN_PROVENANCE["cache_id"]
    (OUT_DIR / "provenance.json").write_text(
        json.dumps(RUN_PROVENANCE, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Corpus: {len(cases)} ca từ {CORPUS}")
    print(f"Cache: schema {CACHE_SCHEMA}, id={RUN_ID[:12]}")

    results: dict = {"provenance": RUN_PROVENANCE}
    presets_path = OUT_DIR / "presets.json"

    if args.stage in (0, 1):
        results["stage1"] = stage1(cases, args.quick)
        presets = best_presets(results["stage1"]["rows"], expected_colors_by_design(cases))
        presets_path.write_text(json.dumps(presets, ensure_ascii=False, indent=2),
                                encoding="utf-8")
        print()
        print("Preset tốt nhất theo (engine, nhóm) — xếp theo đạt → bF → ít node:")
        for engine in sorted(presets):
            for logo_type, info in sorted(presets[engine].items()):
                print(f"  {engine:6} {logo_type:12} {info['config']:24} "
                      f"đạt={info['pass_rate']:.0%} bF={info['mean_bf']:.3f} "
                      f"node tb={info['mean_nodes']:.0f}")
        print()

    if args.stage in (0, 2):
        # Preset là DỮ LIỆU DẪN XUẤT từ chặng 1 — luôn tính lại từ stage1.jsonl
        # thay vì đọc presets.json cũ. Nếu quy tắc chấm preset thay đổi mà file cũ
        # vẫn được dùng thì chặng 2 chạy bằng preset của quy tắc đã bị loại bỏ.
        stage1_rows, _ = load_done(1)
        presets = best_presets(stage1_rows, expected_colors_by_design(cases))
        presets_path.write_text(json.dumps(presets, ensure_ascii=False, indent=2),
                                encoding="utf-8")
        print("Preset dùng cho chặng 2 (số màu sẽ lấy theo từng ca):")
        for engine in sorted(presets):
            for logo_type, info in sorted(presets[engine].items()):
                print(f"  {engine:6} {logo_type:12} {info['config']:24} "
                      f"đạt={info['pass_rate']:.0%} bF={info['mean_bf']:.3f}")
        results["stage2"] = stage2(cases, presets)
        print()
        print(summarize(results["stage2"]["rows"]))
        print()

    if args.stage in (0, 3):
        results["stage3"] = stage3(cases)

    if args.stage in (0, 4):
        stage1_rows, _ = load_done(1)
        presets = best_presets(stage1_rows, expected_colors_by_design(cases))
        results["stage4"] = stage4_palette_ab(cases, presets)
        print()
        print(summarize_palette_ab(results["stage4"]["rows"]))
        print()

    out = OUT_DIR / "results.json"
    existing = {}
    if out.is_file():
        existing = json.loads(out.read_text(encoding="utf-8"))
        old_id = (existing.get("provenance") or {}).get("cache_id")
        if old_id != RUN_ID:
            existing = {}
    existing.update(results)
    out.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Đã ghi {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

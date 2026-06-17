"""
Ink_Rules_Mixin — rule preflight TAC / Ink-Limit (Total Area Coverage).

Phát hiện trang/vùng có tổng mực (C+M+Y+K + spot) vượt ngưỡng cấu hình được,
tận dụng SeparationEngine (đã tách kênh CMYK + spot). Mọi đường ghi PDF (nếu có
auto-fix sau này) phải qua pikepdf — KHÔNG dùng pdfium để ghi.
"""
import base64
import logging
import zlib

import numpy as np

from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

# ── Hằng cấu hình TAC ────────────────────────────────────────────────────────
TAC_RENDER_DPI = 100          # DPI render thấp cho phân tích TAC (Yêu cầu 9.2)
TAC_DEFAULT_THRESHOLD = 300   # ngưỡng mặc định (%) (Yêu cầu 7.1)
TAC_THRESHOLD_MIN = 100
TAC_THRESHOLD_MAX = 400
TAC_MAX_BBOXES = 50           # trần số vùng vi phạm báo cáo mỗi trang (Yêu cầu 8.2)
TAC_TILE_PX = 16              # kích thước ô grid-tiling khi gom vùng vi phạm


def _normalize_tac_threshold(value) -> int:
    """
    Chuẩn hoá ngưỡng TAC (Yêu cầu 7.1, 7.2, 7.3):
      - Số (int/float) trong [TAC_THRESHOLD_MIN, TAC_THRESHOLD_MAX] → int(value).
      - Ngoài khoảng hoặc không phải số (None/chuỗi không số/NaN/inf) → 300.
    """
    try:
        if isinstance(value, bool):
            return TAC_DEFAULT_THRESHOLD
        num = float(value)
    except (TypeError, ValueError):
        return TAC_DEFAULT_THRESHOLD
    if num != num or num in (float("inf"), float("-inf")):
        return TAC_DEFAULT_THRESHOLD
    if TAC_THRESHOLD_MIN <= num <= TAC_THRESHOLD_MAX:
        return int(num)
    return TAC_DEFAULT_THRESHOLD


def _decode_plate_alpha(alpha_b64: str, width: int, height: int) -> "np.ndarray":
    """Giải nén alpha_data (zlib+base64) → ndarray uint8 shape (height, width)."""
    raw = zlib.decompress(base64.b64decode(alpha_b64))
    arr = np.frombuffer(raw, dtype=np.uint8)
    if arr.size != width * height:
        # Kích thước không khớp → cắt/đệm an toàn
        arr = arr[: width * height]
        if arr.size < width * height:
            arr = np.pad(arr, (0, width * height - arr.size))
    return arr.reshape(height, width)


def compute_tac_percent(plate_arrays: list["np.ndarray"]) -> "np.ndarray":
    """
    Tính ma trận TAC (%) = Σ(kênh)/255*100 theo từng điểm (Yêu cầu 6.2, 9.4).
    Mỗi kênh ink_density 0..255 (255 = 100% mực). Spot cộng như process.
    """
    if not plate_arrays:
        return np.zeros((1, 1), dtype=np.float32)
    acc = np.zeros(plate_arrays[0].shape, dtype=np.float32)
    for a in plate_arrays:
        acc += a.astype(np.float32)
    return acc / 255.0 * 100.0


def _cluster_mask_to_bboxes(mask: "np.ndarray", tile_px: int, max_bboxes: int) -> list[list[int]]:
    """
    Gom vùng True của `mask` thành bbox pixel (top-left origin) bằng grid-tiling +
    gộp ô kề (4-neighbour). Giới hạn `max_bboxes` cụm lớn nhất (Yêu cầu 8.1, 8.2).
    """
    h, w = mask.shape
    if not mask.any():
        return []
    ty = (h + tile_px - 1) // tile_px
    tx = (w + tile_px - 1) // tile_px

    hot = np.zeros((ty, tx), dtype=bool)
    for j in range(ty):
        for i in range(tx):
            sub = mask[j * tile_px:(j + 1) * tile_px, i * tile_px:(i + 1) * tile_px]
            if sub.any():
                hot[j, i] = True

    visited = np.zeros((ty, tx), dtype=bool)
    bboxes: list[list[int]] = []
    for j in range(ty):
        for i in range(tx):
            if not hot[j, i] or visited[j, i]:
                continue
            # BFS gom cụm ô nóng kề nhau
            stack = [(j, i)]
            visited[j, i] = True
            min_i, max_i, min_j, max_j = i, i, j, j
            while stack:
                cj, ci = stack.pop()
                min_i, max_i = min(min_i, ci), max(max_i, ci)
                min_j, max_j = min(min_j, cj), max(max_j, cj)
                for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nj, ni = cj + dj, ci + di
                    if 0 <= nj < ty and 0 <= ni < tx and hot[nj, ni] and not visited[nj, ni]:
                        visited[nj, ni] = True
                        stack.append((nj, ni))
            px0 = min_i * tile_px
            py0 = min_j * tile_px
            px1 = min((max_i + 1) * tile_px, w)
            py1 = min((max_j + 1) * tile_px, h)
            bboxes.append([px0, py0, px1, py1])

    if len(bboxes) > max_bboxes:
        bboxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        bboxes = bboxes[:max_bboxes]
    return bboxes


def _px_bbox_to_pdf_point(bbox_px, img_w, img_h, page_h_pt, render_dpi) -> list[float]:
    """
    Quy đổi bbox pixel (top-left origin) → point (PDF bottom-left) (Yêu cầu 8.4).
    scale = 72/render_dpi; lật trục y theo page_h_pt.
    """
    scale = 72.0 / render_dpi
    px0, py0, px1, py1 = bbox_px
    x0 = px0 * scale
    x1 = px1 * scale
    y_top = py0 * scale
    y_bot = py1 * scale
    y0 = page_h_pt - y_bot
    y1 = page_h_pt - y_top
    return [x0, y0, x1, y1]


def _run_coro_sync(coro):
    """Chạy coroutine an toàn dù đang ở trong/ngoài event loop."""
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(lambda: asyncio.run(coro)).result()


class InkRulesMixin:
    """Mixin chứa rule TAC / Ink-Limit."""

    def _check_tac(
        self, doc, page_nums: list[int] = None, tac_threshold: int = TAC_DEFAULT_THRESHOLD
    ) -> list[PreflightIssue]:
        from app.core.separations import SeparationEngine

        issues: list[PreflightIssue] = []
        threshold = _normalize_tac_threshold(tac_threshold)
        pdf_path = getattr(doc, "_path", None)
        if pdf_path is None:
            return issues

        engine = SeparationEngine()
        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)

        for page_idx in target_pages:
            page_num = page_idx + 1
            try:
                # Chiều cao trang (point) để quy đổi y
                mb = doc.pages[page_idx].get("/MediaBox")
                page_h_pt = float(mb[3]) - float(mb[1]) if mb else None

                # TAC cần tổng mực thật trên từng kênh CMYK — pikepdf fallback chỉ ~100%/điểm
                # với fill CMYK đặc; bắt buộc Ghostscript tiffsep (giống Separations preview).
                sep = _run_coro_sync(
                    engine.extract_separations(
                        pdf_path, page_num, dpi=TAC_RENDER_DPI, use_ghostscript=True
                    )
                )
                if sep.get("engine") != "ghostscript":
                    logger.warning(
                        "TAC trang %d: Ghostscript không khả dụng, bỏ qua kiểm tra TAC.",
                        page_num,
                    )
                    continue
                width = int(sep.get("width", 0))
                height = int(sep.get("height", 0))
                plates = sep.get("plates", [])
                if width <= 0 or height <= 0 or not plates:
                    continue
                if page_h_pt is None:
                    page_h_pt = height * 72.0 / TAC_RENDER_DPI

                plate_arrays = [
                    _decode_plate_alpha(p["alpha_data"], width, height)
                    for p in plates if p.get("alpha_data")
                ]
                if not plate_arrays:
                    continue

                tac_pct = compute_tac_percent(plate_arrays)
                max_tac = float(tac_pct.max())
                if max_tac <= threshold:
                    continue

                mask = tac_pct > threshold
                area_pct = float(mask.mean() * 100.0)
                bboxes_px = _cluster_mask_to_bboxes(mask, TAC_TILE_PX, TAC_MAX_BBOXES)
                bboxes_pt = [
                    _px_bbox_to_pdf_point(b, width, height, page_h_pt, TAC_RENDER_DPI)
                    for b in bboxes_px
                ]

                issues.append(PreflightIssue(
                    rule_id="TAC_EXCEEDED",
                    severity="warning",
                    page=page_num,
                    object_ref="Tổng mực (TAC)",
                    description=(
                        f"TAC tối đa {round(max_tac)}% vượt ngưỡng {threshold}%. "
                        f"Diện tích vượt ~{round(area_pct)}% trang. "
                        f"Cần giảm tổng mực để tránh in lem/bong/khô chậm."
                    ),
                    auto_fixable=False,  # giảm tổng mực rủi ro cao, cần can thiệp thủ công (Yêu cầu 10.3)
                    bbox=bboxes_pt[0] if bboxes_pt else None,
                    bboxes=bboxes_pt or None,
                ))
            except Exception as exc:  # noqa: BLE001
                logger.error("TAC check lỗi trang %d: %s", page_num, exc)
                issues.append(PreflightIssue(
                    rule_id="INTERNAL_ERROR",
                    severity="error",
                    page=page_num,
                    object_ref="Hệ thống",
                    description=f"Lỗi phân tích TAC trang {page_num}: {exc}",
                    auto_fixable=False,
                ))
        return issues

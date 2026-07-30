"""
channel_remover — Gỡ kênh màu process (C/M/Y/K) khỏi PDF có bù màu (re-separation).

Tính năng cho phép in một file CMYK bằng ít mực hơn (4→3 hoặc 4→2) bằng cách bỏ
một hoặc nhiều kênh process. Hai chế độ:

  - Direct_Removal_Mode ("direct"): đặt mọi Removed_Channel về 0, giữ nguyên
    Kept_Channel.
  - Re_Separation_Mode ("reseparate"): với mỗi màu CMYK gốc, chuyển sang Lab qua
    ICC FOGRA39 (LittleCMS2 / PIL.ImageCms), rồi tìm tổ hợp CMYK chỉ dùng
    Kept_Channel có Delta_E nhỏ nhất. Màu không tái tạo được (ΔE > Gamut_Threshold)
    bị đánh dấu Out_Of_Gamut_Region và preview tô đỏ.

Module bám sát quy ước codebase: quét content stream byte-level (tái dùng kỹ thuật
``overprint_black.py`` / ``preserve_black.py``), ICC qua ``PIL.ImageCms`` (giống
``softproof.py``), pikepdf để mở/ghi PDF, và được đăng ký như một action trong
``action_engine.py``.

LƯU Ý (task 1.1): file này hiện chỉ định nghĩa hằng số, data models và chữ ký hàm.
Phần cài đặt đầy đủ được hoàn thiện ở các task sau.
"""
from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass, field
from itertools import product

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Hằng số / cấu hình
# ---------------------------------------------------------------------------

#: Bốn kênh process theo thứ tự vị trí 0..3 trong tuple CMYK.
PROCESS_CHANNELS: tuple[str, str, str, str] = ("C", "M", "Y", "K")

#: Total Area Coverage tối đa mặc định (%) — Req 8.1.
DEFAULT_TAC_LIMIT: float = 360.0

#: Ngưỡng ΔE mặc định để phân loại một màu là Out_Of_Gamut.
DEFAULT_GAMUT_THRESHOLD: float = 5.0

#: Bước lưới (%) khi liệt kê tổ hợp CMYK chỉ-dùng-Kept_Channel cho LUT.
DEFAULT_GRID_STEP: float = 5.0

#: Cache LUT kênh-giữ dùng chung giữa các instance, khoá theo
#: (icc_path, tập kênh-giữ đã chuẩn hoá, grid_step) — bảo đảm tái dùng giữa
#: vector & ảnh và tính xác định (idempotent) của tái tách.
_LUT_CACHE: dict[tuple, list[tuple[tuple[float, float, float, float],
                                   tuple[float, float, float]]]] = {}


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class ChannelRemovalParams:
    """Tham số đã được validate cho một lần gỡ kênh.

    - ``kept_channels``: tập con của {C, M, Y, K}, từ 1 đến 3 phần tử (Req 1.2).
    - ``mode``: "direct" (xóa thẳng) hoặc "reseparate" (bù màu).
    - ``tac_limit``: ngưỡng TAC tối đa (%) cho màu kết quả (Req 8).
    - ``gamut_threshold``: ngưỡng ΔE phân loại Out_Of_Gamut.
    - ``spot_handling``: "skip" (giữ nguyên) hoặc "convert" (chuyển CMYK trước) (Req 7).
    - ``process_hidden_layers``: xử lý nội dung OCG ẩn hay không (Req 12).
    - ``grid_step``: bước lưới LUT kênh-giữ (%).
    """
    kept_channels: tuple[str, ...]
    mode: str
    tac_limit: float = DEFAULT_TAC_LIMIT
    gamut_threshold: float = DEFAULT_GAMUT_THRESHOLD
    spot_handling: str = "skip"
    process_hidden_layers: bool = False
    grid_step: float = DEFAULT_GRID_STEP


@dataclass
class ChannelRemovalReport:
    """Báo cáo kết quả gỡ kênh trả về cho Action_Engine / UI.

    - ``output_filename``: tên file kết quả để tải qua Download_Endpoint (Req 9.2).
    - ``max_delta_e`` / ``avg_delta_e``: thống kê ΔE toàn bộ màu đã xử lý (Req 4.1).
    - ``out_of_gamut_count``: số màu thuộc Out_Of_Gamut_Region.
    - ``total_colors``: tổng số màu đã xử lý.
    - ``warnings``: danh sách cảnh báo (OOG, JPEG-CMYK, no-op, ...).
    - ``identical_to_original``: False nếu tồn tại OOG (Req 4.4).
    """
    output_filename: str | None
    max_delta_e: float
    avg_delta_e: float
    out_of_gamut_count: int
    total_colors: int
    warnings: list[str] = field(default_factory=list)
    identical_to_original: bool = True


@dataclass
class ColorHit:
    """Một màu CMYK đã được biến đổi trong content stream (vector)."""
    source_cmyk: tuple[float, float, float, float]
    result_cmyk: tuple[float, float, float, float]
    delta_e: float
    out_of_gamut: bool


@dataclass
class ImageHit:
    """Tổng hợp kết quả biến đổi của một CMYK_Image_XObject."""
    xobj_name: str
    pixels: int
    max_delta_e: float
    out_of_gamut_pixels: int


# ---------------------------------------------------------------------------
# Clamp helpers — range [0,100] + giới hạn TAC (Req 8.2, 8.3)
# ---------------------------------------------------------------------------
#
# Các hàm thuần (pure) dùng chung bởi ColorMapper (task 3.2/4.3) để áp ràng buộc
# hợp lệ lên màu CMYK kết quả:
#   - clamp_range: mỗi kênh nằm trong [0, 100] (Req 8.3).
#   - clamp_tac:   nếu ΣTAC > tac_limit thì scale giảm đồng đều các kênh > 0 về
#                  đúng tac_limit, GIỮ tỉ lệ tương đối giữa các kênh (Req 8.2).
#   - clamp_color: tiện ích gộp — clamp_range trước, rồi clamp_tac.

#: Giá trị tối đa cho mỗi kênh process (%).
CHANNEL_MAX: float = 100.0


def clamp_range(cmyk: tuple[float, float, float, float]
                ) -> tuple[float, float, float, float]:
    """Clamp mỗi kênh CMYK về khoảng [0, 100] (%) — Req 8.3.

    Đầu vào là tuple 4 float (thang 0..100). Mỗi giá trị < 0 trả về 0, > 100 trả
    về 100. Không thay đổi tỉ lệ giữa các kênh; chỉ cắt biên từng kênh độc lập.
    """
    c, m, y, k = cmyk
    return (
        min(CHANNEL_MAX, max(0.0, float(c))),
        min(CHANNEL_MAX, max(0.0, float(m))),
        min(CHANNEL_MAX, max(0.0, float(y))),
        min(CHANNEL_MAX, max(0.0, float(k))),
    )


def clamp_tac(cmyk: tuple[float, float, float, float],
              tac_limit: float) -> tuple[float, float, float, float]:
    """Giới hạn tổng phủ mực (TAC) của màu kết quả ≤ ``tac_limit`` — Req 8.2.

    Nếu tổng C+M+Y+K vượt ``tac_limit``, scale giảm đồng đều TẤT CẢ các kênh > 0
    theo cùng một hệ số ``tac_limit / total`` sao cho tổng mới đúng bằng
    ``tac_limit``. Vì các kênh = 0 nhân hệ số vẫn = 0, phép scale chỉ tác động lên
    các kênh > 0 và giữ nguyên tỉ lệ tương đối giữa chúng (ưu tiên giữ hue).

    Trường hợp biên:
      - TAC ≤ ``tac_limit``: trả nguyên màu (không cần scale).
      - ``tac_limit`` ≤ 0: mọi kênh về 0 (không cho phép phủ mực).
      - total = 0: trả nguyên màu (không có gì để scale).
    """
    c, m, y, k = (float(v) for v in cmyk)
    total = c + m + y + k

    if tac_limit <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)

    if total <= tac_limit or total <= 0.0:
        return (c, m, y, k)

    factor = tac_limit / total
    return (c * factor, m * factor, y * factor, k * factor)


def clamp_color(cmyk: tuple[float, float, float, float],
                tac_limit: float) -> tuple[float, float, float, float]:
    """Áp lần lượt clamp_range rồi clamp_tac cho một màu CMYK kết quả.

    Bảo đảm bất biến hợp lệ của màu kết quả (Req 8.2, 8.3): mọi kênh ∈ [0, 100]
    và tổng TAC ≤ ``tac_limit``. Lưu ý thứ tự: clamp_range trước để loại giá trị
    âm/vượt biên, sau đó clamp_tac mới phản ánh đúng tổng phủ mực hợp lệ.
    """
    return clamp_tac(clamp_range(cmyk), tac_limit)


# ---------------------------------------------------------------------------
# ReSeparationEngine — FOGRA39 CMYK↔Lab + ΔE (CIE76)
# ---------------------------------------------------------------------------

def _default_icc_path() -> str:
    """Đường dẫn ICC FOGRA39 mặc định lấy từ settings.

    Tách riêng để import settings ở mức hàm, tránh phụ thuộc vòng khi module
    được import sớm trong vòng đời ứng dụng.
    """
    from app.config import settings

    return os.path.join(settings.ICC_PROFILE_DIR, settings.DEFAULT_CMYK_PROFILE)


class ReSeparationEngine:
    """Chuyển đổi màu CMYK↔Lab qua ICC FOGRA39 (LittleCMS2 / PIL.ImageCms).

    Đồng bộ quy ước ``softproof.py``: dùng ``ImageCms.getOpenProfile`` để mở
    profile FOGRA39 và ``ImageCms.buildTransform`` để dựng phép chuyển
    ``CMYK → LAB`` với rendering intent RELATIVE_COLORIMETRIC.

    LƯU Ý (task 4.1): chỉ cài ``to_lab`` (CMYK 0..100 → Lab) và ``delta_e_cie76``.
    Phần LUT kênh-giữ + argmin (``best_kept_only``) được hoàn thiện ở task 4.2.
    """

    def __init__(self, icc_path: str | None = None,
                 kept_channels: tuple[str, ...] | None = None,
                 grid_step: float = DEFAULT_GRID_STEP):
        # Profile FOGRA39 lấy từ settings nếu không truyền tường minh (Req 3.1).
        self.icc_path = icc_path or _default_icc_path()
        if not os.path.isfile(self.icc_path):
            # Thông báo lỗi rõ ràng (đồng bộ _action_convert_to_cmyk) — Req 3.1.
            raise FileNotFoundError(
                f"ICC Profile FOGRA39 không tìm thấy: {self.icc_path}"
            )

        self.kept_channels = tuple(kept_channels) if kept_channels else ()
        self.grid_step = grid_step

        # Transform CMYK→LAB được dựng lười (lazy) và cache để tái dùng.
        self._cmyk_to_lab_tf = None

        # LUT kênh-giữ (list[(cmyk_kept_only, lab)]) được dựng lười và cache.
        self._lut = None

    # -- ImageCms helpers ----------------------------------------------------

    def _ensure_transform(self):
        """Dựng (một lần) transform CMYK→LAB qua FOGRA39, cache lại."""
        if self._cmyk_to_lab_tf is not None:
            return self._cmyk_to_lab_tf

        from PIL import ImageCms

        fogra = ImageCms.getOpenProfile(self.icc_path)
        lab_profile = ImageCms.createProfile("LAB")
        self._cmyk_to_lab_tf = ImageCms.buildTransform(
            fogra,
            lab_profile,
            "CMYK",
            "LAB",
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        )
        return self._cmyk_to_lab_tf

    # -- Color conversion ----------------------------------------------------

    def to_lab(self, cmyk: tuple[float, float, float, float]
               ) -> tuple[float, float, float]:
        """Chuyển một màu CMYK (thang 0..100 %) sang Lab qua FOGRA39.

        Quy ước thang đo:
          - Đầu vào CMYK: mỗi kênh 0..100 (%); được clamp về [0, 100] rồi quy về
            byte 0..255 cho ảnh PIL mode "CMYK" (0 = không mực, 255 = đầy mực).
          - Đầu ra mode "LAB" của PIL: L 0..255 ↔ 0..100; a/b 0..255 ↔ -128..127
            (lệch +128). Trả về Lab thực: ``(L, a, b)`` với L∈[0,100], a,b∈[-128,127].
        """
        from PIL import Image, ImageCms

        c, m, y, k = (max(0.0, min(100.0, float(v))) for v in cmyk)
        px = (
            round(c / 100.0 * 255.0),
            round(m / 100.0 * 255.0),
            round(y / 100.0 * 255.0),
            round(k / 100.0 * 255.0),
        )
        src = Image.new("CMYK", (1, 1), px)
        tf = self._ensure_transform()
        out = ImageCms.applyTransform(src, tf)
        lab_l, lab_a, lab_b = out.getpixel((0, 0))

        return (
            lab_l * 100.0 / 255.0,
            float(lab_a) - 128.0,
            float(lab_b) - 128.0,
        )

    @staticmethod
    def delta_e_cie76(lab1: tuple[float, float, float],
                      lab2: tuple[float, float, float]) -> float:
        """Khoảng cách màu CIE76 (Euclid trong không gian Lab)."""
        dl = lab1[0] - lab2[0]
        da = lab1[1] - lab2[1]
        db = lab1[2] - lab2[2]
        return math.sqrt(dl * dl + da * da + db * db)

    # -- LUT kênh-giữ + argmin ΔE -------------------------------------------

    def _grid_values(self) -> list[float]:
        """Liệt kê các mức phủ mực (%) trên lưới theo ``grid_step``.

        Luôn gồm 0 và 100 ở hai biên. Ví dụ ``grid_step=5`` →
        ``[0, 5, 10, ..., 95, 100]``. Nếu 100 không phải bội số của bước, vẫn
        thêm 100 vào cuối để bao trùm mức phủ mực tối đa.
        """
        step = self.grid_step
        if step is None or step <= 0:
            # Bước không hợp lệ → tối thiểu xét hai biên 0 và 100.
            return [0.0, 100.0]

        count = int(math.floor(100.0 / step))
        values = [min(round(i * step, 6), 100.0) for i in range(count + 1)]
        if values[-1] < 100.0:
            values.append(100.0)
        return values

    def _kept_indices(self) -> list[int]:
        """Chỉ số kênh (0..3) của các Kept_Channel theo thứ tự process chuẩn."""
        return [PROCESS_CHANNELS.index(ch)
                for ch in PROCESS_CHANNELS if ch in self.kept_channels]

    def _to_lab_batch(self, cmyk_list: list[tuple[float, float, float, float]]
                      ) -> list[tuple[float, float, float]]:
        """Chuyển hàng loạt màu CMYK (0..100 %) sang Lab trong một transform.

        Dồn toàn bộ màu vào một ảnh PIL ``CMYK`` 1×N rồi áp transform một lần để
        dựng LUT nhanh hơn nhiều so với gọi ``to_lab`` từng màu. Quy ước thang đo
        + làm tròn khớp y hệt ``to_lab`` để bảo đảm tính nhất quán/idempotent.
        """
        from PIL import Image, ImageCms

        n = len(cmyk_list)
        if n == 0:
            return []

        src = Image.new("CMYK", (n, 1))
        px = src.load()
        for i, cmyk in enumerate(cmyk_list):
            c, m, y, k = (max(0.0, min(100.0, float(v))) for v in cmyk)
            px[i, 0] = (
                round(c / 100.0 * 255.0),
                round(m / 100.0 * 255.0),
                round(y / 100.0 * 255.0),
                round(k / 100.0 * 255.0),
            )

        tf = self._ensure_transform()
        out = ImageCms.applyTransform(src, tf)
        op = out.load()

        result: list[tuple[float, float, float]] = []
        for i in range(n):
            lab_l, lab_a, lab_b = op[i, 0]
            result.append((
                lab_l * 100.0 / 255.0,
                float(lab_a) - 128.0,
                float(lab_b) - 128.0,
            ))
        return result

    def _build_lut(self) -> list[tuple[tuple[float, float, float, float],
                                       tuple[float, float, float]]]:
        """Liệt kê tổ hợp CMYK chỉ-dùng-Kept_Channel + Lab tương ứng.

        Mỗi tổ hợp cho các Kept_Channel chạy trên lưới ``grid_step`` (0..100),
        các Removed_Channel cố định = 0. Trả list ``[(cmyk_kept_only, lab), ...]``.
        """
        kept_indices = self._kept_indices()
        if not kept_indices:
            raise ValueError(
                "Không thể dựng LUT: chưa chọn Kept_Channel nào cho ReSeparationEngine."
            )

        grid = self._grid_values()
        cmyk_list: list[tuple[float, float, float, float]] = []
        for combo in product(grid, repeat=len(kept_indices)):
            channels = [0.0, 0.0, 0.0, 0.0]
            for idx, value in zip(kept_indices, combo):
                channels[idx] = value
            cmyk_list.append((channels[0], channels[1], channels[2], channels[3]))

        labs = self._to_lab_batch(cmyk_list)
        return list(zip(cmyk_list, labs))

    def _ensure_lut(self) -> list[tuple[tuple[float, float, float, float],
                                        tuple[float, float, float]]]:
        """Dựng (một lần) và cache LUT kênh-giữ theo (icc, kept, grid_step)."""
        if self._lut is not None:
            return self._lut

        key = (self.icc_path, self.kept_channels, self.grid_step)
        cached = _LUT_CACHE.get(key)
        if cached is None:
            cached = self._build_lut()
            _LUT_CACHE[key] = cached
        self._lut = cached
        return cached

    def best_kept_only(self, target_lab: tuple[float, float, float]
                       ) -> tuple[tuple[float, float, float, float], float]:
        """Tìm tổ hợp CMYK chỉ-dùng-Kept_Channel có ΔE nhỏ nhất so với ``target_lab``.

        Trả ``(cmyk_kept_only, delta_e_min)`` — argmin ΔE (CIE76) trên LUT đã cache
        (Req 3.1). Khi có nhiều ứng viên đồng ΔE, chọn ứng viên đầu tiên theo thứ
        tự liệt kê LUT để bảo đảm kết quả xác định (idempotent).
        """
        lut = self._ensure_lut()

        best_cmyk: tuple[float, float, float, float] | None = None
        best_delta_e = math.inf
        for cmyk, lab in lut:
            delta_e = self.delta_e_cie76(target_lab, lab)
            if delta_e < best_delta_e:
                best_delta_e = delta_e
                best_cmyk = cmyk

        if best_cmyk is None:  # pragma: no cover - LUT luôn có ít nhất 1 điểm
            raise ValueError("LUT kênh-giữ rỗng: không tìm được màu phù hợp.")

        return best_cmyk, best_delta_e


# ---------------------------------------------------------------------------
# ColorMapper — áp một phép biến đổi CMYK→CMYK cho một màu đơn
# ---------------------------------------------------------------------------

class ColorMapper:
    """Áp phép biến đổi màu CMYK→CMYK cho MỘT màu đơn theo mode đã chọn.

    Được dùng chung bởi ContentStreamTransformer (vector) và
    ImageXObjectTransformer (ảnh). Sau khi biến đổi theo mode, luôn áp
    ``clamp_color`` (range [0,100] + TAC ≤ tac_limit) lên màu kết quả để bảo đảm
    bất biến hợp lệ (Req 8.2, 8.3).

    Tham số khởi tạo:
      - ``params``: ``ChannelRemovalParams`` đã validate (xác định kept/removed,
        tac_limit, gamut_threshold, mode).
      - ``engine``: ``ReSeparationEngine`` (tùy chọn) cho chế độ "reseparate".
        Ở task hiện tại CHỈ cài chế độ "direct"; tham số ``engine`` được nhận và
        lưu sẵn làm điểm mở rộng cho task 4.3 tích hợp re-separation.

    Chế độ "reseparate" (task 4.3): với mỗi màu CMYK gốc, chuyển sang Lab qua
    FOGRA39, chọn tổ hợp chỉ-dùng-Kept_Channel có ΔE nhỏ nhất (``engine`` bắt
    buộc), đặt cờ ``out_of_gamut = (delta_e_min > gamut_threshold)``, rồi clamp.
    """

    def __init__(self, params: ChannelRemovalParams,
                 engine: "ReSeparationEngine | None" = None):
        self.params = params
        self.engine = engine
        # Chỉ số (0..3) của các Kept_Channel — dùng để giữ nguyên/đặt 0 nhanh.
        self._kept_indices: frozenset[int] = frozenset(
            PROCESS_CHANNELS.index(ch)
            for ch in PROCESS_CHANNELS if ch in params.kept_channels
        )

    def _map_direct(self, cmyk: tuple[float, float, float, float]
                    ) -> tuple[float, float, float, float]:
        """Direct_Removal_Mode: Removed_Channel→0, Kept_Channel giữ nguyên (Req 2.1, 2.2)."""
        return tuple(
            float(value) if idx in self._kept_indices else 0.0
            for idx, value in enumerate(cmyk)
        )  # type: ignore[return-value]

    def _map_reseparate(self, cmyk: tuple[float, float, float, float]
                        ) -> tuple[tuple[float, float, float, float], float, bool]:
        """Re_Separation_Mode: chọn argmin ΔE kênh-giữ + cờ Out_Of_Gamut (Req 3.1, 3.3, 3.4).

        Yêu cầu ``self.engine`` (``ReSeparationEngine``) phải được tiêm sẵn — thiết
        kế ưu tiên engine được inject (chủ sở hữu là tầng điều phối ``remove_channels``)
        để tái dùng/cache LUT giữa vector và ảnh. Quy trình:
          - ``target_lab = engine.to_lab(cmyk)``: màu gốc → Lab qua FOGRA39.
          - ``(cmyk_kept_only, delta_e_min) = engine.best_kept_only(target_lab)``:
            tổ hợp chỉ-dùng-Kept_Channel có ΔE nhỏ nhất (Removed_Channel đã = 0 do
            LUT chỉ liệt kê kênh-giữ — Req 3.2).
          - ``out_of_gamut = (delta_e_min > gamut_threshold)`` (Req 3.4).
        Trả ``(cmyk_kept_only, delta_e_min, out_of_gamut)`` (chưa clamp — clamp ở
        ``map_color``).
        """
        if self.engine is None:
            raise ValueError(
                "Chế độ 'reseparate' yêu cầu một ReSeparationEngine: "
                "engine chưa được tiêm vào ColorMapper."
            )

        target_lab = self.engine.to_lab(cmyk)
        cmyk_kept_only, delta_e_min = self.engine.best_kept_only(target_lab)
        is_out_of_gamut = delta_e_min > self.params.gamut_threshold
        return cmyk_kept_only, delta_e_min, is_out_of_gamut

    def map_color(self, cmyk: tuple[float, float, float, float]
                  ) -> tuple[tuple[float, float, float, float], float, bool]:
        """Biến đổi một màu CMYK (thang 0..100 %) theo mode đã chọn.

        Trả ``(result_cmyk, delta_e, is_out_of_gamut)``:
          - Direct: Removed_Channel→0, Kept_Channel giữ nguyên (Req 2.1, 2.2);
            ``delta_e = 0.0`` và ``is_out_of_gamut = False`` (xóa thẳng không bù
            màu nên không đo ΔE / không phân loại OOG — re-separation mới xử lý
            OOG).
          - Reseparate: chọn tổ hợp chỉ-dùng-Kept_Channel có ΔE nhỏ nhất qua
            ``self.engine`` (Req 3.1), Removed_Channel→0 (Req 3.2),
            ``is_out_of_gamut = (delta_e > gamut_threshold)`` (Req 3.3, 3.4).
          - Sau cùng: áp ``clamp_color`` (range [0,100] + TAC ≤ tac_limit)
            (Req 8.2, 8.3).
        """
        if self.params.mode == "reseparate":
            result, delta_e, is_out_of_gamut = self._map_reseparate(cmyk)
            result = clamp_color(result, self.params.tac_limit)
            return result, delta_e, is_out_of_gamut

        # --- Direct_Removal_Mode ---
        result = self._map_direct(cmyk)
        result = clamp_color(result, self.params.tac_limit)
        return result, 0.0, False


# ===========================================================================
# ContentStreamTransformer — quét byte-level + theo dõi color space
# ===========================================================================
#
# Tổng quát hoá kỹ thuật quét token an toàn của ``overprint_black.py`` /
# ``preserve_black.py`` thành một transformer biến đổi TẠI CHỖ cho content stream.
#
# TASK 6.1 (phần này): chỉ cài NỀN TẢNG SCANNER —
#   - Vòng quét token an toàn: bỏ qua string literal ``( )``, hex string ``< >``,
#     dict ``<< >>``, comment ``%``, inline image ``BI…ID…EI``; quản lý stack
#     graphics state qua ``q``/``Q`` (Req 5.1, 5.2).
#   - Theo dõi color space hiện hành của fill/stroke (``cs``/``CS`` + tra cứu
#     ``/Resources/ColorSpace``) để xác định DeviceCMYK / ICCBased N=4 cho
#     ``scn``/``SCN`` (Req 5.4). Các operator đặt màu trực tiếp (``k``/``K`` →
#     DeviceCMYK, ``g``/``G`` → Gray, ``rg``/``RG`` → RGB) cũng cập nhật color
#     space hiện hành.
#
# Việc BIẾN ĐỔI toán hạng màu (thay khoảng byte 4 toán hạng bằng ``map_color``,
# nhân/chia 100, thu thập ``ColorHit``, xử lý spot) được để cho TASK 6.2 thông
# qua hook ``_handle_color_operator`` (xem docstring hook). Ở task 6.1 hook là
# no-op nên ``transform`` trả về content stream NGUYÊN VẸN (bytewise) — phù hợp
# với việc chưa có biến đổi nào.
# ---------------------------------------------------------------------------

#: Ký tự whitespace của cú pháp PDF (đồng bộ ``overprint_black._WS``).
_WS = b" \t\r\n\f\x00"

#: Ký tự delimiter của cú pháp PDF (đồng bộ ``overprint_black._DELIM``).
_DELIM = b"()<>[]{}/%"


class ColorSpaceKind:
    """Phân loại color space để quyết định cách xử lý toán hạng màu.

    Chỉ ``CMYK`` (DeviceCMYK hoặc ICCBased N=4) là nhóm cần biến đổi 4 toán hạng
    CMYK ở task 6.2. Các nhóm còn lại được phân loại để hook có đủ ngữ cảnh:
    ``SEPARATION``/``DEVICEN`` xử lý theo ``spot_handling``; ``RGB``/``GRAY``/
    ``PATTERN``/``INDEXED``/``LAB``/``UNKNOWN`` mặc định giữ nguyên.
    """
    CMYK = "cmyk"            # DeviceCMYK hoặc ICCBased N=4
    RGB = "rgb"             # DeviceRGB / CalRGB / ICCBased N=3
    GRAY = "gray"           # DeviceGray / CalGray / ICCBased N=1
    SEPARATION = "separation"
    DEVICEN = "devicen"
    PATTERN = "pattern"
    INDEXED = "indexed"
    LAB = "lab"
    UNKNOWN = "unknown"


#: Toán tử đặt color space (toán hạng đứng trước là một /Name).
_CS_FILL_OP = b"cs"
_CS_STROKE_OP = b"CS"

#: Toán tử đặt màu "đặc biệt" theo color space hiện hành (Req 5.4).
_SCN_FILL_OPS = frozenset((b"sc", b"scn"))
_SCN_STROKE_OPS = frozenset((b"SC", b"SCN"))

#: Toán tử đặt màu device trực tiếp — cũng đặt color space hiện hành.
_DEVICE_FILL_OPS = {b"k": ColorSpaceKind.CMYK, b"g": ColorSpaceKind.GRAY,
                    b"rg": ColorSpaceKind.RGB}
_DEVICE_STROKE_OPS = {b"K": ColorSpaceKind.CMYK, b"G": ColorSpaceKind.GRAY,
                      b"RG": ColorSpaceKind.RGB}

#: Tên device color space dùng trực tiếp làm toán hạng của ``cs``/``CS``.
_DEVICE_CS_NAMES = {
    "/DeviceCMYK": ColorSpaceKind.CMYK,
    "/DeviceRGB": ColorSpaceKind.RGB,
    "/DeviceGray": ColorSpaceKind.GRAY,
    "/Pattern": ColorSpaceKind.PATTERN,
    # Dạng viết tắt (chủ yếu cho inline image, nhưng nhận luôn cho an toàn):
    "/CMYK": ColorSpaceKind.CMYK,
    "/RGB": ColorSpaceKind.RGB,
    "/G": ColorSpaceKind.GRAY,
    "/I": ColorSpaceKind.INDEXED,
}


def _format_pdf_number(value: float) -> bytes:
    """Định dạng một số PDF (thang 0..1) thành bytes gọn, hợp lệ.

    Dùng để ghi lại toán hạng màu sau biến đổi: cắt số 0 thừa ở đuôi phần thập
    phân và dấu chấm thừa ("0.500000" → "0.5", "1.000000" → "1", "0.000000" →
    "0") để giữ content stream gọn mà vẫn là số PDF hợp lệ. Giá trị được kẹp về
    [0, 1] trước khi định dạng (toán hạng ``k``/``K``/``scn`` DeviceCMYK là 0..1).
    """
    v = min(1.0, max(0.0, float(value)))
    if v <= 0.0:
        return b"0"
    if v >= 1.0:
        return b"1"
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    if not s or s == "-0":
        s = "0"
    return s.encode("ascii")


class ContentStreamTransformer:
    """Quét byte-level content stream + theo dõi color space hiện hành.

    Khởi tạo với một ``ColorMapper`` (để task 6.2 dùng khi biến đổi) và optional
    ``cs_resources`` = ``/Resources/ColorSpace`` của trang (pikepdf Dictionary
    hoặc dict thuần) để phân giải các named color space tham chiếu bởi ``cs``/
    ``CS``. ``spot_handling`` ("skip"|"convert") được lưu sẵn cho hook 6.2.

    Bất biến scanner (Req 5.2): nội dung bên trong string literal ``( )``, hex
    string ``< >``, comment ``%`` và inline image ``BI…EI`` KHÔNG bao giờ được
    diễn giải như toán tử/toán hạng màu.
    """

    def __init__(self, mapper: "ColorMapper | None" = None,
                 cs_resources=None, spot_handling: str = "skip",
                 hidden_ocgs: "frozenset | set | None" = None,
                 properties_resources=None,
                 process_hidden_layers: bool = False):
        self.mapper = mapper
        self.cs_resources = cs_resources
        self.spot_handling = spot_handling
        # Cache phân loại theo tên color space để tránh phân giải lặp.
        self._cs_cache: dict[str, str] = {}

        # --- OCG (Optional Content Group) ẩn — Req 12 -----------------------
        # ``hidden_ocgs``: tập objgen ``(num, gen)`` của các OCG đang ở trạng thái
        #   OFF (ẩn) theo cấu hình mặc định ``/OCProperties/D/OFF`` của catalog.
        # ``properties_resources``: ``/Resources/Properties`` của container hiện
        #   hành — dùng để phân giải tên trong ``/OC /Name BDC`` về OCG/OCMD.
        # ``process_hidden_layers``: khi False (mặc định) KHÔNG biến đổi màu của
        #   nội dung nằm trong marked-content ``/OC … BDC … EMC`` bị gate bởi một
        #   OCG ẩn (giữ nguyên nội dung layer ẩn — Req 12.2); khi True áp gỡ kênh
        #   bình thường cho cả layer ẩn (Req 12.3).
        self.hidden_ocgs = hidden_ocgs or frozenset()
        self.properties_resources = properties_resources
        self.process_hidden_layers = bool(process_hidden_layers)
        # Cache kết quả phân giải tên Properties → ẩn/không ẩn.
        self._oc_cache: dict[str, bool] = {}

    # -- Phân giải / phân loại color space ----------------------------------

    @staticmethod
    def _as_name(obj) -> str | None:
        """Trả tên dạng ``"/Xxx"`` nếu ``obj`` là một Name (str/bytes/pikepdf.Name)."""
        if obj is None:
            return None
        if isinstance(obj, str):
            return obj if obj.startswith("/") else "/" + obj
        if isinstance(obj, bytes):
            s = obj.decode("latin-1")
            return s if s.startswith("/") else "/" + s
        # pikepdf.Name: str(obj) -> "/DeviceCMYK"; loại trừ Array/Dictionary.
        type_name = type(obj).__name__
        if type_name == "Name":
            return str(obj)
        return None

    @staticmethod
    def _as_array(obj) -> list | None:
        """Trả danh sách phần tử nếu ``obj`` là Array (list/tuple/pikepdf.Array)."""
        if isinstance(obj, (str, bytes, bytearray)):
            return None
        if isinstance(obj, (list, tuple)):
            return list(obj)
        type_name = type(obj).__name__
        if type_name == "Array":
            try:
                return list(obj)
            except Exception:
                return None
        return None

    def _lookup_resource(self, name: str):
        """Tra cứu một named color space trong ``cs_resources`` theo tên."""
        res = self.cs_resources
        if res is None:
            return None
        bare = name.lstrip("/")
        for key in (name, bare, "/" + bare):
            try:
                if hasattr(res, "get"):
                    val = res.get(key)
                    if val is not None:
                        return val
            except Exception:
                pass
            try:
                if key in res:
                    return res[key]
            except Exception:
                pass
        return None

    @staticmethod
    def _icc_components(stream_obj) -> int | None:
        """Đọc ``/N`` (số kênh) từ stream ICCBased; trả None nếu không xác định."""
        for getter in (
            lambda o: o.get("/N"),
            lambda o: o["/N"],
            lambda o: o.stream_dict.get("/N"),  # một số phiên bản pikepdf
        ):
            try:
                value = getter(stream_obj)
                if value is not None:
                    return int(value)
            except Exception:
                continue
        return None

    def _classify_value(self, cs_value, _depth: int = 0) -> str:
        """Phân loại một giá trị color space (Name hoặc Array) thành ColorSpaceKind."""
        if cs_value is None or _depth > 8:
            return ColorSpaceKind.UNKNOWN

        # --- Name: device trực tiếp hoặc tham chiếu tới resource ---
        name = self._as_name(cs_value)
        if name is not None:
            if name in _DEVICE_CS_NAMES:
                return _DEVICE_CS_NAMES[name]
            resolved = self._lookup_resource(name)
            if resolved is not None and resolved is not cs_value:
                return self._classify_value(resolved, _depth + 1)
            return ColorSpaceKind.UNKNOWN

        # --- Array: [/Family ...] ---
        items = self._as_array(cs_value)
        if items:
            family = self._as_name(items[0])
            if family == "/ICCBased":
                n = self._icc_components(items[1]) if len(items) > 1 else None
                if n == 4:
                    return ColorSpaceKind.CMYK
                if n == 3:
                    return ColorSpaceKind.RGB
                if n == 1:
                    return ColorSpaceKind.GRAY
                return ColorSpaceKind.UNKNOWN
            if family == "/Separation":
                return ColorSpaceKind.SEPARATION
            if family == "/DeviceN":
                return ColorSpaceKind.DEVICEN
            if family == "/Indexed":
                return ColorSpaceKind.INDEXED
            if family in ("/CalRGB",):
                return ColorSpaceKind.RGB
            if family in ("/CalGray",):
                return ColorSpaceKind.GRAY
            if family == "/Lab":
                return ColorSpaceKind.LAB
            if family == "/Pattern":
                return ColorSpaceKind.PATTERN
            if family in _DEVICE_CS_NAMES:
                return _DEVICE_CS_NAMES[family]

        return ColorSpaceKind.UNKNOWN

    def _classify_cs_name(self, name: str) -> str:
        """Phân loại color space cho toán hạng /Name của ``cs``/``CS`` (có cache)."""
        if name in self._cs_cache:
            return self._cs_cache[name]
        kind = self._classify_value(name)
        self._cs_cache[name] = kind
        return kind

    # -- Phân giải OCG ẩn cho marked content /OC … BDC (Req 12) -------------

    def _lookup_property(self, name: str):
        """Tra cứu một entry trong ``/Resources/Properties`` theo tên ``/Name``."""
        res = self.properties_resources
        if res is None:
            return None
        bare = name.lstrip("/")
        for key in (name, bare, "/" + bare):
            try:
                if hasattr(res, "get"):
                    val = res.get(key)
                    if val is not None:
                        return val
            except Exception:
                pass
            try:
                if key in res:
                    return res[key]
            except Exception:
                pass
        return None

    def _property_hidden(self, prop_name: str) -> bool:
        """True nếu ``/OC <prop_name>`` trỏ tới một OCG/OCMD đang ở trạng thái ẩn.

        Phân giải ``prop_name`` (vd ``"/MC0"``) qua ``/Resources/Properties`` thành
        đối tượng OCG (hoặc OCMD), rồi đối chiếu với ``self.hidden_ocgs`` (tập
        objgen của các OCG OFF). Kết quả được cache theo tên để tránh phân giải lặp.
        """
        if not self.hidden_ocgs or self.properties_resources is None:
            return False
        if prop_name in self._oc_cache:
            return self._oc_cache[prop_name]
        obj = self._lookup_property(prop_name)
        hidden = _oc_object_hidden(obj, self.hidden_ocgs) if obj is not None else False
        self._oc_cache[prop_name] = hidden
        return hidden

    # -- Hook biến đổi màu (ĐIỂM MỞ RỘNG cho TASK 6.2) ----------------------

    def _handle_color_operator(self, *, operator: bytes, is_stroke: bool,
                               cs_kind: str,
                               operands: list[tuple[float, int, int]],
                               edits: list[tuple[int, int, bytes]],
                               hits: list[ColorHit]) -> None:
        """HOOK — điểm mở rộng cho TASK 6.2 (biến đổi toán hạng màu CMYK tại chỗ).

        Scanner gọi hook này mỗi khi gặp một toán tử đặt màu cần xem xét:
          - ``k``/``K`` (DeviceCMYK fill/stroke): ``cs_kind`` luôn là
            ``ColorSpaceKind.CMYK``; ``operands`` là 4 toán hạng số (0..1) ngay
            trước operator.
          - ``sc``/``scn``/``SC``/``SCN``: ``cs_kind`` là color space hiện hành đã
            phân giải (DeviceCMYK/ICCBased-4 → ``CMYK``; Separation → ``SEPARATION``;
            v.v.); ``operands`` là các toán hạng số (Pattern có thêm /Name nhưng
            /Name không nằm trong ``operands``).

        Tham số:
          - ``operator``: bytes toán tử (vd ``b"k"``, ``b"scn"``).
          - ``is_stroke``: True nếu là biến thể nét (chữ hoa).
          - ``cs_kind``: ``ColorSpaceKind`` hiện hành cho toán tử này.
          - ``operands``: ``list[(value, start, end)]`` — mỗi toán hạng số kèm
            khoảng byte ``[start, end)`` trong content stream gốc, để 6.2 thay thế
            CHÍNH XÁC khoảng byte (Req 5.5).
          - ``edits``: 6.2 thêm ``(start, end, replacement_bytes)`` cho mỗi khoảng
            byte cần thay; scanner sẽ ráp lại theo các edit này.
          - ``hits``: 6.2 thêm ``ColorHit`` thu thập để tổng hợp report.

        TASK 6.1: hook là no-op (chưa biến đổi). KHÔNG thêm logic map_color ở đây
        — đó là phạm vi task 6.2.
        """
        # Không có mapper → không biến đổi gì (giữ nguyên content stream).
        if self.mapper is None:
            return

        # --- Spot color: Separation / DeviceN xử lý theo spot_handling (Req 7.2, 7.3) ---
        if cs_kind in (ColorSpaceKind.SEPARATION, ColorSpaceKind.DEVICEN):
            # "skip": giữ nguyên mọi toán tử/color space spot (KHÔNG tạo edit) —
            # Req 7.2.
            #
            # "convert": ĐIỂM MỞ RỘNG (Req 7.3). Chuyển Spot_Color sang CMYK trước
            # khi gỡ kênh đòi hỏi đánh giá tint transform function của alternate
            # color space (chưa được scanner phân giải ở tầng này). Để TUYỆT ĐỐI
            # không làm hỏng toán hạng spot khi chưa có phép chuyển đổi đáng tin,
            # ta giữ nguyên (no-op) — hành vi an toàn này được kiểm thử ở 6.5/6.6.
            return

        # --- Chỉ biến đổi DeviceCMYK / ICCBased N=4 với ĐÚNG 4 toán hạng số ---
        if cs_kind != ColorSpaceKind.CMYK:
            return
        if len(operands) != 4:
            return

        # Toán hạng PDF là 0..1 → quy về 0..100 (%) cho ColorMapper (Req 5.3, 5.4).
        source_cmyk = tuple(value * 100.0 for value, _s, _e in operands)
        result_cmyk, delta_e, out_of_gamut = self.mapper.map_color(source_cmyk)

        # Quy ngược 0..100 → 0..1 và thay CHÍNH XÁC từng khoảng byte toán hạng
        # (Req 5.5: không đụng byte ngoài khoảng toán hạng).
        for (value, start, end), mapped in zip(operands, result_cmyk):
            edits.append((start, end, _format_pdf_number(mapped / 100.0)))

        # Thu thập ColorHit (thang 0..100) để tổng hợp report (Req 4.1).
        hits.append(ColorHit(
            source_cmyk=source_cmyk,  # type: ignore[arg-type]
            result_cmyk=result_cmyk,
            delta_e=delta_e,
            out_of_gamut=out_of_gamut,
        ))
        return

    # -- Vòng quét chính -----------------------------------------------------

    def transform(self, data: bytes) -> tuple[bytes, list[ColorHit]]:
        """Quét content stream byte-level; trả ``(bytes_kết_quả, list[ColorHit])``.

        Vòng quét an toàn (Req 5.1, 5.2) bỏ qua string literal, hex string, dict,
        comment và inline image; theo dõi color space fill/stroke hiện hành qua
        ``cs``/``CS`` (+ ``k``/``g``/``rg`` và biến thể nét) với stack ``q``/``Q``.
        Mỗi toán tử đặt màu được chuyển tới ``_handle_color_operator`` (hook 6.2).

        Ở task 6.1 hook không tạo edit nào nên kết quả bằng ``data`` nguyên vẹn.
        """
        n = len(data)
        i = 0

        # Toán hạng số tích luỹ kèm khoảng byte: list[(value, start, end)].
        num_operands: list[tuple[float, int, int]] = []
        # Toán hạng /Name gần nhất (cho cs/CS): list[str].
        name_operands: list[str] = []

        # Color space hiện hành cho fill (nonstroking) và stroke (stroking).
        # Mặc định DeviceGray theo PDF spec khi chưa đặt tường minh.
        fill_cs = ColorSpaceKind.GRAY
        stroke_cs = ColorSpaceKind.GRAY

        gstack: list[tuple[str, str]] = []
        edits: list[tuple[int, int, bytes]] = []
        hits: list[ColorHit] = []

        # --- Marked content / OCG ẩn (Req 12) ---
        # ``mc_stack`` lưu cờ "ẩn" cho mỗi BDC/BMC đang mở; ``hidden_depth`` đếm số
        # marked-content ẩn đang lồng nhau. Khi ``hidden_depth > 0`` và KHÔNG bật
        # ``process_hidden_layers``, mọi toán tử màu bị bỏ qua (giữ nguyên nội dung
        # layer ẩn — Req 12.2).
        mc_stack: list[bool] = []
        hidden_depth = 0

        def reset_operands() -> None:
            num_operands.clear()
            name_operands.clear()

        while i < n:
            c = data[i:i + 1]

            if c in _WS:
                i += 1
                continue

            if c == b"%":  # comment → bỏ qua tới hết dòng (Req 5.2)
                while i < n and data[i:i + 1] not in (b"\r", b"\n"):
                    i += 1
                continue

            if c == b"(":  # literal string → bỏ qua, cân bằng ngoặc + escape
                depth = 1
                i += 1
                while i < n and depth > 0:
                    ch = data[i:i + 1]
                    if ch == b"\\":
                        i += 2
                        continue
                    if ch == b"(":
                        depth += 1
                    elif ch == b")":
                        depth -= 1
                    i += 1
                reset_operands()
                continue

            if c == b"<":
                if data[i + 1:i + 2] == b"<":  # dict mở
                    i += 2
                else:                          # hex string → bỏ qua tới '>'
                    i += 1
                    while i < n and data[i:i + 1] != b">":
                        i += 1
                    i += 1
                reset_operands()
                continue

            if c == b">":
                i += 2 if data[i + 1:i + 2] == b">" else 1
                continue

            if c in b"[]{}":
                i += 1
                continue

            if c == b"/":  # /Name toán hạng — ghi lại để phục vụ cs/CS
                start = i
                i += 1
                while (i < n and data[i:i + 1] not in _WS
                       and data[i:i + 1] not in _DELIM):
                    i += 1
                name_operands.append(data[start:i].decode("latin-1"))
                continue

            # token thường: số hoặc toán tử
            start = i
            while (i < n and data[i:i + 1] not in _WS
                   and data[i:i + 1] not in _DELIM):
                i += 1
            tok = data[start:i]

            # số? → tích luỹ kèm khoảng byte [start, i)
            try:
                value = float(tok)
                num_operands.append((value, start, i))
                continue
            except ValueError:
                pass

            op = tok

            # Có đang ở trong marked-content layer ẩn và KHÔNG cho phép xử lý
            # layer ẩn? → bỏ qua biến đổi màu (giữ nguyên byte) cho mọi toán tử
            # màu trong phạm vi này (Req 12.2). Vẫn theo dõi color space bình
            # thường để trạng thái sau khi thoát layer ẩn vẫn chính xác.
            suppress = (hidden_depth > 0) and (not self.process_hidden_layers)

            if op == b"BI":  # inline image — nhảy tới 'EI' (whitespace bao quanh)
                j = i
                while j < n - 1:
                    if (data[j:j + 1] == b"E" and data[j + 1:j + 2] == b"I"
                            and (j == 0 or data[j - 1:j] in _WS)
                            and (j + 2 >= n or data[j + 2:j + 3] in _WS)):
                        j += 2
                        break
                    j += 1
                i = j
                reset_operands()
                continue

            if op == b"q":
                gstack.append((fill_cs, stroke_cs))
            elif op == b"Q":
                if gstack:
                    fill_cs, stroke_cs = gstack.pop()
            elif op == b"BDC":
                # Marked content có thuộc tính: kiểm tra dạng ``/OC /Name BDC``.
                # Dạng ``/OC << …inline dict… >> BDC`` KHÔNG được phát hiện ở đây
                # vì scanner bỏ qua nội dung dict (reset toán hạng) — đây là giả
                # định đơn giản hoá: chỉ OCG tham chiếu qua /Resources/Properties
                # mới được gate (xem docstring lớp). Mặc định coi như không ẩn.
                is_hidden = (
                    len(name_operands) >= 2
                    and name_operands[-2] == "/OC"
                    and self._property_hidden(name_operands[-1])
                )
                mc_stack.append(is_hidden)
                if is_hidden:
                    hidden_depth += 1
            elif op == b"BMC":
                # Marked content không thuộc tính → không bao giờ là /OC ẩn.
                mc_stack.append(False)
            elif op == b"EMC":
                if mc_stack and mc_stack.pop():
                    hidden_depth -= 1
            elif op == _CS_FILL_OP:  # 'cs' — đặt fill color space
                if name_operands:
                    fill_cs = self._classify_cs_name(name_operands[-1])
            elif op == _CS_STROKE_OP:  # 'CS' — đặt stroke color space
                if name_operands:
                    stroke_cs = self._classify_cs_name(name_operands[-1])
            elif op in _DEVICE_FILL_OPS:  # k/g/rg — đặt màu device + color space
                fill_cs = _DEVICE_FILL_OPS[op]
                if op == b"k" and not suppress:
                    self._handle_color_operator(
                        operator=op, is_stroke=False, cs_kind=ColorSpaceKind.CMYK,
                        operands=list(num_operands), edits=edits, hits=hits,
                    )
            elif op in _DEVICE_STROKE_OPS:  # K/G/RG — đặt màu device + color space
                stroke_cs = _DEVICE_STROKE_OPS[op]
                if op == b"K" and not suppress:
                    self._handle_color_operator(
                        operator=op, is_stroke=True, cs_kind=ColorSpaceKind.CMYK,
                        operands=list(num_operands), edits=edits, hits=hits,
                    )
            elif op in _SCN_FILL_OPS:  # sc/scn — đặt màu theo fill color space
                if not suppress:
                    self._handle_color_operator(
                        operator=op, is_stroke=False, cs_kind=fill_cs,
                        operands=list(num_operands), edits=edits, hits=hits,
                    )
            elif op in _SCN_STROKE_OPS:  # SC/SCN — đặt màu theo stroke color space
                if not suppress:
                    self._handle_color_operator(
                        operator=op, is_stroke=True, cs_kind=stroke_cs,
                        operands=list(num_operands), edits=edits, hits=hits,
                    )

            reset_operands()

        if not edits:
            return data, hits

        # Ráp lại content stream theo các edit (start, end, bytes) không chồng lấn.
        edits.sort(key=lambda e: e[0])
        out = bytearray()
        prev = 0
        for s, e, replacement in edits:
            out += data[prev:s]
            out += replacement
            prev = e
        out += data[prev:]
        return bytes(out), hits


def transform_content_stream(data: bytes, mapper: "ColorMapper | None" = None,
                             cs_resources=None, spot_handling: str = "skip"
                             ) -> tuple[bytes, list[ColorHit]]:
    """Tiện ích: dựng ``ContentStreamTransformer`` và quét một content stream.

    Trả ``(bytes_kết_quả, list[ColorHit])``. Ở task 6.1 (chưa có biến đổi toán
    hạng) kết quả bytes bằng ``data`` nguyên vẹn; danh sách ColorHit rỗng.
    """
    transformer = ContentStreamTransformer(
        mapper=mapper, cs_resources=cs_resources, spot_handling=spot_handling
    )
    return transformer.transform(data)


# ---------------------------------------------------------------------------
# ImageXObjectTransformer — ảnh CMYK FlateDecode (Req 6.1, 6.2, 6.3)
# ---------------------------------------------------------------------------
#
# Biến đổi pixel của các CMYK_Image_XObject:
#   - CHỈ xử lý bộ lọc FlateDecode + color space DeviceCMYK hoặc ICCBased N=4
#     (Req 6.1). Decode pixel → numpy (H, W, 4) → áp ``ColorMapper.map_color``
#     (vector hoá theo MÀU DUY NHẤT để tránh map lặp cùng một màu) → encode lại
#     FlateDecode, GIỮ NGUYÊN Width/Height/4 kênh/filter (Req 6.2).
#   - Ảnh DCTDecode (JPEG-CMYK) → KHÔNG sửa, trả None + ghi cảnh báo (Req 6.3).
#   - Các ảnh khác (không phải CMYK 4 kênh, BitsPerComponent ≠ 8, ImageMask,
#     kích thước byte không khớp...) → bỏ qua an toàn (trả None, không cảnh báo).
#
# Quy ước thang đo (khớp ReSeparationEngine.to_lab / ColorMapper):
#   - Mẫu ảnh DeviceCMYK 8-bit: byte 0..255 ↔ phủ mực 0..100 % (Decode mặc định
#     [0 1 …]); chuyển ``percent = byte / 255 * 100`` khi đọc và
#     ``byte = round(percent / 100 * 255)`` khi ghi.

#: Thông điệp cảnh báo khi gặp ảnh JPEG-CMYK (DCTDecode) — Req 6.3.
DCT_WARNING_TEMPLATE: str = (
    "Ảnh JPEG-CMYK (DCTDecode) '{name}' chưa được xử lý ở phiên bản hiện tại "
    "và được giữ nguyên."
)


def _filter_names(filter_obj) -> tuple[str, ...]:
    """Chuẩn hoá ``/Filter`` của một image XObject thành tuple tên ('/FlateDecode'…).

    ``/Filter`` có thể là một Name đơn (``/FlateDecode``) hoặc một Array nhiều
    bộ lọc (``[/FlateDecode]``). Trả tuple chuỗi tên để kiểm tra membership.
    """
    if filter_obj is None:
        return ()
    import pikepdf

    if isinstance(filter_obj, pikepdf.Array):
        return tuple(str(f) for f in filter_obj)
    return (str(filter_obj),)


def _is_cmyk_4channel_colorspace(colorspace) -> bool:
    """True nếu color space là DeviceCMYK hoặc ICCBased với N=4 (Req 6.1).

    Hỗ trợ hai dạng:
      - Name đơn ``/DeviceCMYK``.
      - Array ``[/ICCBased <stream>]`` với stream có ``/N == 4``; hoặc
        ``[/DeviceCMYK]``.
    Các color space khác (DeviceRGB, DeviceGray, Indexed, Separation, DeviceN,
    ICCBased N≠4...) trả False → ảnh bị bỏ qua.
    """
    if colorspace is None:
        return False
    import pikepdf

    if isinstance(colorspace, pikepdf.Array):
        if len(colorspace) == 0:
            return False
        head = str(colorspace[0])
        if head == "/DeviceCMYK":
            return True
        if head == "/ICCBased" and len(colorspace) >= 2:
            try:
                icc_stream = colorspace[1]
                n = icc_stream.get("/N")
                return n is not None and int(n) == 4
            except Exception:  # noqa: BLE001 - color space dị dạng → coi như không hỗ trợ
                return False
        return False

    return str(colorspace) == "/DeviceCMYK"


class ImageXObjectTransformer:
    """Biến đổi màu pixel của các CMYK_Image_XObject FlateDecode (Req 6).

    Dùng chung một ``ColorMapper`` với ContentStreamTransformer để bảo đảm vector
    và ảnh áp cùng một phép biến đổi (cùng mode, cùng LUT re-separation). Cảnh báo
    (JPEG-CMYK chưa hỗ trợ) tích luỹ vào ``self.warnings`` để tầng điều phối
    ``remove_channels`` gộp vào ``ChannelRemovalReport.warnings``.

    Cách dùng::

        transformer = ImageXObjectTransformer(mapper)
        hit = transformer.transform("/Im0", xobj)   # xobj: pikepdf image stream
        # hit is None nếu ảnh bị bỏ qua (không CMYK / DCTDecode / không hỗ trợ)
    """

    def __init__(self, mapper: ColorMapper):
        self.mapper = mapper
        #: Cảnh báo phát sinh khi xử lý ảnh (ví dụ JPEG-CMYK bị bỏ qua) — Req 6.3.
        self.warnings: list[str] = []

    # -- Phân loại ảnh ------------------------------------------------------

    def _should_transform(self, xobj) -> bool:
        """Kiểm tra ảnh có thuộc diện xử lý (FlateDecode + CMYK 4 kênh 8-bit) không.

        Trả False cho ảnh không phải image XObject, ImageMask, BitsPerComponent
        ≠ 8, color space không phải CMYK 4 kênh, hoặc không dùng FlateDecode.
        Riêng DCTDecode được xử lý ở ``transform`` (cảnh báo) nên không loại ở đây.
        """
        try:
            if str(xobj.get("/Subtype")) != "/Image":
                return False
            if bool(xobj.get("/ImageMask", False)):
                return False
            bpc = xobj.get("/BitsPerComponent")
            if bpc is None or int(bpc) != 8:
                return False
            if not _is_cmyk_4channel_colorspace(xobj.get("/ColorSpace")):
                return False
        except Exception:  # noqa: BLE001 - đối tượng dị dạng → bỏ qua an toàn
            return False
        return True

    # -- Map pixel ----------------------------------------------------------

    def _map_pixels(self, arr):
        """Áp ``ColorMapper.map_color`` cho mọi pixel của mảng (H, W, 4) uint8.

        Vector hoá theo MÀU DUY NHẤT: gom các pixel trùng màu, map mỗi màu duy
        nhất đúng một lần rồi phát tán kết quả về toàn ảnh. Trả
        ``(out_arr, max_delta_e, out_of_gamut_pixels, pixels)``.
        """
        import numpy as np

        h, w, _ = arr.shape
        flat = arr.reshape(-1, 4)
        pixels = int(flat.shape[0])

        # Tập màu duy nhất + ánh xạ ngược về từng pixel.
        uniq, inverse = np.unique(flat, axis=0, return_inverse=True)

        out_uniq = np.empty_like(uniq)
        deltas = np.zeros(len(uniq), dtype=np.float64)
        oog = np.zeros(len(uniq), dtype=bool)

        scale_up = 100.0 / 255.0
        for i in range(len(uniq)):
            c, m, y, k = (int(v) for v in uniq[i])
            cmyk100 = (c * scale_up, m * scale_up, y * scale_up, k * scale_up)
            result, delta_e, is_oog = self.mapper.map_color(cmyk100)
            out_uniq[i] = [
                int(round(min(100.0, max(0.0, v)) / 100.0 * 255.0)) for v in result
            ]
            deltas[i] = delta_e
            oog[i] = is_oog

        out_flat = out_uniq[inverse]
        out_arr = out_flat.reshape(h, w, 4)

        # Thống kê có trọng số theo số pixel của mỗi màu duy nhất.
        counts = np.bincount(inverse, minlength=len(uniq))
        max_delta_e = float(deltas.max()) if len(deltas) else 0.0
        out_of_gamut_pixels = int(counts[oog].sum()) if oog.any() else 0

        return out_arr, max_delta_e, out_of_gamut_pixels, pixels

    # -- Điểm vào -----------------------------------------------------------

    def transform(self, xobj_name: str, xobj) -> "ImageHit | None":
        """Biến đổi một image XObject CMYK FlateDecode tại chỗ (Req 6.1, 6.2, 6.3).

        - DCTDecode (JPEG-CMYK) với color space CMYK 4 kênh → KHÔNG sửa, ghi
          cảnh báo và trả None (Req 6.3).
        - FlateDecode + DeviceCMYK/ICCBased-4, 8-bit → decode → map pixel →
          encode lại FlateDecode giữ nguyên Width/Height/4 kênh/filter; trả
          ``ImageHit`` (Req 6.1, 6.2).
        - Mọi trường hợp khác → trả None (bỏ qua an toàn).
        """
        import numpy as np

        # Chỉ quan tâm tới ảnh CMYK 4 kênh; ảnh khác bỏ qua hoàn toàn.
        try:
            is_cmyk = _is_cmyk_4channel_colorspace(xobj.get("/ColorSpace"))
        except Exception:  # noqa: BLE001
            return None
        if not is_cmyk:
            return None

        filters = _filter_names(xobj.get("/Filter"))

        # --- DCTDecode (JPEG-CMYK): bỏ qua + cảnh báo (Req 6.3) ---
        if "/DCTDecode" in filters:
            self.warnings.append(DCT_WARNING_TEMPLATE.format(name=xobj_name))
            return None

        if not self._should_transform(xobj):
            return None
        if "/FlateDecode" not in filters:
            return None

        try:
            width = int(xobj.get("/Width"))
            height = int(xobj.get("/Height"))
        except Exception:  # noqa: BLE001
            return None
        if width <= 0 or height <= 0:
            return None

        # Decode pixel (đã áp predictor/filter) → numpy (H, W, 4).
        try:
            raw = bytes(xobj.read_bytes())
        except Exception:  # noqa: BLE001 - không decode được → giữ nguyên ảnh
            return None

        expected = width * height * 4
        if len(raw) != expected:
            # Kích thước không khớp (predictor lạ, sub-sampling...) → bỏ qua an toàn.
            return None

        arr = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 4))
        out_arr, max_delta_e, out_of_gamut_pixels, pixels = self._map_pixels(arr)

        # Encode lại FlateDecode, GIỮ NGUYÊN Width/Height/4 kênh/filter (Req 6.2).
        import pikepdf
        import zlib

        out_bytes = np.ascontiguousarray(out_arr, dtype=np.uint8).tobytes()
        compressed = zlib.compress(out_bytes)
        xobj.write(
            compressed,
            filter=pikepdf.Name("/FlateDecode"),
            decode_parms=None,
        )

        return ImageHit(
            xobj_name=xobj_name,
            pixels=pixels,
            max_delta_e=max_delta_e,
            out_of_gamut_pixels=out_of_gamut_pixels,
        )


# ---------------------------------------------------------------------------
# Chữ ký hàm (cài đặt đầy đủ ở các task sau)
# ---------------------------------------------------------------------------

#: Các chế độ gỡ kênh hợp lệ.
VALID_MODES: tuple[str, str] = ("direct", "reseparate")

#: Các lựa chọn xử lý màu pha hợp lệ.
VALID_SPOT_HANDLING: tuple[str, str] = ("skip", "convert")

#: Chế độ mặc định khi params không nêu rõ.
DEFAULT_MODE: str = "reseparate"

#: Tập hợp tên kênh hợp lệ (chuẩn hoá chữ hoa).
_VALID_CHANNELS: frozenset[str] = frozenset(PROCESS_CHANNELS)


def _parse_kept_channels(raw) -> tuple[str, ...]:
    """Chuẩn hoá đầu vào ``kept_channels`` thành tuple kênh hợp lệ, không trùng.

    Chấp nhận list/tuple/set các chuỗi, hoặc một chuỗi phân tách bằng dấu phẩy
    (ví dụ ``"C,M,K"``). Mỗi phần tử được strip + viết hoa và phải thuộc
    {C, M, Y, K}. Thứ tự đầu ra theo ``PROCESS_CHANNELS`` để bảo đảm tính xác định.
    """
    if raw is None:
        raise ValueError("Thiếu tham số 'kept_channels': phải giữ ít nhất một kênh.")

    if isinstance(raw, str):
        items = [tok for tok in raw.replace(";", ",").split(",")]
    elif isinstance(raw, (list, tuple, set, frozenset)):
        items = list(raw)
    else:
        raise ValueError(
            "Tham số 'kept_channels' phải là danh sách kênh (ví dụ ['C','M','K'])."
        )

    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            raise ValueError(
                f"Giá trị kênh không hợp lệ: {item!r} (mỗi kênh phải là chuỗi C/M/Y/K)."
            )
        name = item.strip().upper()
        if not name:
            continue
        if name not in _VALID_CHANNELS:
            raise ValueError(
                f"Kênh không hợp lệ: {item!r}. Chỉ chấp nhận C, M, Y, K."
            )
        seen.add(name)

    # Sắp xếp theo thứ tự process chuẩn để xác định và tái lập được.
    return tuple(ch for ch in PROCESS_CHANNELS if ch in seen)


def _parse_float(raw, name: str, default: float, *, minimum: float | None = None) -> float:
    """Parse một giá trị float từ params với mặc định và ràng buộc tối thiểu."""
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"Tham số '{name}' phải là số: nhận {raw!r}.")
    if minimum is not None and value <= minimum:
        raise ValueError(f"Tham số '{name}' phải lớn hơn {minimum}: nhận {value}.")
    return value


def validate_params(params: dict) -> ChannelRemovalParams:
    """Validate và chuẩn hoá params dict thành ``ChannelRemovalParams``.

    Quy tắc (Req 1, 7.1, 8.1):
      - Giữ cả 4 kênh → từ chối ("không có kênh nào bị gỡ") (Req 1.3).
      - Bỏ cả 4 kênh / kept rỗng → từ chối ("phải giữ ít nhất một kênh") (Req 1.4).
      - kept_channels có 1..3 phần tử → chấp nhận (Req 1.2).
      - Áp mặc định TAC=360, gamut_threshold=5, spot_handling="skip".
    """
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ValueError("Tham số 'params' phải là một dict.")

    # --- kept_channels: kiểm tra tính hợp lệ của tập kênh giữ (Req 1.2, 1.3, 1.4) ---
    kept = _parse_kept_channels(params.get("kept_channels"))
    if len(kept) == 0:
        # Bỏ cả 4 kênh (kept rỗng) — Req 1.4.
        raise ValueError("Phải giữ ít nhất một kênh: không thể bỏ cả bốn kênh process.")
    if len(kept) >= len(PROCESS_CHANNELS):
        # Giữ cả 4 kênh — Req 1.3.
        raise ValueError("Không có kênh nào bị gỡ: vui lòng bỏ ít nhất một kênh.")

    # --- mode (Direct / Re-separation) ---
    raw_mode = params.get("mode")
    mode = DEFAULT_MODE if raw_mode is None else str(raw_mode).strip().lower()
    if mode not in VALID_MODES:
        raise ValueError(
            f"Chế độ không hợp lệ: {raw_mode!r}. Chỉ chấp nhận 'direct' hoặc 'reseparate'."
        )

    # --- spot_handling (Req 7.1) ---
    raw_spot = params.get("spot_handling")
    spot_handling = "skip" if raw_spot is None else str(raw_spot).strip().lower()
    if spot_handling not in VALID_SPOT_HANDLING:
        raise ValueError(
            f"Tùy chọn xử lý màu pha không hợp lệ: {raw_spot!r}. "
            "Chỉ chấp nhận 'skip' hoặc 'convert'."
        )

    # --- các giá trị số: áp mặc định + ràng buộc (Req 8.1) ---
    tac_limit = _parse_float(
        params.get("tac_limit"), "tac_limit", DEFAULT_TAC_LIMIT, minimum=0.0
    )
    gamut_threshold = _parse_float(
        params.get("gamut_threshold"), "gamut_threshold", DEFAULT_GAMUT_THRESHOLD,
        minimum=0.0,
    )
    grid_step = _parse_float(
        params.get("grid_step"), "grid_step", DEFAULT_GRID_STEP, minimum=0.0
    )

    # --- process_hidden_layers (Req 12) ---
    process_hidden_layers = bool(params.get("process_hidden_layers", False))

    return ChannelRemovalParams(
        kept_channels=kept,
        mode=mode,
        tac_limit=tac_limit,
        gamut_threshold=gamut_threshold,
        spot_handling=spot_handling,
        process_hidden_layers=process_hidden_layers,
        grid_step=grid_step,
    )


# ---------------------------------------------------------------------------
# Điều phối remove_channels — validate input + mở/ghi PDF (task 8.1)
# ---------------------------------------------------------------------------
#
# Task 8.1 cài đặt KHUNG điều phối:
#   - Validate params (validate_params) + validate input file (0 byte / PDF hợp lệ).
#   - Mở PDF qua pikepdf; dựng ReSeparationEngine (khi reseparate) + ColorMapper
#     dùng chung cho cả vector & ảnh.
#   - LUÔN ghi ``output_path`` kể cả khi no-op (bản sao hợp lệ) — Req 9.1, 11.5.
#   - Tổng hợp ChannelRemovalReport (tối thiểu); thêm warning "không có kênh nào
#     bị thay đổi" khi không có nội dung CMYK nào bị biến đổi — Req 11.5.
#
# ĐIỂM MỞ RỘNG để các task sau hoàn thiện:
#   - ``_traverse_pages`` (TASK 8.2): duyệt mọi trang + áp ContentStreamTransformer
#     / ImageXObjectTransformer, thu thập ColorHit/ImageHit. Ở 8.1 là no-op an toàn
#     (trả collections rỗng) để output luôn là bản sao hợp lệ.
#   - ``_aggregate_report`` (TASK 8.3 — hoàn thiện): tổng hợp max/avg ΔE,
#     out_of_gamut_count trên toàn bộ ColorHit + đại diện pixel ảnh (ImageHit),
#     cảnh báo OOG, identical_to_original (Req 4.1, 4.2, 4.4).

#: Cảnh báo khi file không chứa nội dung CMYK nào bị thay đổi (Req 11.5).
NO_CMYK_WARNING: str = (
    "Không có kênh nào bị thay đổi: file không chứa nội dung CMYK phù hợp "
    "(vẫn xuất ra bản sao hợp lệ)."
)

#: Cảnh báo khi tồn tại ít nhất một màu thuộc Out_Of_Gamut_Region (Req 4.2).
OOG_WARNING: str = (
    "Tồn tại vùng không thể tái tạo bằng tập kênh giữ (Out_Of_Gamut): "
    "màu kết quả không giống hệt bản gốc."
)

#: Độ sâu đệ quy tối đa khi duyệt Form XObject lồng nhau (guard chống chu trình
#: + bảo vệ stack với các file dị dạng).
_MAX_FORM_DEPTH: int = 32

#: Cảnh báo khi đạt giới hạn độ sâu đệ quy Form XObject.
_FORM_DEPTH_WARNING: str = (
    "Đạt giới hạn độ sâu Form XObject lồng nhau: một số nội dung lồng sâu có thể "
    "chưa được xử lý."
)


def _validate_input_file(input_path: str) -> None:
    """Validate file đầu vào trước khi mở (Req 11.1).

    - File không tồn tại → lỗi rõ ràng.
    - File 0 byte → lỗi "file rỗng".
    Việc kiểm tra PDF có hợp lệ hay không (Req 11.2) do ``pikepdf.open`` đảm nhận
    ở ``remove_channels`` (bắt ngoại lệ và chuyển thành thông báo rõ ràng).
    """
    if not input_path or not os.path.isfile(input_path):
        raise ValueError(f"File đầu vào không tồn tại: {input_path!r}.")
    if os.path.getsize(input_path) == 0:
        raise ValueError("File đầu vào rỗng (0 byte): không có nội dung để xử lý.")


def _build_engine(params: ChannelRemovalParams) -> "ReSeparationEngine | None":
    """Dựng ``ReSeparationEngine`` khi mode = "reseparate" (Req 3.1), None nếu không.

    Engine được dựng một lần ở tầng điều phối và tiêm vào ``ColorMapper`` để LUT
    kênh-giữ được cache và tái dùng giữa vector và ảnh (đảm bảo idempotent).
    Constructor sẽ ném ``FileNotFoundError`` rõ ràng nếu thiếu ICC FOGRA39.
    """
    if params.mode == "reseparate":
        return ReSeparationEngine(
            kept_channels=params.kept_channels, grid_step=params.grid_step
        )
    return None


def _obj_objgen(obj):
    """Trả objgen ``(num, gen)`` của một đối tượng pikepdf gián tiếp, hoặc None."""
    try:
        og = obj.objgen
        # objgen của object trực tiếp là (0, 0) → coi như không định danh được.
        if og and og[0] != 0:
            return og
    except Exception:
        pass
    return None


def _oc_object_hidden(obj, hidden_ocgs) -> bool:
    """True nếu ``obj`` (OCG hoặc OCMD) thuộc tập OCG ẩn ``hidden_ocgs``.

    - OCG: đối chiếu trực tiếp objgen với ``hidden_ocgs``.
    - OCMD (``/Type /OCMD``): coi là ẩn nếu BẤT KỲ OCG thành viên trong ``/OCGs``
      của nó nằm trong ``hidden_ocgs`` (giả định đơn giản hoá: bỏ qua
      ``/VE`` visibility expression và ``/P`` policy — đủ cho trường hợp phổ biến
      một OCMD gói một OCG ẩn). Tài liệu hoá để task 8.3/8.7 cân nhắc mở rộng.
    """
    if not hidden_ocgs or obj is None:
        return False

    og = _obj_objgen(obj)
    if og is not None and og in hidden_ocgs:
        return True

    # OCMD: kiểm tra các OCG thành viên.
    try:
        if str(obj.get("/Type")) == "/OCMD":
            import pikepdf

            ocgs = obj.get("/OCGs")
            if ocgs is not None:
                members = list(ocgs) if isinstance(ocgs, pikepdf.Array) else [ocgs]
                for member in members:
                    mog = _obj_objgen(member)
                    if mog is not None and mog in hidden_ocgs:
                        return True
    except Exception:
        pass
    return False


def _collect_hidden_ocgs(pdf) -> frozenset:
    """Tập objgen của các OCG đang ẩn theo cấu hình mặc định của catalog (Req 12).

    Đọc ``/Root/OCProperties/D/OFF`` — danh sách các OCG bị tắt (ẩn) trong cấu
    hình hiển thị mặc định ``/D``. Trả ``frozenset`` các objgen ``(num, gen)``.
    Nếu file không có Optional Content (không OCProperties) → trả tập rỗng.

    Giả định đơn giản hoá (tài liệu cho 8.3/8.7): chỉ xét cấu hình mặc định
    ``/D``; không duyệt các cấu hình thay thế trong ``/Configs``. Trạng thái
    "ẩn" được hiểu là OCG nằm trong ``/OFF``.
    """
    hidden: set = set()
    try:
        root = pdf.Root
        ocprops = root.get("/OCProperties")
        if ocprops is None:
            return frozenset()
        default_cfg = ocprops.get("/D")
        if default_cfg is None:
            return frozenset()
        off = default_cfg.get("/OFF")
        if off is None:
            return frozenset()
        for ref in off:
            og = _obj_objgen(ref)
            if og is not None:
                hidden.add(og)
    except Exception:
        pass
    return frozenset(hidden)


def _res_subdict(resources, key):
    """Lấy một sub-dictionary của ``/Resources`` (vd ``/ColorSpace``) an toàn."""
    if resources is None:
        return None
    try:
        return resources.get(key)
    except Exception:
        return None


def _read_content_bytes(page, pdf):
    """Đọc & nối toàn bộ content stream của trang (đồng bộ ``overprint_black``)."""
    import pikepdf

    contents = page.get("/Contents")
    if contents is None:
        return None
    try:
        if isinstance(contents, pikepdf.Array):
            chunks = []
            for ref in contents:
                try:
                    chunks.append(bytes(ref.read_bytes()))
                except Exception:
                    pass
            return b"\n".join(chunks) if chunks else b""
        return bytes(contents.read_bytes())
    except Exception:
        return None


def _transform_one_content(data: bytes, mapper: "ColorMapper",
                           params: ChannelRemovalParams, resources,
                           hidden_ocgs) -> tuple[bytes, list[ColorHit]]:
    """Áp ``ContentStreamTransformer`` cho một content stream với resources của nó.

    ``resources`` cung cấp ``/ColorSpace`` (phân giải named CS cho scn/SCN) và
    ``/Properties`` (phân giải OCG ẩn cho ``/OC … BDC``). Trả ``(bytes, hits)``.
    """
    cs_resources = _res_subdict(resources, "/ColorSpace")
    properties = _res_subdict(resources, "/Properties")
    transformer = ContentStreamTransformer(
        mapper=mapper,
        cs_resources=cs_resources,
        spot_handling=params.spot_handling,
        hidden_ocgs=hidden_ocgs,
        properties_resources=properties,
        process_hidden_layers=params.process_hidden_layers,
    )
    return transformer.transform(data)


def _process_xobjects(resources, pdf, mapper, params, hidden_ocgs,
                      image_transformer, visited: set, depth: int,
                      color_hits: list, image_hits: list, warnings: list) -> None:
    """Duyệt ``/Resources/XObject``: ảnh CMYK → biến đổi pixel; Form → đệ quy.

    - Image XObject (``/Subtype /Image``): áp ``ImageXObjectTransformer`` (Req 6).
    - Form XObject (``/Subtype /Form``): đệ quy vào content stream + resources
      riêng của form, có guard chống chu trình bằng ``visited`` (objgen) và giới
      hạn ``depth``.
    - OCG gating (Req 12): nếu một XObject có ``/OC`` trỏ tới OCG ẩn và KHÔNG bật
      ``process_hidden_layers``, bỏ qua XObject đó (giữ nguyên nội dung ẩn).
    """
    import pikepdf

    xobjects = _res_subdict(resources, "/XObject")
    if xobjects is None:
        return

    try:
        items = list(xobjects.items())
    except Exception:
        return

    for name, xobj in items:
        # Gate theo /OC của chính XObject (Req 12.2).
        if not params.process_hidden_layers and hidden_ocgs:
            try:
                oc = xobj.get("/OC")
            except Exception:
                oc = None
            if oc is not None and _oc_object_hidden(oc, hidden_ocgs):
                continue

        try:
            subtype = str(xobj.get("/Subtype"))
        except Exception:
            subtype = ""

        if subtype == "/Image":
            try:
                hit = image_transformer.transform(str(name), xobj)
            except Exception as exc:  # noqa: BLE001 - ảnh dị dạng → bỏ qua an toàn
                logger.debug("Bỏ qua image XObject %s: %r", name, exc)
                hit = None
            if hit is not None:
                image_hits.append(hit)
            continue

        if subtype == "/Form":
            og = _obj_objgen(xobj)
            if og is not None:
                if og in visited:
                    continue  # chống chu trình tham chiếu Form ↔ Form
                visited.add(og)
            if depth >= _MAX_FORM_DEPTH:
                warnings.append(_FORM_DEPTH_WARNING)
                continue

            data = None
            try:
                data = bytes(xobj.read_bytes())
            except Exception:
                data = None

            form_res = None
            try:
                form_res = xobj.get("/Resources")
            except Exception:
                form_res = None

            if data is not None:
                new_data, hits = _transform_one_content(
                    data, mapper, params, form_res, hidden_ocgs
                )
                color_hits.extend(hits)
                if new_data != data:
                    try:
                        xobj.write(new_data)
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("Không ghi được Form XObject %s: %r", name, exc)

            # Đệ quy vào XObject lồng trong resources của form.
            _process_xobjects(
                form_res, pdf, mapper, params, hidden_ocgs, image_transformer,
                visited, depth + 1, color_hits, image_hits, warnings,
            )


def _traverse_pages(pdf, mapper: "ColorMapper", params: ChannelRemovalParams
                    ) -> tuple[list[ColorHit], list[ImageHit], list[str]]:
    """Duyệt MỌI trang + áp content/image transformer (TASK 8.2).

    Trả ``(color_hits, image_hits, warnings)`` gom từ toàn bộ trang. Với mỗi trang:
      - Đọc & nối content stream, chạy ``ContentStreamTransformer`` (vector k/K,
        scn/SCN DeviceCMYK) với ``/Resources/ColorSpace`` + ``/Resources/Properties``
        của trang; ghi lại content đã biến đổi (chỉ khi có thay đổi).
      - Duyệt ``/Resources/XObject``: ảnh CMYK FlateDecode → ``ImageXObjectTransformer``;
        Form XObject → đệ quy vào content + resources riêng (guard chu trình).
      - Mọi trang đều được duyệt; trang không có Process_Channel cần biến đổi →
        content giữ nguyên bytewise & trang vẫn xuất hiện trong output (Req 11.3, 11.4).

    OCG ẩn (Req 12): khi ``params.process_hidden_layers`` = False (mặc định), nội
    dung trong marked-content ``/OC … BDC … EMC`` bị gate bởi OCG OFF — và các
    XObject có ``/OC`` ẩn — được GIỮ NGUYÊN (không gỡ kênh). Khi True, áp gỡ kênh
    cho cả layer ẩn như nội dung hiển thị.
    """
    import pikepdf

    color_hits: list[ColorHit] = []
    image_hits: list[ImageHit] = []
    warnings: list[str] = []

    # Tập OCG ẩn theo cấu hình hiển thị mặc định của catalog (Req 12).
    hidden_ocgs = _collect_hidden_ocgs(pdf)

    # ImageXObjectTransformer dùng chung để gom cảnh báo (JPEG-CMYK) một chỗ.
    image_transformer = ImageXObjectTransformer(mapper)

    # Guard chu trình cho Form XObject (objgen đã xử lý) — dùng chung toàn tài liệu.
    visited_forms: set = set()

    for page in pdf.pages:
        resources = None
        try:
            resources = page.get("/Resources")
        except Exception:
            resources = None

        # --- Content stream của trang (vector) ---
        data = _read_content_bytes(page, pdf)
        if data is not None:
            new_data, hits = _transform_one_content(
                data, mapper, params, resources, hidden_ocgs
            )
            color_hits.extend(hits)
            if new_data != data:
                try:
                    page.Contents = pdf.make_stream(new_data)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Không ghi được content trang: %r", exc)

        # --- XObject của trang (ảnh + form lồng nhau) ---
        _process_xobjects(
            resources, pdf, mapper, params, hidden_ocgs, image_transformer,
            visited_forms, 0, color_hits, image_hits, warnings,
        )

    # Gộp cảnh báo từ ImageXObjectTransformer (JPEG-CMYK chưa hỗ trợ — Req 6.3).
    warnings.extend(image_transformer.warnings)
    return color_hits, image_hits, warnings


def _aggregate_report(output_filename: str | None,
                      color_hits: list[ColorHit],
                      image_hits: list[ImageHit],
                      warnings: list[str]) -> ChannelRemovalReport:
    """Tổng hợp ``ChannelRemovalReport`` từ các hit + cảnh báo (TASK 8.3).

    Gộp thống kê ΔE/OOG trên TOÀN BỘ ``ColorHit`` (vector) lẫn ``ImageHit`` (ảnh)
    theo Req 4.1, 4.2, 4.4:

      - ``max_delta_e`` = ΔE lớn nhất trên cả ColorHit.delta_e VÀ
        ImageHit.max_delta_e (Req 4.1).
      - ``avg_delta_e`` = trung bình cộng của tập đại diện ΔE gồm: mỗi ColorHit
        đóng góp ``delta_e`` của nó, và mỗi ImageHit đóng góp ``max_delta_e`` như
        MỘT đại diện pixel ảnh (Req 4.1; "đại diện pixel ảnh" trong design.md).
        Chọn cách "một đại diện / ảnh" thay vì trọng số theo số pixel vì ImageHit
        chỉ lưu ΔE lớn nhất (worst-case) của ảnh — không lưu tổng/tb ΔE per-pixel
        — nên đây là số liệu trung thực, xác định và nhất quán với ``total_colors``.
      - ``out_of_gamut_count`` = số ColorHit có ``out_of_gamut=True`` CỘNG tổng
        ``ImageHit.out_of_gamut_pixels`` (đếm theo pixel cho ảnh) (Req 3.4, 4.2).
      - Khi ``out_of_gamut_count > 0`` → thêm cảnh báo OOG (Req 4.2) và
        ``identical_to_original = False`` (Req 4.4).
      - ``total_colors`` = số đại diện màu đã xử lý = ``len(color_hits) +
        len(image_hits)`` (mỗi ảnh tính một đại diện), khớp đúng mẫu số của
        ``avg_delta_e`` để hai số liệu nhất quán.
      - Nếu KHÔNG có nội dung CMYK nào bị biến đổi (không ColorHit lẫn ImageHit) →
        thêm ``NO_CMYK_WARNING`` (Req 11.5).
    """
    # Tập đại diện ΔE: ColorHit.delta_e + ImageHit.max_delta_e (1 đại diện / ảnh).
    color_deltas = [hit.delta_e for hit in color_hits]
    image_deltas = [hit.max_delta_e for hit in image_hits]
    deltas = color_deltas + image_deltas

    # OOG: ColorHit out_of_gamut + tổng pixel OOG của ảnh (Req 3.4, 4.2).
    out_of_gamut_count = (
        sum(1 for hit in color_hits if hit.out_of_gamut)
        + sum(hit.out_of_gamut_pixels for hit in image_hits)
    )

    # Số đại diện màu đã xử lý — khớp mẫu số của avg_delta_e.
    total_colors = len(color_hits) + len(image_hits)

    max_delta_e = max(deltas) if deltas else 0.0
    avg_delta_e = (sum(deltas) / len(deltas)) if deltas else 0.0

    merged_warnings = list(warnings)
    if out_of_gamut_count > 0 and OOG_WARNING not in merged_warnings:
        merged_warnings.append(OOG_WARNING)

    # Không có nội dung CMYK nào bị thay đổi → cảnh báo no-op (Req 11.5).
    if not color_hits and not image_hits and NO_CMYK_WARNING not in merged_warnings:
        merged_warnings.append(NO_CMYK_WARNING)

    return ChannelRemovalReport(
        output_filename=output_filename,
        max_delta_e=max_delta_e,
        avg_delta_e=avg_delta_e,
        out_of_gamut_count=out_of_gamut_count,
        total_colors=total_colors,
        warnings=merged_warnings,
        identical_to_original=(out_of_gamut_count == 0),
    )


def remove_channels(input_path: str, output_path: str,
                    params: dict) -> ChannelRemovalReport:
    """Điểm vào chính: gỡ kênh process khỏi PDF, ghi kết quả ra ``output_path``.

    Điều phối (Req 9, 11):
      1. ``validate_params`` — chuẩn hoá tham số + kiểm tra tập kênh giữ (Req 1).
      2. ``_validate_input_file`` — file tồn tại & không rỗng 0 byte (Req 11.1).
      3. ``pikepdf.open`` — mở PDF; PDF không hợp lệ → lỗi rõ ràng (Req 11.2).
      4. Dựng ``ReSeparationEngine`` (khi reseparate) + ``ColorMapper`` dùng chung.
      5. ``_traverse_pages`` (TASK 8.2) — duyệt trang + áp transformer (8.1: no-op).
      6. ``pdf.save(output_path)`` — LUÔN ghi output kể cả no-op (bản sao hợp lệ).
      7. ``_aggregate_report`` (TASK 8.3) — tổng hợp report; cảnh báo no-op nếu
         không có nội dung CMYK nào bị thay đổi (Req 11.5).

    Trả ``ChannelRemovalReport``. Ném ``ValueError`` cho file rỗng / PDF không hợp
    lệ, hoặc lỗi tham số từ ``validate_params``.
    """
    import pikepdf

    # 1) Validate tham số (Req 1, 7.1, 8.1).
    validated = validate_params(params)

    # 2) Validate file đầu vào (Req 11.1).
    _validate_input_file(input_path)

    # 4) Engine (reseparate) + ColorMapper dùng chung cho vector & ảnh.
    engine = _build_engine(validated)
    mapper = ColorMapper(validated, engine=engine)

    # 3) Mở PDF; PDF không hợp lệ → thông báo rõ ràng (Req 11.2).
    try:
        pdf_ctx = pikepdf.open(input_path)
    except pikepdf.PdfError as exc:
        raise ValueError(f"File đầu vào không phải PDF hợp lệ: {exc}") from exc

    output_filename = os.path.basename(output_path) if output_path else None

    with pdf_ctx as pdf:
        # 5) Duyệt trang + áp transformer (TASK 8.2 sẽ hiện thực; 8.1: no-op).
        color_hits, image_hits, warnings = _traverse_pages(pdf, mapper, validated)

        # 6) LUÔN ghi output_path — kể cả no-op (bản sao hợp lệ) (Req 9.1, 11.5).
        pdf.save(output_path)

    # 7) Tổng hợp report: gộp ΔE/OOG của vector (ColorHit) + ảnh (ImageHit),
    #    cảnh báo OOG/no-op, identical_to_original (TASK 8.3 — Req 4.1, 4.2, 4.4).
    report = _aggregate_report(output_filename, color_hits, image_hits, warnings)

    logger.info(
        "remove_channels: mode=%s kept=%s colors=%d oog=%d -> %s",
        validated.mode, validated.kept_channels, report.total_colors,
        report.out_of_gamut_count, output_path,
    )
    return report


# ===========================================================================
# Preview OOG — render trang + tô đỏ Out_Of_Gamut_Region (TASK 10.1)
# ===========================================================================
#
# Phần này HOÀN TOÀN ĐỘC LẬP với pipeline biến đổi PDF ở trên (remove_channels /
# _traverse_pages / _aggregate_report / các transformer). Nó CHỈ:
#   - Tái dùng các lớp lõi CÔNG KHAI đã có: ``validate_params``, ``_build_engine``,
#     ``ColorMapper`` (gọi ``ColorMapper.map_color``) — KHÔNG sửa đổi chúng.
#   - Tái dùng kỹ thuật raster của ``softproof.py`` / ``separations.py``: render
#     trang ra RGB bằng ``pypdfium2``, và công thức RGB↔CMYK (GCR đơn giản) giống
#     ``SeparationEngine._run_pikepdf_fallback`` để bảo đảm round-trip nhất quán.
#
# Mục tiêu (Req 4.3, 10.1):
#   - Render một trang PDF và tô ĐỎ các Out_Of_Gamut_Region để người dùng nhận
#     biết bằng mắt (Req 4.3).
#   - Bảo đảm PARITY preview/output (Req 10.1): preview phản ánh ĐÚNG phép biến
#     đổi màu mà ``remove_channels`` sẽ áp — vì cả hai cùng đi qua
#     ``ColorMapper.map_color``. Lớp nền (``base_image``) là kết quả đã gỡ kênh
#     (chưa tô đỏ) để so parity với raster output; lớp hiển thị
#     (``highlighted_image``) = base + tô đỏ OOG cho người dùng.
#
# GIẢ ĐỊNH (documented):
#   - CMYK↔RGB dùng công thức GCR đơn giản, ĐỒNG BỘ với ``separations.py``
#     (renderer DeviceCMYK của pdfium xấp xỉ cùng công thức). Round-trip
#     RGB→CMYK→RGB là khả nghịch cho màu KHÔNG bị biến đổi ⇒ với pixel không gỡ
#     kênh, base_image trùng raster gốc; chỉ pixel bị gỡ kênh mới khác — và đó
#     đúng là phần output cũng biến đổi ⇒ parity giữ trong ngưỡng.
#   - OOG chỉ phát sinh ở Re_Separation_Mode (``map_color`` trả ``is_oog=True``
#     khi ``delta_e > gamut_threshold``). Direct_Removal_Mode luôn ``is_oog=False``
#     nên preview không tô đỏ — đúng ngữ nghĩa (xóa thẳng không đo gamut).
#   - Dedup theo MÀU DUY NHẤT để map mỗi màu đúng một lần (giống
#     ``ImageXObjectTransformer._map_pixels``) nhằm giới hạn chi phí argmin LUT.

#: Màu tô (RGB) cho Out_Of_Gamut_Region trong preview — đỏ thuần (Req 4.3).
PREVIEW_OOG_RGB: tuple[int, int, int] = (255, 0, 0)

#: DPI render preview mặc định (đồng bộ mặc định ``softproof.render_softproof``).
DEFAULT_PREVIEW_DPI: int = 150

#: Cạnh dài tối đa (px) của raster preview — chặn trên số pixel/màu duy nhất để
#: giữ thời gian render + argmin LUT trong tầm kiểm soát. Ảnh lớn hơn bị thu nhỏ
#: giữ tỉ lệ (không ảnh hưởng tính đúng của việc phân loại OOG).
DEFAULT_PREVIEW_MAX_DIM: int = 1600


@dataclass
class OOGPreview:
    """Kết quả preview tô đỏ Out_Of_Gamut cho một trang (TASK 10.1).

    - ``base_image``: PIL ``Image`` RGB của kết quả ĐÃ gỡ kênh (CHƯA tô đỏ) — lớp
      dùng để so parity với raster output (Req 10.1 / Property 13).
    - ``highlighted_image``: PIL ``Image`` RGB = ``base_image`` + tô đỏ vùng OOG —
      lớp hiển thị cho người dùng (Req 4.3).
    - ``oog_mask``: numpy bool (H, W); True tại pixel thuộc Out_Of_Gamut_Region.
    - ``width`` / ``height``: kích thước raster (px).
    - ``total_pixels`` / ``out_of_gamut_pixels``: tổng số pixel & số pixel OOG.
    - ``max_delta_e``: ΔE lớn nhất trên toàn raster (0 ở Direct_Removal_Mode).
    - ``oog_fraction``: tỉ lệ pixel OOG (0..1).
    """
    base_image: "Image.Image"
    highlighted_image: "Image.Image"
    oog_mask: "np.ndarray"
    width: int
    height: int
    total_pixels: int
    out_of_gamut_pixels: int
    max_delta_e: float
    oog_fraction: float


# ---------------------------------------------------------------------------
# Helpers raster CMYK↔RGB (đồng bộ công thức GCR của separations.py)
# ---------------------------------------------------------------------------

def _rgb_to_cmyk100_array(rgb):
    """RGB uint8 (H, W, 3) → CMYK float (H, W, 4) thang 0..100 (%).

    Dùng công thức GCR đơn giản y hệt ``SeparationEngine._run_pikepdf_fallback``
    để bảo đảm tính nhất quán với pipeline raster hiện có.
    """
    import numpy as np

    arr = rgb.astype(np.float32) / 255.0
    r = arr[..., 0]
    g = arr[..., 1]
    b = arr[..., 2]

    k = 1.0 - np.maximum(np.maximum(r, g), b)
    denom = np.where(k < 1.0, 1.0 - k, 1.0)
    c = (1.0 - r - k) / denom
    m = (1.0 - g - k) / denom
    y = (1.0 - b - k) / denom

    cmyk = np.stack([c, m, y, k], axis=-1)
    return np.clip(cmyk, 0.0, 1.0) * 100.0


def _cmyk100_to_rgb_array(cmyk100):
    """CMYK float (H, W, 4) thang 0..100 → RGB uint8 (H, W, 3).

    Nghịch đảo của ``_rgb_to_cmyk100_array`` (renderer DeviceCMYK xấp xỉ cùng phép
    này): ``r = (1-c)(1-k)`` v.v. Khả nghịch cho màu không biến đổi ⇒ round-trip
    giữ nguyên raster gốc tại các pixel không bị gỡ kênh (đảm bảo parity).
    """
    import numpy as np

    arr = np.clip(cmyk100, 0.0, 100.0) / 100.0
    c = arr[..., 0]
    m = arr[..., 1]
    y = arr[..., 2]
    k = arr[..., 3]

    r = (1.0 - c) * (1.0 - k)
    g = (1.0 - m) * (1.0 - k)
    b = (1.0 - y) * (1.0 - k)

    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(rgb * 255.0, 0.0, 255.0).astype(np.uint8)


def _map_cmyk_preview_array(cmyk100, mapper: "ColorMapper"):
    """Áp ``mapper.map_color`` cho mọi pixel CMYK (H, W, 4) thang 0..100.

    Vector hoá theo MÀU DUY NHẤT (giống ``ImageXObjectTransformer._map_pixels``):
    map mỗi màu duy nhất đúng một lần rồi phát tán về toàn raster — giới hạn chi
    phí argmin LUT ở Re_Separation_Mode. Trả
    ``(result_cmyk100, oog_mask, max_delta_e, out_of_gamut_pixels)``.
    """
    import numpy as np

    h, w, _ = cmyk100.shape
    flat = cmyk100.reshape(-1, 4)
    total = int(flat.shape[0])

    # Lượng tử hoá nhẹ về 2 chữ số thập phân để gom màu gần trùng (sai khác do
    # số dấu phẩy động khi RGB→CMYK) mà không ảnh hưởng phân loại OOG.
    quant = np.round(flat, 2)
    uniq, inverse = np.unique(quant, axis=0, return_inverse=True)

    out_uniq = np.empty_like(uniq, dtype=np.float32)
    oog_uniq = np.zeros(len(uniq), dtype=bool)
    delta_uniq = np.zeros(len(uniq), dtype=np.float64)

    for i in range(len(uniq)):
        cmyk = (
            float(uniq[i, 0]), float(uniq[i, 1]),
            float(uniq[i, 2]), float(uniq[i, 3]),
        )
        result, delta_e, is_oog = mapper.map_color(cmyk)
        out_uniq[i] = result
        delta_uniq[i] = delta_e
        oog_uniq[i] = bool(is_oog)

    result_cmyk = out_uniq[inverse].reshape(h, w, 4)
    oog_mask = oog_uniq[inverse].reshape(h, w)

    max_delta_e = float(delta_uniq.max()) if len(delta_uniq) else 0.0
    out_of_gamut_pixels = int(oog_mask.sum())

    return result_cmyk, oog_mask, max_delta_e, out_of_gamut_pixels


def highlight_oog_regions(base_rgb, oog_mask,
                          oog_color: tuple[int, int, int] = PREVIEW_OOG_RGB):
    """Tô màu OOG lên một bản sao của ``base_rgb`` (H, W, 3) tại ``oog_mask`` True.

    Hàm thuần, không sửa ``base_rgb`` gốc — thuận tiện cho unit test (Req 4.3).
    Trả mảng RGB uint8 mới đã tô đỏ vùng OOG.
    """
    import numpy as np

    out = np.array(base_rgb, dtype=np.uint8, copy=True)
    if oog_mask is not None and oog_mask.any():
        out[oog_mask] = np.array(oog_color, dtype=np.uint8)
    return out


def compute_oog_preview(cmyk100, mapper: "ColorMapper",
                        oog_color: tuple[int, int, int] = PREVIEW_OOG_RGB
                        ) -> OOGPreview:
    """Lõi thuần raster: từ CMYK (H, W, 4) thang 0..100 → ``OOGPreview``.

    Không phụ thuộc PDF/IO — nhận thẳng mảng CMYK nên dễ kiểm thử (TASK 10.3) và
    tái dùng cho cả render trang (TASK 10.1) lẫn so parity (TASK 10.2). Quy trình:
      1. ``map_color`` mọi pixel (dedup màu) → ``result_cmyk100`` + ``oog_mask``.
      2. ``base_image`` = ``result_cmyk100`` → RGB (kết quả đã gỡ kênh, parity).
      3. ``highlighted_image`` = base + tô đỏ vùng OOG (Req 4.3).
    """
    from PIL import Image

    result_cmyk, oog_mask, max_delta_e, oog_pixels = _map_cmyk_preview_array(
        cmyk100, mapper
    )
    base_rgb = _cmyk100_to_rgb_array(result_cmyk)
    highlighted_rgb = highlight_oog_regions(base_rgb, oog_mask, oog_color)

    h, w = oog_mask.shape
    total = int(h * w)

    return OOGPreview(
        base_image=Image.fromarray(base_rgb, "RGB"),
        highlighted_image=Image.fromarray(highlighted_rgb, "RGB"),
        oog_mask=oog_mask,
        width=int(w),
        height=int(h),
        total_pixels=total,
        out_of_gamut_pixels=int(oog_pixels),
        max_delta_e=max_delta_e,
        oog_fraction=(oog_pixels / total) if total else 0.0,
    )


def _render_page_rgb(input_path: str, page_index: int, dpi: int,
                     max_dim: int):
    """Render trang PDF (0-based) ra ảnh PIL RGB bằng ``pypdfium2``.

    Tái dùng kỹ thuật của ``softproof._render`` / ``separations._run_pikepdf_fallback``.
    Thu nhỏ giữ tỉ lệ nếu cạnh dài vượt ``max_dim`` (chặn trên chi phí). Ném
    ``ValueError`` nếu ``page_index`` ngoài phạm vi.
    """
    import pypdfium2 as pdfium
    from PIL import Image

    from app.core.pdfium_lock import pdfium_guard

    # KIENTRUC (audit 2026-07-29 §C.1): preview ΔE gọi qua threadpool. `.convert("RGB")`
    # trả ảnh MỚI nên bước resize LANCZOS phía dưới làm được ngoài khóa.
    with pdfium_guard("channel_remover_render"):
        doc = pdfium.PdfDocument(input_path)
        try:
            n_pages = len(doc)
            if page_index < 0 or page_index >= n_pages:
                raise ValueError(
                    f"page_index={page_index} ngoài phạm vi (tài liệu có {n_pages} trang)."
                )
            page = doc[page_index]
            scale = dpi / 72.0
            bitmap = page.render(scale=scale)
            img = bitmap.to_pil().convert("RGB")
        finally:
            doc.close()

    if max_dim and max(img.size) > max_dim:
        w, h = img.size
        factor = max_dim / float(max(w, h))
        new_size = (max(1, int(round(w * factor))), max(1, int(round(h * factor))))
        img = img.resize(new_size, Image.LANCZOS)

    return img


def render_oog_preview(input_path: str, params, page_index: int = 0, *,
                       dpi: int = DEFAULT_PREVIEW_DPI,
                       max_dim: int = DEFAULT_PREVIEW_MAX_DIM,
                       oog_color: tuple[int, int, int] = PREVIEW_OOG_RGB
                       ) -> OOGPreview:
    """Render một trang PDF + tô đỏ Out_Of_Gamut_Region (TASK 10.1 — Req 4.3, 10.1).

    Tham số:
      - ``input_path``: PDF nguồn (CMYK).
      - ``params``: dict tham số gỡ kênh (như ``remove_channels``) — được
        ``validate_params`` chuẩn hoá; phải hợp lệ (giữ 1..3 kênh).
      - ``page_index``: chỉ số trang 0-based (mặc định 0).
      - ``dpi`` / ``max_dim`` / ``oog_color``: tuỳ chọn render.

    Trả ``OOGPreview`` (xem docstring lớp). PARITY (Req 10.1): preview áp đúng
    ``ColorMapper.map_color`` mà ``remove_channels`` dùng nên màu kết quả khớp
    output; OOG được tô đỏ ở ``highlighted_image`` (Req 4.3).

    Ghi chú: với ``params['mode'] == 'reseparate'`` cần ICC FOGRA39 (qua
    ``_build_engine``) — ném ``FileNotFoundError`` rõ ràng nếu thiếu profile,
    đồng bộ ``remove_channels``.
    """
    import numpy as np

    # 1) Validate tham số (Req 1) — chia sẻ logic với remove_channels (parity).
    validated = validate_params(params)

    # 2) Validate input file (file tồn tại & không rỗng) — đồng bộ remove_channels.
    _validate_input_file(input_path)

    # 3) Engine (reseparate) + ColorMapper DÙNG CHUNG đúng như remove_channels.
    engine = _build_engine(validated)
    mapper = ColorMapper(validated, engine=engine)

    # 4) Render trang → RGB, rồi RGB→CMYK (thang 0..100) để áp map_color.
    img = _render_page_rgb(input_path, page_index, dpi, max_dim)
    rgb = np.array(img)
    cmyk100 = _rgb_to_cmyk100_array(rgb)

    # 5) Lõi thuần raster: map màu + tô đỏ OOG.
    preview = compute_oog_preview(cmyk100, mapper, oog_color)

    logger.info(
        "render_oog_preview: mode=%s kept=%s page=%d size=%dx%d oog=%d/%d max_de=%.2f",
        validated.mode, validated.kept_channels, page_index,
        preview.width, preview.height, preview.out_of_gamut_pixels,
        preview.total_pixels, preview.max_delta_e,
    )
    return preview

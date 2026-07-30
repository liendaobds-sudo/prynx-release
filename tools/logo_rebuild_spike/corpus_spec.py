"""Lược đồ metadata cho corpus spike "Phục hồi & Vector hóa Logo".

Vì sao cần một lược đồ thay vì thư mục ảnh trần: kết luận GO/NO-GO ở cổng G1 chỉ
có nghĩa khi biết mỗi ca *kỳ vọng* điều gì. Một ảnh thêu bị vector hóa thành 4000
path không phải lỗi engine — nó là ca `reject` và phải được tính vào cột "phát
hiện đúng", chứ không tính vào cột "thất bại". Trộn hai loại đó là cách nhanh
nhất để tự lừa mình bằng một tỷ lệ đạt đẹp.

Lược đồ cũng ghi *quyền sử dụng* ngay trong dữ liệu: ảnh không rõ nguồn vẫn dùng
được để chạy thử kỹ thuật, nhưng không được đếm vào corpus chính thức và không
được đưa ảnh so sánh vào tài liệu phát hành.

Chạy trực tiếp để kiểm tra một file metadata:

    backend\\venv\\Scripts\\python.exe tools\\logo_rebuild_spike\\corpus_spec.py <corpus.json>
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Literal

SCHEMA_VERSION = 2

# Quyền sử dụng. Chỉ 'synthetic' và 'owned' được tính vào corpus chính thức.
Rights = Literal["synthetic", "owned", "licensed", "unknown"]
RIGHTS_OFFICIAL: frozenset[str] = frozenset({"synthetic", "owned", "licensed"})

# Phân loại logo theo mục 5.1 báo cáo khảo sát (flat_color / line_art /
# photo_or_gradient / uncertain) mở rộng thêm số màu vì ngưỡng đạt khác nhau.
LogoType = Literal[
    "flat_1_4",       # logo phẳng 1–4 màu — ngưỡng đạt cao nhất (≥90%)
    "flat_5_12",      # logo phẳng 5–12 màu — ngưỡng 75–80%
    "bw",             # đen trắng / một màu
    "line_art",       # nét mảnh, chữ viết tay, contour
    "text",           # chủ yếu là chữ (gồm chữ Việt có dấu)
    "photo_gradient",  # ảnh chụp / chuyển sắc — dự kiến KHÔNG nên vector hóa
    "embroidery",     # thêu — cần tái dựng cấu trúc sợi, ngoài phạm vi
    "occluded",       # bị che / rách / mất phần lớn hình học
]

# Kỳ vọng của người ra đề, không phải kết quả engine.
DatasetSplit = Literal["train", "holdout", "reject"]


Expectation = Literal[
    "pass",    # phải ra vector dùng được
    "review",  # được phép ra kết quả nhưng PHẢI kèm cảnh báo
    "reject",  # phải bị phát hiện và từ chối/cảnh báo mạnh, không trả kết quả êm ru
]

# Các phép làm suy giảm ảnh dùng cho corpus synthetic. Tên cố định để đối chiếu
# giữa báo cáo và script sinh dữ liệu.
Degradation = Literal[
    "perspective",   # biến đổi phối cảnh (homography) — ma trận biết trước
    "illumination",  # trường sáng tần số thấp không đều
    "fabric",        # texture vải dệt
    "wrinkle",       # nhăn nhẹ (dịch chuyển phi tuyến biên độ nhỏ)
    "blur",          # nhòe Gauss
    "jpeg",          # nén JPEG mất dữ liệu
    "downscale",     # giảm độ phân giải
    "alpha",         # giữ nền trong suốt
]


@dataclass
class CorpusCase:
    """Một ca kiểm thử trong corpus."""

    case_id: str
    # Đường dẫn ảnh đầu vào, TƯƠNG ĐỐI so với thư mục gốc corpus. Tuyệt đối
    # không lưu đường dẫn máy cụ thể vào metadata sẽ đi vào git.
    image: str
    rights: Rights
    source: str                       # nguồn gốc, mô tả người đọc hiểu được
    logo_type: LogoType
    expectation: Expectation
    width_px: int
    height_px: int
    # train dùng chọn preset; holdout chỉ dùng đánh giá; reject dành cho ca phải từ chối.
    split: DatasetSplit = "train"
    # Số màu chính kỳ vọng của thiết kế gốc (không phải số màu đếm được trong
    # ảnh JPEG). None khi không biết.
    expected_colors: int | None = None
    # Kích thước in thật của logo, mm. None khi không biết — và khi None thì
    # KHÔNG được kiểm tiêu chí sai lệch kích thước vật lý trên ca này.
    physical_size_mm: tuple[float, float] | None = None
    # Ground truth: SVG gốc (tương đối so với gốc corpus) và bản raster sạch
    # render từ chính SVG đó. Không có ground truth ⇒ chỉ đo được self-consistency.
    ground_truth_svg: str | None = None
    ground_truth_png: str | None = None
    # Bốn góc vùng logo trong ảnh đã suy giảm, toạ độ chuẩn hoá 0..1 theo thứ tự
    # trên-trái, trên-phải, dưới-phải, dưới-trái. Với ca synthetic đây là ma trận
    # biết trước ⇒ đo được sai số hiệu chỉnh phối cảnh.
    quad_normalized: list[tuple[float, float]] | None = None
    degradations: list[Degradation] = field(default_factory=list)
    # Vì sao ca này thuộc nhóm review/reject. BẮT BUỘC khi expectation != 'pass':
    # không có lý do thì không kiểm chứng được engine từ chối vì đúng nguyên nhân.
    expectation_reason: str | None = None
    notes: str = ""

    # ── Kiểm tra ────────────────────────────────────────────────────────────
    def validate(self, corpus_root: Path | None = None) -> list[str]:
        """Trả danh sách lỗi. Rỗng nghĩa là hợp lệ."""
        errors: list[str] = []
        if not self.case_id:
            errors.append("case_id rỗng")
        if self.width_px <= 0 or self.height_px <= 0:
            errors.append(f"{self.case_id}: kích thước ảnh không hợp lệ")
        if self.expectation == "reject" and self.split != "reject":
            errors.append(f"{self.case_id}: expectation=reject phải thuộc split=reject")
        if self.split == "reject" and self.expectation != "reject":
            errors.append(f"{self.case_id}: split=reject phải có expectation=reject")
        if self.expectation != "pass" and not self.expectation_reason:
            errors.append(
                f"{self.case_id}: expectation='{self.expectation}' nhưng thiếu "
                "expectation_reason — không kiểm chứng được engine từ chối đúng lý do"
            )
        if self.ground_truth_svg and not self.ground_truth_png:
            errors.append(
                f"{self.case_id}: có SVG ground truth nhưng thiếu bản raster sạch "
                "kèm theo (cần cho boundary F-score)"
            )
        if self.quad_normalized is not None:
            if len(self.quad_normalized) != 4:
                errors.append(f"{self.case_id}: quad_normalized phải có đúng 4 điểm")
            else:
                for x, y in self.quad_normalized:
                    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                        errors.append(
                            f"{self.case_id}: quad_normalized ngoài khoảng 0..1"
                        )
                        break
        if self.physical_size_mm is not None:
            w, h = self.physical_size_mm
            if w <= 0 or h <= 0:
                errors.append(f"{self.case_id}: physical_size_mm không hợp lệ")
        if corpus_root is not None:
            for rel in (self.image, self.ground_truth_svg, self.ground_truth_png):
                if rel and not (corpus_root / rel).is_file():
                    errors.append(f"{self.case_id}: thiếu file '{rel}'")
        return errors

    @property
    def is_official(self) -> bool:
        """Được tính vào tỷ lệ đạt ở cổng G1 hay không."""
        return self.rights in RIGHTS_OFFICIAL

    @property
    def has_ground_truth(self) -> bool:
        return bool(self.ground_truth_svg and self.ground_truth_png)


def to_json(cases: list[CorpusCase], path: Path, description: str = "") -> None:
    payload = {
        "schema_version": SCHEMA_VERSION,
        "description": description,
        "cases": [_clean(asdict(c)) for c in cases],
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def from_json(path: Path) -> list[CorpusCase]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    version = payload.get("schema_version")
    if version != SCHEMA_VERSION:
        raise ValueError(
            f"schema_version={version} không tương thích (cần {SCHEMA_VERSION}). "
            "Sinh lại corpus hoặc viết migration — đừng đọc chệch lược đồ."
        )
    out: list[CorpusCase] = []
    for raw in payload.get("cases", []):
        raw = dict(raw)
        if raw.get("physical_size_mm") is not None:
            raw["physical_size_mm"] = tuple(raw["physical_size_mm"])
        if raw.get("quad_normalized") is not None:
            raw["quad_normalized"] = [tuple(p) for p in raw["quad_normalized"]]
        out.append(CorpusCase(**raw))
    return out


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    """Bỏ khoá None để file metadata đọc được bằng mắt."""
    return {k: v for k, v in d.items() if v is not None}


def summarize(cases: list[CorpusCase]) -> str:
    """Bảng tóm tắt corpus — dùng trong báo cáo G0."""
    by_type: dict[str, list[CorpusCase]] = {}
    for c in cases:
        by_type.setdefault(c.logo_type, []).append(c)

    lines = [
        f"Tổng: {len(cases)} ca | chính thức: {sum(c.is_official for c in cases)} "
        f"| có ground truth: {sum(c.has_ground_truth for c in cases)}",
        ("Split: " + ", ".join(
            f"{split}={sum(c.split == split for c in cases)}"
            for split in ("train", "holdout", "reject")
        )),
        "",
        f"{'Nhóm':16} {'Ca':>3} {'C.thức':>6} {'G.truth':>7} {'pass':>5} "
        f"{'review':>6} {'reject':>6}",
        "-" * 60,
    ]
    for logo_type in sorted(by_type):
        group = by_type[logo_type]
        lines.append(
            f"{logo_type:16} {len(group):3} {sum(c.is_official for c in group):6} "
            f"{sum(c.has_ground_truth for c in group):7} "
            f"{sum(c.expectation == 'pass' for c in group):5} "
            f"{sum(c.expectation == 'review' for c in group):6} "
            f"{sum(c.expectation == 'reject' for c in group):6}"
        )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    cases = from_json(path)
    root = path.parent
    errors: list[str] = []
    seen: set[str] = set()
    for case in cases:
        if case.case_id in seen:
            errors.append(f"case_id trùng: {case.case_id}")
        seen.add(case.case_id)
        errors.extend(case.validate(root))
    print(summarize(cases))
    print()
    if errors:
        print(f"KHÔNG HỢP LỆ — {len(errors)} lỗi:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("Corpus hợp lệ.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

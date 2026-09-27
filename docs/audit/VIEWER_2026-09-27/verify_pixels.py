"""Đối chiếu artifact PPE/GPU của audit; không sửa input PDF hay ảnh nguồn."""
from pathlib import Path
import hashlib
import json
import sys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

root = Path(__file__).resolve().parent
ppe_path = root / "worker-probe/ppe-run-1-sample-1.png"
ppe = np.asarray(Image.open(ppe_path).convert("RGBA"))
height, width, _ = ppe.shape
report = {
    "scope": "headless_artifact_comparison_not_display_or_acrobat_acceptance",
    "reference": str(ppe_path), "width": width, "height": height,
    "reference_sha256": hashlib.sha256(ppe_path.read_bytes()).hexdigest(),
    "limitations": [
        "PPE worker EXE và standalone GPU test là hai binary khác nhau.",
        "Camera GPU là scale 96/72, pan 0; không có WebView/scan-out/monitor ICC.",
        "RGB MAE không phải DeltaE hoặc chứng nhận FOGRA39/Acrobat.",
    ],
    "comparisons": [],
}
for run in range(3):
    path = root / f"gpu-headless/run-{run}-camera-0.rgba"
    data = path.read_bytes()
    if len(data) != width * height * 4:
        raise ValueError(f"Kích thước raw không đúng: {path}")
    pixels = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 4)
    delta = np.abs(pixels[:, :, :3].astype(np.int16) - ppe[:, :, :3].astype(np.int16))
    maximum = delta.max(axis=2)
    report["comparisons"].append({
        "run": run, "path": str(path), "sha256": hashlib.sha256(data).hexdigest(),
        "mean_abs_rgb_0_255": float(delta.mean()), "max_abs_channel": int(delta.max()),
        "fraction_pixels_any_channel_gt_2": float((maximum > 2).mean()),
        "fraction_pixels_any_channel_gt_10": float((maximum > 10).mean()),
        "fraction_exact_rgb": float((maximum == 0).mean()),
        "alpha_min": int(pixels[:, :, 3].min()), "alpha_max": int(pixels[:, :, 3].max()),
        "fraction_gray_82_86_89": float(np.all(pixels[:, :, :3] == [82, 86, 89], axis=2).mean()),
    })
    # PNG này chỉ là giải mã raw test để kiểm thị giác, không chỉnh sửa pixel.
    Image.fromarray(pixels).save(root / f"gpu-headless/run-{run}-camera-0.png")
(root / "pixel-comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))

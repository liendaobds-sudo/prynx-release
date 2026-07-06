"""
convert_realesrgan_onnx.py — Convert Real-ESRGAN .pth (PyTorch) -> .onnx.

CHỈ chạy ở MÁY BUILD (cần torch). Runtime của app KHÔNG cần torch — chỉ cần file
.onnx sinh ra ở đây + onnxruntime (đồng bộ triết lý isnet/birefnet). Repo gốc
xinntao/Real-ESRGAN chỉ phát hành .pth nên phải tự convert.

Kiến trúc mạng định nghĩa INLINE (không import basicsr — basicsr kéo theo nhiều dep
nặng/fragile). MỘT model duy nhất:
  - general: SRVGGNetCompact (~5MB) — MẶC ĐỊNH thuần x4v3 (alpha=1.0), giữ TỐI ĐA
             chi tiết/texture. Nhẹ, ảnh thật, cùng tốc độ dù blend hay không.
             (Trước từng blend 50/50 với wdn nhưng khử nhiễu mạnh → ảnh "bệt".)

DNI (Deep Network Interpolation): hai checkpoint x4v3 và x4v3-wdn cùng kiến trúc nên
có thể trộn thẳng trọng số theo alpha — alpha*x4v3 + (1-alpha)*wdn. alpha=1.0 = thuần
x4v3 (không khử nhiễu). Hạ alpha nếu ảnh nguồn nhiều nhiễu và cần làm mượt.

Dùng:
    pip install torch onnx
    python convert_realesrgan_onnx.py --out ~/.u2net          # thuần x4v3 (mặc định)
    python convert_realesrgan_onnx.py --out ~/.u2net --alpha 0.7  # thêm chút khử nhiễu

Sau khi có .onnx, build_production.ps1 copy vào bundle / hoặc đặt sẵn ở ~/.u2net.
"""
import argparse
import os
import sys
import urllib.request

import torch
import torch.nn as nn
import torch.nn.functional as F

# torch exporter moi in ky tu ✅ -> stdout cp1252 (Windows) vo hieu -> ep UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# URL .pth CHÍNH THỨC (đã xác minh trên repo xinntao/Real-ESRGAN releases).
# x4v3     : bản sắc nét (nhưng còn nhiễu).
# x4v3-wdn : cùng kiến trúc, huấn luyện thiên về khử nhiễu (with-denoise).
URL_X4V3 = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth"
URL_WDN = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth"
ONNX_NAME = "realesr-general-x4v3.onnx"


# ─────────────────────── SRVGGNetCompact (realesr-general-x4v3) ───────────────────────
class SRVGGNetCompact(nn.Module):
    """Kiến trúc compact VGG-style của realesr-general-x4v3 (num_conv=32, x4)."""

    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        # residual: nội suy ảnh gốc rồi cộng (đúng như cài đặt gốc).
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


def _download(url: str, dst: str):
    if os.path.exists(dst):
        return
    print(f"Downloading {url} ...")
    urllib.request.urlretrieve(url, dst)


def _extract_state(pth_path: str) -> dict:
    ckpt = torch.load(pth_path, map_location="cpu")
    if isinstance(ckpt, dict):
        for key in ("params_ema", "params"):
            if key in ckpt:
                return ckpt[key]
    return ckpt


def _dni_blend(state_a: dict, state_b: dict, alpha: float) -> dict:
    """Trộn TRỌNG SỐ hai checkpoint cùng kiến trúc: alpha*A + (1-alpha)*B."""
    blended = {}
    for k in state_a:
        blended[k] = state_a[k] * alpha + state_b[k] * (1.0 - alpha)
    return blended


def convert(out_dir: str, alpha: float):
    os.makedirs(out_dir, exist_ok=True)
    # .pth tải vào cache HOME (~/.u2net), KHÔNG vào out_dir: out_dir thường là thư mục
    # bundle (app/data/models) sẽ bị gói vào exe — .pth vừa thừa ~10MB vừa LỘ tên model
    # kiến trúc gốc. Chỉ .onnx (đã compile, tên trung tính) mới ghi vào out_dir.
    pth_cache = os.path.expanduser(os.path.join("~", ".u2net"))
    os.makedirs(pth_cache, exist_ok=True)
    x4v3_path = os.path.join(pth_cache, os.path.basename(URL_X4V3))
    wdn_path = os.path.join(pth_cache, os.path.basename(URL_WDN))
    onnx_path = os.path.join(out_dir, ONNX_NAME)
    _download(URL_X4V3, x4v3_path)
    _download(URL_WDN, wdn_path)

    print(f"DNI blend x4v3 + wdn (alpha={alpha}) ...")
    state = _dni_blend(_extract_state(x4v3_path), _extract_state(wdn_path), alpha)

    model = SRVGGNetCompact(num_conv=32, upscale=4)
    model.load_state_dict(state, strict=True)
    model.eval()

    dummy = torch.rand(1, 3, 64, 64, dtype=torch.float32)
    print(f"Exporting -> {onnx_path}")
    torch.onnx.export(
        model, dummy, onnx_path,
        input_names=["input"], output_names=["output"],
        opset_version=17,
        dynamic_axes={"input": {0: "b", 2: "h", 3: "w"}, "output": {0: "b", 2: "h4", 3: "w4"}},
        dynamo=False,  # exporter legacy: on dinh cho CNN nay, khong can onnxscript.
    )
    print(f"  OK: {onnx_path} ({os.path.getsize(onnx_path) // 1024} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser(os.path.join("~", ".u2net")),
                    help="Thư mục ghi .onnx (mặc định ~/.u2net)")
    ap.add_argument("--alpha", type=float, default=1.0,
                    help="Hệ số DNI: alpha*x4v3 + (1-alpha)*wdn. 1.0 = thuần x4v3 (giữ "
                         "chi tiết tối đa, mặc định); giảm dần về 0 để tăng khử nhiễu (mượt/bệt hơn).")
    args = ap.parse_args()
    convert(args.out, args.alpha)


if __name__ == "__main__":
    main()

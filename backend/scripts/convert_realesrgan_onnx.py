"""
convert_realesrgan_onnx.py — Convert các model Real-ESRGAN .pth -> .onnx.

CHỈ chạy ở MÁY BUILD (cần torch + onnx). Runtime của app chỉ cần ONNX Runtime.
Hai model:
  - general: SRVGGNetCompact x4v3 (~5 MB), chế độ Nhanh.
  - quality: RealESRGAN_x4plus RRDBNet 23 khối, chế độ Chất lượng.
"""
import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request

import torch
import torch.nn as nn
import torch.nn.functional as F

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

URL_X4V3 = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth"
URL_WDN = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth"
URL_X4PLUS = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
CHECKPOINT_SHA256 = {
    URL_X4V3: "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
    URL_WDN: "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca",
    URL_X4PLUS: "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
}
ONNX_NAME = "realesr-general-x4v3.onnx"
ONNX_QUALITY_NAME = "realesrgan-x4plus.onnx"


class SRVGGNetCompact(nn.Module):
    """Kiến trúc compact VGG-style của realesr-general-x4v3."""

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
        return out + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


class ResidualDenseBlock(nn.Module):
    """Khối dense 5 lớp của RRDBNet chính thức."""

    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):
    """RealESRGAN_x4plus: RRDBNet 23 khối, scale x4."""

    def __init__(self, num_feat=64, num_block=23, num_grow_ch=32):
        super().__init__()
        self.conv_first = nn.Conv2d(3, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, 3, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, dst: str):
    expected_sha256 = CHECKPOINT_SHA256[url]
    if os.path.exists(dst):
        if _sha256(dst) != expected_sha256:
            raise RuntimeError(
                f"Checkpoint cache sai SHA-256: {dst}. "
                "Hãy xóa file này rồi chạy build lại."
            )
        return

    print(f"Downloading {url} ...")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    handle, temp_path = tempfile.mkstemp(
        prefix=f".{os.path.basename(dst)}.",
        suffix=".download",
        dir=os.path.dirname(dst),
    )
    os.close(handle)
    try:
        urllib.request.urlretrieve(url, temp_path)
        actual_sha256 = _sha256(temp_path)
        if actual_sha256 != expected_sha256:
            raise RuntimeError(
                f"Checkpoint tải về sai SHA-256: {os.path.basename(dst)} "
                f"(expected={expected_sha256}, actual={actual_sha256})"
            )
        os.replace(temp_path, dst)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def _extract_state(pth_path: str) -> dict:
    # SEC (audit 2026-07-30 §SEC.5): chỉ nạp tensor/state dict; không cho pickle
    # checkpoint gọi arbitrary Python object trên máy build.
    ckpt = torch.load(pth_path, map_location="cpu", weights_only=True)
    if isinstance(ckpt, dict):
        for key in ("params_ema", "params"):
            if key in ckpt:
                return ckpt[key]
    return ckpt


def _dni_blend(state_a: dict, state_b: dict, alpha: float) -> dict:
    """Trộn trọng số theo DNI của upstream: state_a = x4v3, state_b = wdn.

    Trùng công thức `dni_weight = [denoise_strength, 1 - denoise_strength]` với
    `model_path = [x4v3, wdn]` trong inference_realesrgan.py, nên `alpha` ở đây
    CHÍNH LÀ `denoise_strength` của upstream. Xem chú thích của --alpha bên dưới.
    """
    return {key: state_a[key] * alpha + state_b[key] * (1.0 - alpha) for key in state_a}


def _export(model: nn.Module, onnx_path: str):
    model.eval()
    dummy = torch.rand(1, 3, 32, 32, dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        dynamic_axes={
            "input": {0: "b", 2: "h", 3: "w"},
            "output": {0: "b", 2: "h4", 3: "w4"},
        },
        dynamo=False,
    )
    print(f"  OK: {onnx_path} ({os.path.getsize(onnx_path) // 1024} KB)")


def convert_fast(out_dir: str, alpha: float):
    os.makedirs(out_dir, exist_ok=True)
    cache = os.path.expanduser(os.path.join("~", ".u2net"))
    os.makedirs(cache, exist_ok=True)
    x4v3_path = os.path.join(cache, os.path.basename(URL_X4V3))
    wdn_path = os.path.join(cache, os.path.basename(URL_WDN))
    _download(URL_X4V3, x4v3_path)
    _download(URL_WDN, wdn_path)

    print(f"DNI blend x4v3 + wdn (alpha={alpha}) ...")
    state = _dni_blend(_extract_state(x4v3_path), _extract_state(wdn_path), alpha)
    model = SRVGGNetCompact(num_conv=32, upscale=4)
    model.load_state_dict(state, strict=True)
    _export(model, os.path.join(out_dir, ONNX_NAME))


def convert_quality(out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    cache = os.path.expanduser(os.path.join("~", ".u2net"))
    os.makedirs(cache, exist_ok=True)
    pth_path = os.path.join(cache, os.path.basename(URL_X4PLUS))
    _download(URL_X4PLUS, pth_path)

    print("Loading RealESRGAN_x4plus RRDBNet ...")
    model = RRDBNet(num_feat=64, num_block=23, num_grow_ch=32)
    model.load_state_dict(_extract_state(pth_path), strict=True)
    _export(model, os.path.join(out_dir, ONNX_QUALITY_NAME))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        default=os.path.expanduser(os.path.join("~", ".u2net")),
        help="Thư mục ghi ONNX",
    )
    # UPSCALE (audit 2026-07-29 §NET.02): dòng help cũ ghi NGƯỢC ("1 giữ chi tiết,
    # 0 khử nhiễu mạnh"). Theo upstream, alpha ≡ denoise_strength: 0 = khử nhiễu
    # YẾU (giữ hạt/texture), 1 = khử nhiễu MẠNH. Mặc định của upstream là 0,5.
    #
    # PrynX đang giữ 1.0, tức bản khử nhiễu MẠNH NHẤT — đây là nguyên nhân đo được
    # của cảm giác "bệt / mất hạt". KHÔNG đổi số này một mình: trọng số đổi thì
    # .onnx đổi SHA-256, phải cập nhật đồng thời realesrgan_engine.MODEL_SHA256,
    # build_production.ps1 và THIRD_PARTY_NOTICES.md, rồi đo lại corpus.
    parser.add_argument(
        "--alpha",
        type=float,
        default=1.0,
        help=(
            "DNI cho model Nhanh (≡ denoise_strength của upstream): "
            "0 = khử nhiễu yếu, giữ hạt/texture; 1 = khử nhiễu mạnh nhất. "
            "Upstream mặc định 0.5; PrynX hiện chốt 1.0 (xem §NET.02)."
        ),
    )
    parser.add_argument(
        "--model",
        choices=("fast", "quality", "all"),
        default="fast",
        help="Model cần chuyển",
    )
    args = parser.parse_args()

    if args.model in ("fast", "all"):
        convert_fast(args.out, args.alpha)
    if args.model in ("quality", "all"):
        convert_quality(args.out)


if __name__ == "__main__":
    main()
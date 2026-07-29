import numpy as np
import cv2
from PIL import Image


def _fb_blur_fusion(image: np.ndarray, F: np.ndarray, B: np.ndarray, alpha: np.ndarray, r: int):
    """1 vòng ước lượng foreground/background bằng box-blur (blur-fusion)."""
    a = alpha[:, :, None]
    blurred_alpha = cv2.blur(alpha, (r, r))[:, :, None]
    blurred_FA = cv2.blur(F * a, (r, r))
    blurred_F = blurred_FA / (blurred_alpha + 1e-5)
    blurred_B1A = cv2.blur(B * (1.0 - a), (r, r))
    blurred_B = blurred_B1A / ((1.0 - blurred_alpha) + 1e-5)
    F_new = blurred_F + a * (image - a * blurred_F - (1.0 - a) * blurred_B)
    return np.clip(F_new, 0.0, 1.0), blurred_B


def refine_foreground_rgba(image: Image.Image, mask: Image.Image, r: int = 90) -> Image.Image:
    """Ước lượng lại MÀU foreground thật ở vùng biên rồi gán alpha = mask.

    Đây là thuật toán 'refine_foreground' của BiRefNet (Fast Multi-Level Foreground
    Estimation, blur-fusion): tẩy màu nền lẫn trong các pixel bán trong suốt ở mép,
    triệt 'viền trắng/xám rác' khi đặt ảnh lên nền khác. Nhẹ (chỉ box-blur numpy) —
    KHÔNG cần pymatting/cupy như alpha_matting của rembg.
    """
    rgb = image.convert("RGB")
    if mask.size != rgb.size:
        mask = mask.resize(rgb.size, Image.BILINEAR)

    img = np.asarray(rgb, dtype=np.float32) / 255.0
    alpha = np.asarray(mask, dtype=np.float32) / 255.0

    # Bán kính blur không được vượt cạnh ảnh (ảnh nhỏ) và phải >=1.
    r1 = max(1, min(r, min(img.shape[0], img.shape[1]) - 1))
    F, blur_B = _fb_blur_fusion(img, img, img, alpha, r1)
    F, _ = _fb_blur_fusion(img, F, blur_B, alpha, max(1, min(6, r1)))

    fg = (F * 255.0).astype(np.uint8)
    # BG (audit 2026-07-28 §BG.04): ảnh nguồn đã có alpha thì mask AI không
    # được làm sống lại vùng vốn trong suốt.
    if "A" in image.getbands():
        source_alpha = np.asarray(image.getchannel("A"), dtype=np.float32) / 255.0
        alpha = alpha * source_alpha
    out = np.dstack([fg, (alpha * 255.0).astype(np.uint8)])
    return Image.fromarray(out, "RGBA")


def apply_edge_shift(image: Image.Image, shift: int) -> Image.Image:
    """
    Kéo giãn hoặc thu hẹp viền của hình ảnh có nền trong suốt.
    shift < 0: Erode (thu hẹp)
    shift > 0: Dilate (mở rộng)
    """
    if shift == 0:
        return image
    
    if image.mode != "RGBA":
        image = image.convert("RGBA")
        
    np_img = np.array(image)
    alpha = np_img[:, :, 3]
    
    kernel_size = abs(shift) * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    
    if shift < 0:
        new_alpha = cv2.erode(alpha, kernel, iterations=1)
    else:
        new_alpha = cv2.dilate(alpha, kernel, iterations=1)
        
    np_img[:, :, 3] = new_alpha
    return Image.fromarray(np_img, "RGBA")

def apply_auto_crop(image: Image.Image) -> Image.Image:
    """
    Tìm Bounding Box của các pixel không trong suốt và cắt ảnh.
    """
    if image.mode != "RGBA":
        image = image.convert("RGBA")
        
    # Get alpha channel
    alpha = image.split()[-1]
    bg = Image.new("L", image.size, 0)
    
    # Get bounding box of non-zero alpha
    bbox = alpha.getbbox()
    if bbox:
        return image.crop(bbox)
    return image

def apply_background(image: Image.Image, bg_mode: str, custom_hex: str) -> Image.Image:
    """
    Đổ nền cho ảnh.
    bg_mode: 'transparent', 'white', 'black', 'custom'
    """
    if bg_mode == 'transparent':
        return image
        
    color = (255, 255, 255, 255) # Default white
    if bg_mode == 'black':
        color = (0, 0, 0, 255)
    elif bg_mode == 'custom' and custom_hex.startswith('#'):
        custom_hex = custom_hex.lstrip('#')
        if len(custom_hex) == 6:
            color = tuple(int(custom_hex[i:i+2], 16) for i in (0, 2, 4)) + (255,)
            
    bg = Image.new("RGBA", image.size, color)
    bg.paste(image, mask=image if image.mode == 'RGBA' else None)
    return bg

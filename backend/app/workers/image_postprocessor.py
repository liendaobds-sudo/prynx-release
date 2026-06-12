import numpy as np
import cv2
from PIL import Image

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

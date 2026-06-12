import os
import httpx
import onnxruntime as ort
import numpy as np
from PIL import Image, ImageFilter

MODEL_URL = "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx"
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "models")
MODEL_PATH = os.path.join(MODEL_DIR, "BiRefNet-general-epoch_244.onnx")

_session = None

def _download_model_if_needed():
    if not os.path.exists(MODEL_DIR):
        os.makedirs(MODEL_DIR, exist_ok=True)
    if not os.path.exists(MODEL_PATH):
        print(f"Downloading BiRefNet ONNX model from {MODEL_URL}...")
        with httpx.stream("GET", MODEL_URL, follow_redirects=True) as r:
            r.raise_for_status()
            with open(MODEL_PATH, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=8192):
                    f.write(chunk)
        print("Download complete.")

def _get_session():
    global _session
    if _session is None:
        _download_model_if_needed()
        print("Loading BiRefNet ONNX session...")
        
        # Prioritize GPU providers to accelerate inference
        available_providers = ort.get_available_providers()
        providers = []
        if 'CUDAExecutionProvider' in available_providers:
            providers.append('CUDAExecutionProvider')
        if 'DmlExecutionProvider' in available_providers:
            providers.append('DmlExecutionProvider') # For Windows DirectML
        providers.append('CPUExecutionProvider')
        
        _session = ort.InferenceSession(MODEL_PATH, providers=providers)
    return _session

def preprocess(image: Image.Image, size=(1024, 1024)):
    """Preprocess image for BiRefNet: direct resize + ImageNet normalization."""
    image = image.convert("RGB")
    
    # BiRefNet expects direct resize to 1024x1024 (no letterboxing!)
    img_resized = image.resize(size, Image.BILINEAR)
    
    # Convert to float [0, 1]
    img_arr = np.array(img_resized, dtype=np.float32) / 255.0
    
    # Normalize with ImageNet stats
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    img_arr = (img_arr - mean) / std
    
    # HWC to NCHW format
    img_arr = np.transpose(img_arr, (2, 0, 1))
    img_arr = np.expand_dims(img_arr, axis=0)
    
    return img_arr

def remove_background(image: Image.Image) -> Image.Image:
    """
    Takes a PIL Image, runs BiRefNet to segment background, 
    and returns a new PIL Image with a transparent background.
    """
    orig_w, orig_h = image.size
    
    session = _get_session()
    
    # Input name
    input_name = session.get_inputs()[0].name
    
    # Preprocess: direct resize to 1024x1024 (matches BiRefNet training)
    input_tensor = preprocess(image)
    
    # Inference
    outputs = session.run(None, {input_name: input_tensor})
    
    # Single output: raw logits [1, 1, 1024, 1024]
    mask_logits = outputs[-1]
    print(f"[BiRefNet] Raw logits range: min={mask_logits.min():.4f}, max={mask_logits.max():.4f}, mean={mask_logits.mean():.4f}")
    
    # Apply sigmoid to convert logits to probabilities [0, 1]
    mask_prob = 1.0 / (1.0 + np.exp(-mask_logits))
    mask_prob = np.squeeze(mask_prob)  # shape (1024, 1024)
    
    print(f"[BiRefNet] Mask stats: min={mask_prob.min():.4f}, max={mask_prob.max():.4f}, mean={mask_prob.mean():.4f}")
    
    # Convert to PIL grayscale mask
    mask_img = Image.fromarray((mask_prob * 255).astype(np.uint8), mode="L")
    
    # Resize mask back to original image dimensions
    mask_final = mask_img.resize((orig_w, orig_h), Image.BILINEAR)
    
    # Anti-aliasing: slight Gaussian blur to soften edges
    mask_final = mask_final.filter(ImageFilter.GaussianBlur(radius=0.75))
    
    # Apply mask as alpha channel
    result_img = image.convert("RGBA")
    result_img.putalpha(mask_final)
    
    return result_img


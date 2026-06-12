import os
import io
import time
import logging
from PIL import Image

logger = logging.getLogger(__name__)

_rembg_session = None
_rembg_model_name = "isnet-general-use"

def _get_rembg_session():
    global _rembg_session
    if _rembg_session is None:
        try:
            from rembg import new_session
            # Disable U2NET default download if we are using isnet
            logger.info(f"Loading rembg session with model: {_rembg_model_name}...")
            _rembg_session = new_session(_rembg_model_name)
            logger.info("Session loaded successfully.")
        except ImportError:
            raise RuntimeError("rembg is not installed. Please install it first.")
    return _rembg_session

def remove_background_rembg(image: Image.Image) -> Image.Image:
    from rembg import remove
    session = _get_rembg_session()
    
    logger.info(f"[{_rembg_model_name}] Starting background removal...")
    start_time = time.time()
    
    # Process image
    result = remove(
        image, 
        session=session,
        alpha_matting=True, # Enable alpha matting for better edges (hair/feathers)
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=10,
        alpha_matting_erode_size=10
    )
    
    elapsed = time.time() - start_time
    logger.info(f"[{_rembg_model_name}] Finished in {elapsed:.2f}s")
    
    return result

"""
GPU Accelerator Abstraction Layer.
Dynamically detects NVIDIA CUDA hardware and CuPy.
If installed, routes heavy matrix operations to VRAM.
If not, flags availability so the app can fallback to CPU multithreading.
"""
import logging
import numpy as np

logger = logging.getLogger(__name__)

class GPUAccelerator:
    _instance = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        # Route to CUDA only after CuPy and a working CUDA runtime are verified.
        # Otherwise ImageComparator can use the Rust implementation or OpenCV.
        self.is_available = False
        self.backend = "cpu"
        self.device_name = "CPU"
        self.plugin_size_mb = 0

        try:
            import cupy as cp
            if cp.cuda.is_available():
                # Xác minh NVRTC compile được (đủ CUDA Toolkit) mới dùng GPU thật.
                _ = cp.array([1, 2, 3]) * 2
                self.cp = cp
                self.is_available = True
                self.backend = "nvidia_cuda"
                self.plugin_size_mb = 2048
                try:
                    props = cp.cuda.runtime.getDeviceProperties(0)
                    if hasattr(props, 'name'):
                        self.device_name = props['name'].decode('utf-8')
                except Exception:
                    pass
                logger.info(f"🚀 GPU Acceleration ENABLED (CuPy): {self.device_name}")
        except Exception:
            # Không có CuPy/CUDA → vẫn "kích hoạt" nhưng compute_diff_mask dùng cv2 (CPU).
            logger.info("GPU plugin (CuPy) not present → dùng CPU fallback trong compute_diff_mask.")

    def compute_diff_mask(self, gray1: np.ndarray, gray2: np.ndarray, threshold_val: int) -> np.ndarray:
        """
        Compute absolute difference and threshold on GPU VRAM.
        Returns: binary mask (Host NumPy array)
        """
        if not self.is_available:
            raise RuntimeError("GPU core not loaded")
            
        # Safe fallback for UI Mock Simulation
        if not hasattr(self, 'cp'):
            import cv2
            diff_gray = cv2.absdiff(gray1, gray2)
            _, binary_mask = cv2.threshold(diff_gray, threshold_val, 255, cv2.THRESH_BINARY)
            return binary_mask
        
        # 1. Transfer matrices from Host RAM to VRAM
        g1 = self.cp.asarray(gray1, dtype=self.cp.int16)
        g2 = self.cp.asarray(gray2, dtype=self.cp.int16)
        
        # 2. Parallel Pixel subtraction & Thresholding (CUDA)
        diff = self.cp.abs(g1 - g2)
        binary_mask_gpu = self.cp.where(diff > threshold_val, self.cp.uint8(255), self.cp.uint8(0))
        
        # 3. Download Result back to Host RAM (for cv2 contours)
        return self.cp.asnumpy(binary_mask_gpu)

    def get_system_status(self) -> dict:
        return {
            "is_gpu_available": self.is_available,
            "current_backend": self.backend,
            "device_name": self.device_name,
            "plugin_size_mb": self.plugin_size_mb
        }

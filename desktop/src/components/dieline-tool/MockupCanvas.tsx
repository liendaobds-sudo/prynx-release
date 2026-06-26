// ============================================================
// MockupCanvas — Bao Canvas R3F + tone mapping + WebGL guard
//
// Component vỏ (shell) của lớp render mockup 3D. Nhiệm vụ:
//   1. Phát hiện hỗ trợ WebGL qua `useWebGLSupport`; nếu trình
//      duyệt KHÔNG hỗ trợ thì render `WebGLFallback` thay vì
//      `Canvas`, giữ ứng dụng phản hồi và không treo (Yêu cầu 8.4).
//   2. Cấu hình renderer với tone mapping `ACESFilmicToneMapping`
//      và color space sRGB cho TOÀN BỘ khung hình (Yêu cầu 3.4),
//      tạo nền tảng cho IBL/HDRI và vật liệu PBR chân thực.
//
// Component KHÔNG tự dựng cảnh; nó chỉ bao `Canvas` và render
// `children` (Environment, Camera, panels, shadow, overlay…) do
// component cha truyền vào. Cách này giữ MockupCanvas thuần về
// trách nhiệm "vỏ canvas + guard + renderer config", dễ kiểm thử
// wiring bằng smoke test.
//
// _Requirements: 3.4, 8.4_
// ============================================================

import React, { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import type { CameraProps } from '@react-three/fiber';
import * as THREE from 'three';
import { useWebGLSupport } from './useWebGLSupport';
import WebGLFallback from './WebGLFallback';
import { useMockupStore } from '../../store/useMockupStore';

export interface MockupCanvasProps {
    /** Nội dung cảnh 3D (Environment, Camera, panels, shadow, overlay…). */
    children?: React.ReactNode;
    /** Cấu hình camera khởi tạo cho `Canvas`. */
    camera?: CameraProps;
    /** Màu/biểu thức nền của phần tử canvas (CSS background). */
    background?: string;
    /** Class CSS bổ sung cho phần tử bao ngoài. */
    className?: string;
    /** Style nội tuyến bổ sung cho phần tử bao ngoài. */
    style?: React.CSSProperties;
    /** Thông báo tuỳ biến hiển thị khi WebGL không khả dụng. */
    fallbackMessage?: string;
}

/** Phơi sáng tone mapping mặc định cho cảnh studio. */
const DEFAULT_TONE_MAPPING_EXPOSURE = 1.0;

/**
 * Vỏ Canvas cho mockup 3D: guard WebGL + tone mapping ACES Filmic.
 */
export default function MockupCanvas({
    children,
    camera,
    background = '#0A0A0A',
    className,
    style,
    fallbackMessage,
}: MockupCanvasProps) {
    const { supported } = useWebGLSupport();
    const setWebglSupported = useMockupStore((s) => s.setWebglSupported);

    // Đồng bộ cờ hỗ trợ WebGL vào store khi phát hiện xong (Yêu cầu 8.4).
    useEffect(() => {
        if (supported !== null) {
            setWebglSupported(supported);
        }
    }, [supported, setWebglSupported]);

    // Chưa phát hiện xong (lần render đầu, trước khi effect chạy):
    // hiển thị trạng thái chờ thay vì cố tạo WebGL context vội.
    if (supported === null) {
        return (
            <div
                className={className ?? 'dt-scene-loading'}
                style={style}
                role="status"
                aria-live="polite"
            >
                <p>Đang kiểm tra hỗ trợ đồ hoạ…</p>
            </div>
        );
    }

    // Trình duyệt không hỗ trợ WebGL → render fallback, app vẫn phản hồi.
    if (supported === false) {
        return <WebGLFallback message={fallbackMessage} />;
    }

    // Hỗ trợ WebGL → dựng Canvas với renderer cấu hình tone mapping ACES.
    return (
        <div
            className={className ?? 'dt-scene-3d-container'}
            style={{ position: 'relative', ...style }}
        >
            <Canvas
                shadows
                camera={camera}
                style={{ background }}
                gl={{
                    antialias: true,
                    alpha: true,
                    preserveDrawingBuffer: true, // cần cho xuất ảnh PNG phía client
                    toneMapping: THREE.ACESFilmicToneMapping,
                    toneMappingExposure: DEFAULT_TONE_MAPPING_EXPOSURE,
                    outputColorSpace: THREE.SRGBColorSpace,
                }}
                onCreated={({ gl }) => {
                    // Đặt lại tường minh trên renderer để bảo đảm tone mapping
                    // áp dụng cho toàn bộ khung hình, không phụ thuộc mặc định
                    // của phiên bản three/r3f (Yêu cầu 3.4).
                    gl.toneMapping = THREE.ACESFilmicToneMapping;
                    gl.toneMappingExposure = DEFAULT_TONE_MAPPING_EXPOSURE;
                    gl.outputColorSpace = THREE.SRGBColorSpace;
                }}
            >
                {children}
            </Canvas>
        </div>
    );
}

// ============================================================
// useWebGLSupport — Phát hiện hỗ trợ WebGL (Render Layer)
//
// Hook phía render kiểm tra trình duyệt có khả năng tạo WebGL
// context hay không. Trả về cờ `supported` để lớp render quyết
// định mount `Canvas` (khi hỗ trợ) hoặc hiển thị UI fallback
// (khi không hỗ trợ), giữ cho ứng dụng vẫn phản hồi, không treo.
//
// _Requirements: 8.4_
// ============================================================

import { useState, useEffect } from 'react';

/**
 * Kiểm tra đồng bộ khả năng tạo WebGL context của trình duyệt.
 *
 * Thử tạo `webgl` (WebGL 1) rồi `experimental-webgl` trên một
 * canvas tạm. Mọi exception (môi trường không có DOM, GPU bị chặn,
 * context bị từ chối) đều được nuốt và coi là KHÔNG hỗ trợ — hàm
 * không bao giờ ném lỗi (Yêu cầu 8.4: app không treo).
 *
 * Tách riêng để có thể tái sử dụng/kiểm thử ngoài React.
 *
 * @returns `true` nếu lấy được WebGL context, ngược lại `false`.
 */
export function detectWebGLSupport(): boolean {
    // Môi trường không có DOM (SSR, test node thuần) → coi như không hỗ trợ.
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return false;
    }

    try {
        const canvas = document.createElement('canvas');
        if (!canvas || typeof canvas.getContext !== 'function') {
            return false;
        }

        // WebGL 1 chuẩn, sau đó fallback sang biến thể experimental.
        const gl =
            canvas.getContext('webgl') ||
            canvas.getContext('experimental-webgl');

        return gl != null;
    } catch {
        // Một số trình duyệt ném lỗi khi WebGL bị tắt — coi là không hỗ trợ.
        return false;
    }
}

/**
 * Kết quả của `useWebGLSupport`.
 * - `supported = null`: đang trong lần render đầu (chưa phát hiện xong).
 * - `supported = true | false`: đã phát hiện xong.
 */
export interface WebGLSupportState {
    /** `true` nếu trình duyệt hỗ trợ WebGL; `null` khi chưa phát hiện xong. */
    supported: boolean | null;
}

/**
 * Hook phát hiện hỗ trợ WebGL.
 *
 * Phát hiện chạy trong `useEffect` (chỉ phía client sau khi mount)
 * để tránh khác biệt khi render phía máy chủ. Trước khi phát hiện
 * xong, `supported` là `null`; lớp gọi nên coi `null` là "đang kiểm
 * tra" và chưa hiển thị fallback vội.
 *
 * @returns `{ supported }` — cờ hỗ trợ WebGL.
 */
export function useWebGLSupport(): WebGLSupportState {
    const [supported, setSupported] = useState<boolean | null>(null);

    useEffect(() => {
        setSupported(detectWebGLSupport());
    }, []);

    return { supported };
}

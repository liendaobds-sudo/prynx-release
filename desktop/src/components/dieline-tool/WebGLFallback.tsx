// ============================================================
// WebGLFallback — UI suy giảm khi trình duyệt không hỗ trợ WebGL
//
// Hiển thị thông báo rõ ràng cho người dùng biết trình duyệt
// không hỗ trợ WebGL nên không thể render mockup 3D. Giữ ứng dụng
// ở trạng thái phản hồi (không treo, không ném lỗi) và gợi ý dùng
// bản vẽ 2D thay thế.
//
// Dùng class CSS `dt-*` đồng nhất với các trạng thái khác của
// dieline-tool (ví dụ `dt-scene-loading`).
//
// _Requirements: 8.4_
// ============================================================

import React from 'react';

export interface WebGLFallbackProps {
    /** Thông báo tuỳ biến; mặc định nêu trình duyệt không hỗ trợ WebGL. */
    message?: string;
}

const DEFAULT_MESSAGE =
    'Trình duyệt của bạn không hỗ trợ WebGL nên không thể hiển thị mô phỏng 3D.';

/**
 * Khối UI fallback hiển thị khi `useWebGLSupport().supported === false`.
 */
export default function WebGLFallback({ message }: WebGLFallbackProps) {
    return (
        <div
            className="dt-scene-loading"
            role="alert"
            style={{ flexDirection: 'column', gap: '0.5rem', textAlign: 'center', padding: '1.5rem' }}
        >
            <span style={{ fontSize: '2rem' }} aria-hidden="true">🚫</span>
            <p>{message ?? DEFAULT_MESSAGE}</p>
            <p style={{ fontSize: '0.75rem', opacity: 0.6, maxWidth: '32ch' }}>
                Hãy thử bật tăng tốc phần cứng, cập nhật trình duyệt, hoặc dùng
                tab “Bản vẽ 2D” để tiếp tục làm việc.
            </p>
        </div>
    );
}

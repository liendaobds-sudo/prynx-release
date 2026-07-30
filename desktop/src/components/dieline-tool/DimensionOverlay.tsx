// ============================================================
// DimensionOverlay — Mockup 3D Realism (Render Layer / R3F)
//
// Overlay hiển thị kích thước hộp L×W×H trong không gian 3D bằng
// drei `Html`. Giá trị kích thước được làm tròn đến 0.1 mm thông qua
// hàm thuần `formatDimensions` (lib/mockup3d/dimensionFormat) — lớp
// render KHÔNG tự làm tròn để giữ toàn bộ logic ở logic layer.
//
// Hiển thị/ẩn do `useMockupStore.showDimensions` điều khiển (Yêu cầu 7.7).
// Kích thước đọc read-only từ `useBoxStore.dieline.params` (L, W, D);
// component KHÔNG sửa state dieline.
//
// Task 9.6.
// _Requirements: 7.7_
// ============================================================

import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import { useBoxStore } from '../../stores/useBoxStore';
import { useMockupStore } from '../../stores/useMockupStore';
import { formatDimensions } from '../../lib/mockup3d/dimensionFormat';
import type { BoxDimensions } from '../../lib/mockup3d/dimensionFormat';

interface DimensionOverlayProps {
    /**
     * Kích thước hộp (mm). Nếu không truyền, đọc từ `useBoxStore.dieline.params`
     * (L = chiều dài, W = chiều rộng, D = chiều cao/chiều sâu).
     */
    dimensions?: BoxDimensions;
    /**
     * Vị trí đặt nhãn trong không gian 3D. Mặc định đặt phía trên hộp,
     * tính theo bounding box của dieline.
     */
    position?: [number, number, number];
}

/**
 * Render overlay kích thước L×W×H bằng drei `Html`.
 *
 * Trả về `null` (không render gì) khi:
 *  - `showDimensions` tắt (Yêu cầu 7.7: chỉ hiển thị WHERE bật overlay), hoặc
 *  - không có dữ liệu kích thước (chưa có dieline và không truyền `dimensions`).
 */
export default function DimensionOverlay({ dimensions, position }: DimensionOverlayProps) {
    const showDimensions = useMockupStore((s) => s.showDimensions);
    const dieline = useBoxStore((s) => s.dieline);

    // Kích thước hiệu lực: ưu tiên prop, sau đó lấy từ params dieline.
    const effectiveDims = useMemo<BoxDimensions | null>(() => {
        if (dimensions) return dimensions;
        if (!dieline) return null;
        const { L, W, D } = dieline.params;
        return { length: L, width: W, height: D };
    }, [dimensions, dieline]);

    // Vị trí mặc định: phía trên đỉnh bounding box, canh giữa theo chiều rộng.
    const labelPosition = useMemo<[number, number, number]>(() => {
        if (position) return position;
        if (!dieline) return [0, 0, 0];
        const bb = dieline.boundingBox;
        return [0, bb.height / 2 + bb.height * 0.1, 0];
    }, [position, dieline]);

    if (!showDimensions || !effectiveDims) {
        return null;
    }

    const { label } = formatDimensions(effectiveDims);

    return (
        <Html position={labelPosition} center zIndexRange={[100, 0]}>
            <div
                className="dt-dimension-overlay"
                style={{
                    padding: '4px 10px',
                    borderRadius: '6px',
                    background: 'rgba(10, 10, 10, 0.78)',
                    color: '#f5f5f5',
                    font: '600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
                    letterSpacing: '0.02em',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                    userSelect: 'none',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                }}
            >
                {label}
            </div>
        </Html>
    );
}

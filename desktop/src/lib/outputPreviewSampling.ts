export interface OutputPreviewInkSample {
    channelPercentages: Record<string, number>;
    totalPercent: number;
    sampledPixels: number;
    diameterPx: number;
}

function clampUnit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

/**
 * UIUX (audit 2026-08-10 §OP.E1): tọa độ đã tháo xoay phải chuẩn hóa theo
 * kích thước trang chưa xoay, không theo AABB sau xoay 90°/270°.
 */
export function normalizePageHoverPosition(
    x: number,
    y: number,
    pageWidth: number,
    pageHeight: number,
): { x: number; y: number } {
    if (!(pageWidth > 0) || !(pageHeight > 0)) return { x: 0, y: 0 };
    return {
        x: clampUnit(x / pageWidth),
        y: clampUnit(y / pageHeight),
    };
}

/**
 * Lấy mẫu alpha của các kênh mực tại một điểm hoặc vùng tròn theo mm.
 * `sampleDiameterMm = 0` có nghĩa là đúng một pixel artifact.
 */
export function sampleOutputPreviewInk({
    arrays,
    width,
    height,
    xRatio,
    yRatio,
    renderDpi,
    sampleDiameterMm,
}: {
    arrays: Record<string, Uint8ClampedArray>;
    width: number;
    height: number;
    xRatio: number;
    yRatio: number;
    renderDpi: number;
    sampleDiameterMm: number;
}): OutputPreviewInkSample {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error('Kích thước artifact Separations không hợp lệ.');
    }
    if (!Number.isFinite(renderDpi) || renderDpi <= 0) {
        throw new Error('DPI artifact Separations không hợp lệ.');
    }
    if (!Number.isFinite(sampleDiameterMm) || sampleDiameterMm < 0) {
        throw new Error('Cỡ mẫu phải là số mm không âm.');
    }

    const pixelCount = width * height;
    for (const [name, alpha] of Object.entries(arrays)) {
        if (alpha.length !== pixelCount) {
            throw new Error(`Kênh ${name} không khớp kích thước artifact.`);
        }
    }

    const centerX = clampUnit(xRatio) * (width - 1);
    const centerY = clampUnit(yRatio) * (height - 1);
    const diameterPx = sampleDiameterMm === 0
        ? 1
        : Math.max(1, sampleDiameterMm * renderDpi / 25.4);
    const indices: number[] = [];

    if (sampleDiameterMm === 0) {
        indices.push(Math.round(centerY) * width + Math.round(centerX));
    } else {
        const radius = diameterPx / 2;
        const minX = Math.max(0, Math.floor(centerX - radius));
        const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
        const minY = Math.max(0, Math.floor(centerY - radius));
        const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
        const radiusSquared = radius * radius;
        for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
                const dx = x - centerX;
                const dy = y - centerY;
                if (dx * dx + dy * dy <= radiusSquared) indices.push(y * width + x);
            }
        }
        if (indices.length === 0) {
            indices.push(Math.round(centerY) * width + Math.round(centerX));
        }
    }

    const channelPercentages: Record<string, number> = {};
    let totalRaw = 0;
    for (const [name, alpha] of Object.entries(arrays)) {
        let alphaTotal = 0;
        for (const index of indices) alphaTotal += alpha[index];
        const percentage = alphaTotal / indices.length / 255 * 100;
        channelPercentages[name] = Math.round(percentage);
        totalRaw += percentage;
    }

    return {
        channelPercentages,
        totalPercent: Math.round(totalRaw),
        sampledPixels: indices.length,
        diameterPx,
    };
}

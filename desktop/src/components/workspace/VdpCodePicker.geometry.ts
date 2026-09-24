export type BBox = readonly [number, number, number, number];

export interface PickerRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type VdpPickerObjectType = 'text' | 'image' | 'vector';

export interface VdpPickerObject {
    id: string;
    drawIndex: number;
    type: VdpPickerObjectType;
    bbox: BBox;
    /** Optional layer ids retained for display/debug only; never used for auto-grouping. */
    ocgIds?: readonly (string | number)[];
    matrix?: readonly number[];
    label?: string;
    /** Danh sách drawIndex thành viên gom cụm (áp dụng cho nhóm thanh barcode/clipmask). */
    memberDrawIndices?: readonly number[];
}

export function rectFromBbox(bbox: BBox, scale = 1): PickerRect {
    const [x, y, width, height] = bbox;
    return {
        x: Math.min(x, x + width) * scale,
        y: Math.min(y, y + height) * scale,
        width: Math.abs(width) * scale,
        height: Math.abs(height) * scale,
    };
}

export function normalizeRect(startX: number, startY: number, endX: number, endY: number): PickerRect {
    return {
        x: Math.min(startX, endX),
        y: Math.min(startY, endY),
        width: Math.abs(endX - startX),
        height: Math.abs(endY - startY),
    };
}

/** A selection must contain the complete object, preventing partial barcode/image deletion. */
export function rectFullyContains(container: PickerRect, object: PickerRect, epsilon = 0.5): boolean {
    return (
        object.x >= container.x - epsilon &&
        object.y >= container.y - epsilon &&
        object.x + object.width <= container.x + container.width + epsilon &&
        object.y + object.height <= container.y + container.height + epsilon
    );
}

export function rectsIntersect(a: PickerRect, b: PickerRect): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function isBackgroundImage(
    rect: PickerRect,
    pageSize: { width: number; height: number } | undefined,
    threshold = 0.92,
): boolean {
    if (!pageSize || pageSize.width <= 0 || pageSize.height <= 0) return false;
    const page = { x: 0, y: 0, width: pageSize.width, height: pageSize.height };
    const coversWidth = rect.width >= page.width * threshold;
    const coversHeight = rect.height >= page.height * threshold;
    const reachesPage = rect.x <= page.x + 1 && rect.y <= page.y + 1;
    return coversWidth && coversHeight && reachesPage;
}

/**
 * Kiểm tra xem một đối tượng hình học có phải là khung nền, card bố cục,
 * hoặc đường kẻ phân cách trang trí không (tránh gợi ý rác che kín tài liệu).
 */
export function isDecorativeOrContainer(
    rect: PickerRect,
    pageSize?: { width: number; height: number },
): boolean {
    // 1. Quá nhỏ (nhiễu điểm ảnh)
    if (rect.width < 2 && rect.height < 2) {
        return true;
    }

    // 2. Đường kẻ phân cách cực mảnh (separator lines, border rules)
    const maxDim = Math.max(rect.width, rect.height);
    const minDim = Math.min(rect.width, rect.height);
    if (minDim > 0 && maxDim / minDim > 25 && minDim <= 3.5) {
        return true;
    }

    if (pageSize && pageSize.width > 0 && pageSize.height > 0) {
        const pageArea = pageSize.width * pageSize.height;
        const rectArea = rect.width * rect.height;

        // 3. Khung nền / card / container lớn: chiếm > 65% diện tích trang hoặc > 12% trang nếu kích thước lớn (> 180pt)
        if (rectArea > pageArea * 0.65 || (rectArea > pageArea * 0.12 && (rect.width > 180 || rect.height > 180))) {
            return true;
        }

        // 4. Thanh phân trang hoặc banner dài (dẹt) chiếm > 85% một chiều của trang
        const isElongated = maxDim / (minDim || 1) >= 2.5;
        if (isElongated && (rect.width >= pageSize.width * 0.85 || rect.height >= pageSize.height * 0.85)) {
            return true;
        }

        // 5. Container dạng thẻ (card) chiếm > 45% cả 2 chiều trang và kích thước lớn (> 100pt)
        if ((rect.width > 100 || rect.height > 100) && rect.width >= pageSize.width * 0.45 && rect.height >= pageSize.height * 0.45) {
            return true;
        }
    }

    return false;
}

interface BarCandidate {
    obj: VdpPickerObject;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    w: number;
    h: number;
    isVertical: boolean;
}

function parseBarCandidate(obj: VdpPickerObject): BarCandidate | null {
    if (obj.type !== 'vector') return null;
    const [x, y, w, h] = obj.bbox;
    const absW = Math.abs(w);
    const absH = Math.abs(h);
    const x0 = Math.min(x, x + w);
    const y0 = Math.min(y, y + h);
    const x1 = x0 + absW;
    const y1 = y0 + absH;

    // Thanh dọc (mã vạch chuẩn đứng)
    if (absH >= 8 && absH <= 300 && absW >= 0.2 && absW <= 12 && absH / absW >= 1.8) {
        return { obj, x0, y0, x1, y1, w: absW, h: absH, isVertical: true };
    }
    // Thanh ngang (mã vạch xoay 90 độ)
    if (absW >= 8 && absW <= 300 && absH >= 0.2 && absH <= 12 && absW / absH >= 1.8) {
        return { obj, x0, y0, x1, y1, w: absW, h: absH, isVertical: false };
    }
    return null;
}

/**
 * Gom cụm các thanh vector song song kề nhau (nhóm thanh barcode hoặc clipmask)
 * thành một đối tượng mã vạch duy nhất, đồng thời lọc các khung nền/đường kẻ rác.
 */
export function clusterBarcodeBars(
    objects: readonly VdpPickerObject[],
    pageSize?: { width: number; height: number },
): VdpPickerObject[] {
    const barCandidates: BarCandidate[] = [];
    const nonBarObjects: VdpPickerObject[] = [];

    for (const obj of objects) {
        const candidate = parseBarCandidate(obj);
        if (candidate) {
            barCandidates.push(candidate);
        } else {
            nonBarObjects.push(obj);
        }
    }

    // Tách thanh dọc và thanh ngang
    const verticalBars = barCandidates.filter((b) => b.isVertical).sort((a, b) => a.x0 - b.x0);
    const horizontalBars = barCandidates.filter((b) => !b.isVertical).sort((a, b) => a.y0 - b.y0);

    const clusters: BarCandidate[][] = [];

    // 1. Gom cụm thanh dọc
    const visitedVert = new Set<string>();
    for (let i = 0; i < verticalBars.length; i++) {
        const barA = verticalBars[i];
        if (visitedVert.has(barA.obj.id)) continue;
        const currentCluster: BarCandidate[] = [barA];
        visitedVert.add(barA.obj.id);

        for (let j = i + 1; j < verticalBars.length; j++) {
            const barB = verticalBars[j];
            if (visitedVert.has(barB.obj.id)) continue;

            const lastBar = currentCluster[currentCluster.length - 1];
            const gap = barB.x0 - lastBar.x1;
            const maxGap = Math.max(16, Math.min(lastBar.h, barB.h) * 0.45);
            if (gap > maxGap) {
                // Khoảng cách theo phương ngang quá xa -> hết cụm mã vạch
                break;
            }

            // Kiểm tra độ tương đồng chiều cao và độ chồng lấn phương đứng (Y)
            const minH = Math.min(lastBar.h, barB.h);
            const maxH = Math.max(lastBar.h, barB.h);
            const overlapY = Math.max(0, Math.min(lastBar.y1, barB.y1) - Math.max(lastBar.y0, barB.y0));

            if (minH / maxH >= 0.55 && overlapY >= minH * 0.55) {
                currentCluster.push(barB);
                visitedVert.add(barB.obj.id);
            }
        }
        if (currentCluster.length >= 3) {
            clusters.push(currentCluster);
        }
    }

    // 2. Gom cụm thanh ngang (mã vạch xoay 90 độ)
    const visitedHoriz = new Set<string>();
    for (let i = 0; i < horizontalBars.length; i++) {
        const barA = horizontalBars[i];
        if (visitedHoriz.has(barA.obj.id)) continue;
        const currentCluster: BarCandidate[] = [barA];
        visitedHoriz.add(barA.obj.id);

        for (let j = i + 1; j < horizontalBars.length; j++) {
            const barB = horizontalBars[j];
            if (visitedHoriz.has(barB.obj.id)) continue;

            const lastBar = currentCluster[currentCluster.length - 1];
            const gap = barB.y0 - lastBar.y1;
            const maxGap = Math.max(16, Math.min(lastBar.w, barB.w) * 0.45);
            if (gap > maxGap) {
                break;
            }

            const minW = Math.min(lastBar.w, barB.w);
            const maxW = Math.max(lastBar.w, barB.w);
            const overlapX = Math.max(0, Math.min(lastBar.x1, barB.x1) - Math.max(lastBar.x0, barB.x0));

            if (minW / maxW >= 0.55 && overlapX >= minW * 0.55) {
                currentCluster.push(barB);
                visitedHoriz.add(barB.obj.id);
            }
        }
        if (currentCluster.length >= 3) {
            clusters.push(currentCluster);
        }
    }

    const clusteredBarIds = new Set<string>();
    const compositeBarcodeObjects: VdpPickerObject[] = [];

    // 3. Tạo composite object cho từng cụm mã vạch
    for (const cluster of clusters) {
        cluster.forEach((b) => clusteredBarIds.add(b.obj.id));
        const minX = Math.min(...cluster.map((b) => b.x0));
        const minY = Math.min(...cluster.map((b) => b.y0));
        const maxX = Math.max(...cluster.map((b) => b.x1));
        const maxY = Math.max(...cluster.map((b) => b.y1));
        const memberDrawIndices = cluster.map((b) => b.obj.drawIndex);

        // Kiểm tra xem có khung nền / clipmask bao quanh cụm mã vạch này không
        const clusterW = maxX - minX;
        const clusterH = maxY - minY;
        const minDraw = Math.min(...memberDrawIndices);
        const maxDraw = Math.max(...memberDrawIndices);

        for (const candidate of nonBarObjects) {
            if (candidate.type !== 'vector') continue;
            const [cx, cy, cw, ch] = candidate.bbox;
            const cx0 = Math.min(cx, cx + cw);
            const cy0 = Math.min(cy, cy + ch);
            const cx1 = cx0 + Math.abs(cw);
            const cy1 = cy0 + Math.abs(ch);
            const cArea = (cx1 - cx0) * (cy1 - cy0);
            const barcodeArea = clusterW * clusterH;

            // Khung bao kề quanh mã vạch (margin <= 15pt) và diện tích <= 1.6x
            if (
                cx0 <= minX + 5 &&
                cy0 <= minY + 5 &&
                cx1 >= maxX - 5 &&
                cy1 >= maxY - 5 &&
                cArea <= barcodeArea * 1.6 &&
                Math.min(Math.abs(candidate.drawIndex - minDraw), Math.abs(candidate.drawIndex - maxDraw)) <= 6
            ) {
                if (!memberDrawIndices.includes(candidate.drawIndex)) {
                    memberDrawIndices.push(candidate.drawIndex);
                    clusteredBarIds.add(candidate.id);
                }
            }
        }

        const primary = cluster[0].obj;
        compositeBarcodeObjects.push({
            id: `barcode-cluster-${primary.id}`,
            drawIndex: primary.drawIndex,
            type: 'vector',
            bbox: [minX, minY, clusterW, clusterH],
            label: `Mã vạch (${cluster.length} thanh)`,
            memberDrawIndices,
        });
    }

    // 4. Lọc các đối tượng còn lại:
    // - Vector: TUYỆT ĐỐI KHÔNG nhận vector đơn lẻ (khung nền, card, viền bo góc, dòng kẻ chấm...).
    //   Chỉ các cụm vector song song đủ chuẩn barcode (compositeBarcodeObjects) mới được công nhận là mã vạch.
    // - Ảnh: chỉ nhận ảnh raster có kích thước và tỷ lệ phù hợp với mã QR (gần vuông) hoặc mã vạch (hình chữ nhật dẹt),
    //   loại bỏ ảnh nền, ảnh khổng lồ, ảnh dải phân cách hoặc ảnh quá bé.
    const result: VdpPickerObject[] = [...compositeBarcodeObjects];

    for (const obj of objects) {
        if (clusteredBarIds.has(obj.id)) continue;
        if (obj.type === 'vector') {
            // Đối tượng vector đơn lẻ không thuộc cụm barcode -> bỏ qua hoàn toàn
            continue;
        }

        if (obj.type === 'image') {
            const rect = rectFromBbox(obj.bbox, 1);
            if (isBackgroundImage(rect, pageSize) || rect.width < 12 || rect.height < 12) continue;
            if (isDecorativeOrContainer(rect, pageSize)) continue;

            const ratio = rect.height > 0 ? rect.width / rect.height : 1;
            // Tỷ lệ cho QR code: gần vuông (0.70 - 1.45)
            const isQrRatio = ratio >= 0.70 && ratio <= 1.45;
            // Tỷ lệ cho Barcode raster: dẹt ngang (1.35 - 8.0) hoặc dẹt đứng (0.12 - 0.70)
            const isBarcodeRatio = (ratio >= 1.35 && ratio <= 8.0) || (ratio >= 0.12 && ratio <= 0.70);

            // Bỏ qua các ảnh không có tỷ lệ của QR hay Barcode (ví dụ ảnh banner dài 15:1, hoặc ảnh không chuẩn)
            if (!isQrRatio && !isBarcodeRatio) continue;

            result.push({
                ...obj,
                label: isQrRatio ? 'Mã QR (Ảnh)' : 'Mã vạch (Ảnh)',
            });
        }
    }

    return result;
}

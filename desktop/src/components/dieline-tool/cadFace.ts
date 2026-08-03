import * as THREE from 'three';

/**
 * Trích các đoạn CAD và đặt chúng lên đúng cap vật lý chứa mặt ngoài của panel.
 * Mỗi cặp điểm liên tiếp tạo thành một đoạn cho drei `<Line segments>`.
 */
export function bufferToCadFaceSegPoints(
    geo: THREE.BufferGeometry | null,
    offsetZ: number,
    outerFaceNegativeZ: boolean,
): [number, number, number][] {
    const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count === 0) return [];

    const cadFaceZ = outerFaceNegativeZ ? -offsetZ : offsetZ;
    const out: [number, number, number][] = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
        out[i] = [pos.getX(i), pos.getY(i), cadFaceZ];
    }
    return out;
}

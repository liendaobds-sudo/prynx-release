// ============================================================
// ShadowFloor — Mockup 3D Realism (Render Layer)
//
// Render bóng đổ mềm / contact shadow tại vùng chân hộp tiếp giáp
// mặt nền (Yêu cầu 3.5) và cung cấp ≥2 preset nền/sàn. Preset đang
// chọn được lấy từ `useMockupStore.backgroundPreset` và GIỮ NGUYÊN
// cho đến khi người dùng chọn preset khác (Yêu cầu 7.3, 7.4) — tính
// bền vững do bản thân store nắm giữ, component chỉ phản chiếu state.
//
// Dùng drei `ContactShadows` (thuộc ngăn xếp three/r3f/drei — Yêu cầu
// 9.6). Component này phải được đặt BÊN TRONG `<Canvas>`.
//
// _Requirements: 3.5, 7.3, 7.4_
// ============================================================

import React, { useEffect, useMemo } from 'react';
import { ContactShadows } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useMockupStore } from '../../store/useMockupStore';

// ─── Định nghĩa preset nền/sàn ──────────────────────────────────────────────

/**
 * Mô tả một preset nền/sàn cho cảnh mockup.
 * - `backgroundColor`: màu nền của cảnh (scene background).
 * - `floorColor`/`floorRoughness`/`floorMetalness`: vật liệu mặt sàn.
 * - `shadowColor`/`shadowOpacity`/`shadowBlur`: tham số contact shadow.
 */
export interface BackgroundPreset {
    id: string;
    label: string;
    backgroundColor: string;
    /**
     * Nền radial gradient (inner→outer), lấy cảm hứng img2threejs showcase
     * product stage — sinh CanvasTexture local, 0 mạng.
     */
    backgroundGradient?: { inner: string; outer: string };
    floorColor: string;
    floorRoughness: number;
    floorMetalness: number;
    /** true = sàn ShadowMaterial trong suốt (chỉ bóng), kiểu product turntable. */
    floorShadowOnly?: boolean;
    shadowColor: string;
    shadowOpacity: number;
    shadowBlur: number;
}

/**
 * Thư viện preset nền/sàn — tối thiểu 2 preset (Yêu cầu 7.3).
 * Bổ sung stage product (tối/xám mềm/cool/warm) tham khảo showcase lookdev.
 */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
    {
        id: 'studio-white',
        label: 'Studio Trắng',
        backgroundColor: '#f3f4f6',
        floorColor: '#ffffff',
        floorRoughness: 0.85,
        floorMetalness: 0.0,
        shadowColor: '#000000',
        shadowOpacity: 0.42,
        shadowBlur: 2.6,
    },
    {
        id: 'studio-dark',
        label: 'Studio Tối',
        backgroundColor: '#0a0a0a',
        floorColor: '#15161a',
        floorRoughness: 0.6,
        floorMetalness: 0.1,
        shadowColor: '#000000',
        shadowOpacity: 0.6,
        shadowBlur: 2.0,
    },
    {
        id: 'neutral-gray',
        label: 'Xám Trung Tính',
        backgroundColor: '#9ca3af',
        floorColor: '#d1d5db',
        floorRoughness: 0.9,
        floorMetalness: 0.0,
        shadowColor: '#1f2937',
        shadowOpacity: 0.45,
        shadowBlur: 2.8,
    },
    {
        id: 'warm-gradient',
        label: 'Nền Ấm',
        backgroundColor: '#e8d5c0',
        floorColor: '#f0e6d8',
        floorRoughness: 0.88,
        floorMetalness: 0.0,
        shadowColor: '#4b3621',
        shadowOpacity: 0.4,
        shadowBlur: 3.0,
    },
    // ── Showcase-inspired product stages (offline canvas gradient) ──
    {
        id: 'product-black',
        label: 'Product tối',
        backgroundColor: '#0a0a0a',
        backgroundGradient: { inner: '#1a1c22', outer: '#050506' },
        floorColor: '#0e0f12',
        floorRoughness: 0.75,
        floorMetalness: 0.08,
        floorShadowOnly: true,
        shadowColor: '#000000',
        shadowOpacity: 0.55,
        shadowBlur: 2.4,
    },
    {
        id: 'soft-gray-stage',
        label: 'Studio xám mềm',
        backgroundColor: '#eceded',
        backgroundGradient: { inner: '#f7f8f9', outer: '#cfd3d8' },
        floorColor: '#e6e8eb',
        floorRoughness: 0.9,
        floorMetalness: 0.0,
        shadowColor: '#1a1a1a',
        shadowOpacity: 0.28,
        shadowBlur: 3.2,
    },
    {
        id: 'cool-infinite',
        label: 'Infinite cool',
        backgroundColor: '#c5d0dc',
        backgroundGradient: { inner: '#eaf0f7', outer: '#8fa3b8' },
        floorColor: '#d0dae6',
        floorRoughness: 0.88,
        floorMetalness: 0.0,
        shadowColor: '#243040',
        shadowOpacity: 0.35,
        shadowBlur: 2.8,
    },
    {
        id: 'warm-product',
        label: 'Warm product',
        backgroundColor: '#e8d5c0',
        backgroundGradient: { inner: '#f6ebe0', outer: '#c4a88a' },
        floorColor: '#efe0d0',
        floorRoughness: 0.86,
        floorMetalness: 0.0,
        shadowColor: '#4b3621',
        shadowOpacity: 0.38,
        shadowBlur: 3.0,
    },
    {
        id: 'cyclorama-white',
        label: 'Cyclorama trắng',
        backgroundColor: '#f5f5f5',
        backgroundGradient: { inner: '#ffffff', outer: '#e2e4e8' },
        floorColor: '#fafafa',
        floorRoughness: 0.92,
        floorMetalness: 0.0,
        floorShadowOnly: true,
        shadowColor: '#000000',
        shadowOpacity: 0.22,
        shadowBlur: 3.5,
    },
] as const;

/** Id preset mặc định (khớp `DEFAULT_BACKGROUND_PRESET` của store). */
export const DEFAULT_BACKGROUND_PRESET_ID = BACKGROUND_PRESETS[0].id;

/**
 * Phân giải id → preset. Id không hợp lệ/không xác định → preset mặc định,
 * bảo đảm cảnh luôn render được (không treo).
 */
export function getBackgroundPreset(id: string | undefined | null): BackgroundPreset {
    return BACKGROUND_PRESETS.find((p) => p.id === id) ?? BACKGROUND_PRESETS[0];
}

/** Độ sáng tương đối (0..1) của màu hex `#rrggbb` để chọn màu lưới tương phản. */
function hexLuminance(hex: string): number {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return 0.5;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Lưới sàn một cấp nét. Không dùng THREE.GridHelper vì helper đó vẽ riêng
 * đường tâm và đường ô, dễ trông như hai lớp lưới khi nhìn ở góc xiên.
 */
function SingleLayerFloorGrid({
    size,
    divisions,
    y,
    color,
}: {
    size: number;
    divisions: number;
    y: number;
    color: string;
}) {
    const geometry = useMemo(() => {
        const half = size / 2;
        const step = size / divisions;
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= divisions; i += 1) {
            const offset = -half + i * step;
            points.push(
                new THREE.Vector3(offset, 0, -half),
                new THREE.Vector3(offset, 0, half),
                new THREE.Vector3(-half, 0, offset),
                new THREE.Vector3(half, 0, offset),
            );
        }
        return new THREE.BufferGeometry().setFromPoints(points);
    }, [size, divisions]);

    useEffect(() => () => geometry.dispose(), [geometry]);

    return (
        <lineSegments geometry={geometry} position={[0, y, 0]} renderOrder={2}>
            <lineBasicMaterial
                color={color}
                transparent
                opacity={0.55}
                depthWrite={false}
                toneMapped={false}
            />
        </lineSegments>
    );
}
// ─── Component ───────────────────────────────────────────────────────────────

export interface ShadowFloorProps {
    /** Cao độ mặt sàn theo trục Y (mm). Mặc định 0 = chân hộp. */
    floorY?: number;
    /**
     * Kích thước vùng sàn/bóng (mm). Nên truyền theo bao của hộp để bóng
     * phủ đủ chân hộp. Mặc định 1000.
     */
    size?: number;
    /**
     * Có đặt màu nền cho cảnh hay không. Mặc định `true`. Tắt khi muốn
     * môi trường HDRI/component khác kiểm soát nền.
     */
    applyBackground?: boolean;
    /** Có render mặt sàn đặc (nhận bóng) hay không. Mặc định `true`. */
    showFloorPlane?: boolean;
    /** Lưới đo kỹ thuật trên sàn; mặc định tắt cho chế độ mockup sạch. */
    showGrid?: boolean;
    /** Đổi giá trị để chụp lại bóng một lần sau khi hình học hộp đã ổn định. */
    shadowRevision?: string | number;
}

/**
 * ShadowFloor — bóng tiếp xúc mềm tại chân hộp + nền/sàn theo preset.
 *
 * Đặt component này bên trong `<Canvas>` của `DielineScene3D`. Preset
 * được đọc từ `useMockupStore`; khi người dùng đổi preset qua
 * `setBackgroundPreset`, cảnh cập nhật tương ứng và giữ nguyên cho đến
 * lần đổi kế tiếp (Yêu cầu 7.4).
 */
export default function ShadowFloor({
    floorY = 0,
    size = 1000,
    applyBackground = true,
    showFloorPlane = true,
    showGrid = false,
    shadowRevision = 0,
}: ShadowFloorProps) {
    const backgroundPreset = useMockupStore((s) => s.backgroundPreset);
    const preset = useMemo(() => getBackgroundPreset(backgroundPreset), [backgroundPreset]);

    // Đặt nền scene: solid Color hoặc CanvasTexture radial (showcase-style).
    // Không dùng `<color attach="background">` trong <group>. Khôi phục khi unmount.
    const scene = useThree((s) => s.scene);
    useEffect(() => {
        if (!applyBackground) return;
        const prev = scene.background;
        let tex: THREE.CanvasTexture | null = null;
        if (preset.backgroundGradient) {
            const sizePx = 512;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = sizePx;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const g = ctx.createRadialGradient(
                    sizePx * 0.5, sizePx * 0.42, sizePx * 0.05,
                    sizePx * 0.5, sizePx * 0.5, sizePx * 0.72,
                );
                g.addColorStop(0, preset.backgroundGradient.inner);
                g.addColorStop(1, preset.backgroundGradient.outer);
                ctx.fillStyle = g;
                ctx.fillRect(0, 0, sizePx, sizePx);
                tex = new THREE.CanvasTexture(canvas);
                tex.colorSpace = THREE.SRGBColorSpace;
                scene.background = tex;
            } else {
                scene.background = new THREE.Color(preset.backgroundColor);
            }
        } else {
            scene.background = new THREE.Color(preset.backgroundColor);
        }
        return () => {
            scene.background = prev;
            tex?.dispose();
        };
    }, [scene, applyBackground, preset.backgroundColor, preset.backgroundGradient]);

    // Bóng tiếp xúc nên hơi rộng hơn chân hộp để mép bóng mềm tự nhiên.
    const shadowScale = size * 1.4;
    const floorSize = size * 3;

    // Giới hạn mật độ để tránh moiré/nhấp nháy ở góc camera xiên.
    const divisions = Math.max(8, Math.min(32, Math.round(floorSize / Math.max(10, size / 12))));
    const dark = hexLuminance(preset.backgroundColor) < 0.5;
    const gridColor = dark ? '#2c3138' : '#d2d8e0';
    const shadowLift = Math.max(0.08, size * 0.0005);
    const gridLift = shadowLift + Math.max(0.04, size * 0.0002);

    return (
        <group name="mockup-floor">
            {/* Soft/contact shadow tại chân hộp tiếp giáp mặt nền (Yêu cầu 3.5) */}
            <ContactShadows
                key={shadowRevision}
                position={[0, floorY + shadowLift, 0]}
                scale={shadowScale}
                resolution={512}
                far={size}
                blur={preset.shadowBlur}
                opacity={preset.shadowOpacity}
                color={preset.shadowColor}
                frames={1}
                smooth
                depthWrite={false}
            />

            {/* Mặt sàn đặc hoặc ShadowMaterial (product turntable) */}
            {showFloorPlane && (
                <mesh
                    rotation={[-Math.PI / 2, 0, 0]}
                    position={[0, floorY, 0]}
                    receiveShadow
                >
                    <planeGeometry args={[floorSize, floorSize]} />
                    {preset.floorShadowOnly ? (
                        <shadowMaterial opacity={Math.min(0.35, preset.shadowOpacity * 0.6)} />
                    ) : (
                        <meshStandardMaterial
                            color={preset.floorColor}
                            roughness={preset.floorRoughness}
                            metalness={preset.floorMetalness}
                            side={THREE.FrontSide}
                        />
                    )}
                </mesh>
            )}

            {/* Lưới chỉ dành cho kiểm tra kỹ thuật, không phủ lên mockup mặc định. */}
            {showGrid && (
                <SingleLayerFloorGrid
                    size={floorSize}
                    divisions={divisions}
                    y={floorY + gridLift}
                    color={gridColor}
                />
            )}
        </group>
    );
}

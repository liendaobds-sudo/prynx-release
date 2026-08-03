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

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ContactShadows } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useMockupStore } from '../../stores/useMockupStore';
import { MOCKUP_VISUAL_ONLY_LAYER, moveToMockupVisualOnlyLayer } from './renderLayers';
import {
    DEFAULT_BACKGROUND_PRESET_ID,
    getBackgroundPreset,
} from './backgroundPresets';

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
    /** Giữ nguyên texture bóng trong lúc panel đang chuyển động; hết animation chụp lại một lần. */
    freezeShadow?: boolean;
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
    freezeShadow = false,
}: ShadowFloorProps) {
    const backgroundPreset = useMockupStore((s) => s.backgroundPreset);
    const preset = useMemo(() => getBackgroundPreset(backgroundPreset), [backgroundPreset]);

    // Đặt nền scene: solid Color hoặc CanvasTexture radial (showcase-style).
    // Không dùng `<color attach="background">` trong <group>. Khôi phục khi unmount.
    const scene = useThree((s) => s.scene);
    const camera = useThree((s) => s.camera);
    const floorVisualsRef = useRef<THREE.Group>(null);

    // [SHADOW FIX 2026-07-27 §DT3D-007] Không để sàn/lưới lọt vào depth pass
    // của ContactShadows. Nếu bị capture, mặt sàn sẽ ghi đè depth của hộp và
    // sinh các sọc ngang/moire như ảnh lỗi người dùng cung cấp.
    useLayoutEffect(() => {
        const floorVisuals = floorVisualsRef.current;
        if (!floorVisuals?.traverse || !camera?.layers) return;
        camera.layers.enable(MOCKUP_VISUAL_ONLY_LAYER);
        moveToMockupVisualOnlyLayer(floorVisuals);
        return () => camera.layers.disable(MOCKUP_VISUAL_ONLY_LAYER);
    }, [camera, showFloorPlane, showGrid, preset.id]);
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
                position={[0, floorY + shadowLift, 0]}
                scale={shadowScale}
                resolution={512}
                far={size}
                blur={preset.shadowBlur}
                opacity={preset.shadowOpacity}
                color={preset.shadowColor}
                // Giữ texture cũ khi chuyển động; scene đứng yên mới chụp lại một lần.
                frames={freezeShadow ? 0 : 1}
                smooth
                depthWrite={false}
            />

            <group ref={floorVisualsRef} name="mockup-floor-visuals">
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
        </group>
    );
}

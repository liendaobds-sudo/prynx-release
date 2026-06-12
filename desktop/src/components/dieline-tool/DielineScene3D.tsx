// ============================================================
// DielineScene3D — Recursive Panel Folding Engine
// Generic 3D folding cho TẤT CẢ loại hộp dựa trên cây Panel
// ============================================================

import React, { useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls, Environment, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useBoxStore } from '../../store/useBoxStore';
import { Panel, Point2D, PathSegment, DielineModel } from '../../lib/dieline/types';
import { tracePerimeter } from '../../lib/dieline/tracePerimeter';

// ─── Helpers ───────────────────────────────────────────────

/** Tính outline shape từ panel paths (gom tất cả CUT và CREASE) */
function panelToShape(panel: Panel): THREE.Shape | null {
    let perimeterPoints: Point2D[] = [];
    
    // Ưu tiên sử dụng outline khai báo rõ ràng (stable, không lỗi earcut)
    if (panel.outline && panel.outline.length >= 3) {
        perimeterPoints = panel.outline;
    } else {
        // Fallback cho các box cũ chưa khai báo outline
        perimeterPoints = tracePerimeter(panel.paths);
    }
    
    if (!perimeterPoints || perimeterPoints.length === 0) return null;

    const shape = new THREE.Shape();
    
    // Start point
    shape.moveTo(perimeterPoints[0].x, perimeterPoints[0].y);

    for (let i = 1; i < perimeterPoints.length; i++) {
        shape.lineTo(perimeterPoints[i].x, perimeterPoints[i].y);
    }

    if (panel.holes) {
        panel.holes.forEach(holePts => {
            if (holePts && holePts.length >= 3) {
                const holePath = new THREE.Path();
                holePath.moveTo(holePts[0].x, holePts[0].y);
                for (let i = 1; i < holePts.length; i++) {
                    holePath.lineTo(holePts[i].x, holePts[i].y);
                }
                shape.holes.push(holePath);
            }
        });
    }

    return shape;
}

/** Tính depth (level) trong cây panel → dùng cho auto foldPhase */
function computeDepths(panels: Panel[]): Map<string, number> {
    const depthMap = new Map<string, number>();
    const nameMap = new Map(panels.map(p => [p.name, p]));

    function getDepth(name: string): number {
        if (depthMap.has(name)) return depthMap.get(name)!;
        const panel = nameMap.get(name);
        if (!panel || !panel.parent) {
            depthMap.set(name, 0);
            return 0;
        }
        const d = getDepth(panel.parent) + 1;
        depthMap.set(name, d);
        return d;
    }

    panels.forEach(p => getDepth(p.name));
    return depthMap;
}

/** Tính max depth */
function maxDepth(depthMap: Map<string, number>): number {
    let max = 0;
    depthMap.forEach(d => { if (d > max) max = d; });
    return max;
}

/** Lấy góc gập thực tế tại foldProgress cho 1 panel */
function getEffectiveFoldAngle(
    panel: Panel,
    foldProgress: number,
    depth: number,
    maxD: number,
): number {
    if (panel.foldAngle === 0) return 0;

    let phaseStart: number, phaseEnd: number;
    if (panel.foldPhase) {
        [phaseStart, phaseEnd] = panel.foldPhase;
    } else {
        // Auto-phase based on depth: deeper panels fold later
        const step = maxD > 0 ? 1 / (maxD + 1) : 1;
        phaseStart = depth * step;
        phaseEnd = (depth + 1) * step;
    }

    // Clamp progress to this panel's phase
    const localProgress = Math.max(0, Math.min(1,
        (foldProgress - phaseStart) / (phaseEnd - phaseStart)
    ));

    // Ease in-out for smooth animation
    const eased = localProgress < 0.5
        ? 2 * localProgress * localProgress
        : 1 - Math.pow(-2 * localProgress + 2, 2) / 2;

    return panel.foldAngle * eased * (panel.foldDirection || 1);
}

/** Convert degrees to radians */
const deg2rad = (d: number) => d * Math.PI / 180;

// ─── Recursive Panel Component ─────────────────────────────

interface FlatPanelProps {
    panel: Panel;
    allPanels: Panel[];
    foldProgress: number;
    depthMap: Map<string, number>;
    maxD: number;
    thickness: number;
    materialColor: string;
    texture: THREE.Texture | null;
    globalBBox: { minX: number; minY: number; width: number; height: number };
}

// Helper: Compute absolute transformation matrix for a panel
function getPanelMatrix(
    panel: Panel,
    allPanels: Panel[],
    foldProgress: number,
    depthMap: Map<string, number>,
    maxD: number,
    thickness: number
): THREE.Matrix4 {
    const m = new THREE.Matrix4(); // Identity
    let current: Panel | null = panel;

    while (current) {
        if (current.pivotEdge && current.parent) {
            const depth = depthMap.get(current.name) || 0;
            const foldAngleDeg = getEffectiveFoldAngle(current, foldProgress, depth, maxD);
            const foldRad = deg2rad(foldAngleDeg);

            const [p1, p2] = current.pivotEdge;
            const midX = (p1.x + p2.x) / 2;
            const midY = (p1.y + p2.y) / 2;
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const angle = Math.atan2(dy, dx);

            let foldShiftY = 0;
            if (current.name.includes('tuck')) {
                const sign = current.name.includes('bot') ? 1 : -1;
                const progress = Math.min(1, Math.abs(foldAngleDeg) / 90);
                foldShiftY = sign * thickness * progress;
            }

            const mat = new THREE.Matrix4();
            mat.multiply(new THREE.Matrix4().makeTranslation(midX, midY, 0));
            mat.multiply(new THREE.Matrix4().makeRotationZ(angle));
            mat.multiply(new THREE.Matrix4().makeRotationX(foldRad));
            mat.multiply(new THREE.Matrix4().makeRotationZ(-angle));
            mat.multiply(new THREE.Matrix4().makeTranslation(-midX, -midY, 0));
            
            if (foldShiftY !== 0) {
                mat.multiply(new THREE.Matrix4().makeTranslation(0, foldShiftY, 0));
            }

            // Premultiply to apply parent transformations after child transformations
            m.premultiply(mat);
        }
        const parentName: string | undefined = current.parent ?? undefined;
        current = allPanels.find(p => p.name === parentName) || null;
    }

    return m;
}

function FlatPanelMesh({
    panel, allPanels, foldProgress, depthMap, maxD, thickness, materialColor, texture, globalBBox
}: FlatPanelProps) {
    const groupRef = useRef<THREE.Group>(null);

    // 1. Tạo shape từ panel paths
    const shape = useMemo(() => panelToShape(panel), [panel]);

    // 2. Tính toán ma trận biến đổi (Fold Matrix)
    const matrix = useMemo(() => {
        return getPanelMatrix(panel, allPanels, foldProgress, depthMap, maxD, thickness);
    }, [panel, allPanels, foldProgress, depthMap, maxD, thickness]);

    // Apply matrix directly to Group
    useEffect(() => {
        if (groupRef.current) {
            groupRef.current.matrix.copy(matrix);
        }
    }, [matrix]);

    // Geometry: Flat ShapeGeometry instead of heavy ExtrudeGeometry
    const geometry = useMemo(() => {
        if (!shape) return null;
        const geo = new THREE.ShapeGeometry(shape);
        
        // Post-process UVs to map globally across the 2D sheet
        const posAttribute = geo.attributes.position;
        const uvAttribute = geo.attributes.uv;
        for (let i = 0; i < posAttribute.count; i++) {
            const x = posAttribute.getX(i);
            const y = posAttribute.getY(i);
            let u = (x - globalBBox.minX) / globalBBox.width;
            let v = (y - globalBBox.minY) / globalBBox.height;
            uvAttribute.setXY(i, u, v);
        }
        uvAttribute.needsUpdate = true;
        
        return geo;
    }, [shape, globalBBox]);

    // CAD Lines Geometry (from actual paths)
    const lineGeometries = useMemo(() => {
        const cutGeo = new THREE.BufferGeometry();
        const creaseGeo = new THREE.BufferGeometry();
        const cutPts: THREE.Vector3[] = [];
        const creasePts: THREE.Vector3[] = [];

        panel.paths.forEach(seg => {
            const arr = seg.tag === 'CREASE' ? creasePts : cutPts;
            if (seg.type === 'line') {
                arr.push(new THREE.Vector3(seg.points[0].x, seg.points[0].y, 0));
                arr.push(new THREE.Vector3(seg.points[1].x, seg.points[1].y, 0));
            } else if (seg.type === 'bezier' && seg.controlPoints && seg.controlPoints.length >= 4) {
                const curve = new THREE.CubicBezierCurve3(
                    new THREE.Vector3(seg.points[0].x, seg.points[0].y, 0),
                    new THREE.Vector3(seg.controlPoints[1].x, seg.controlPoints[1].y, 0),
                    new THREE.Vector3(seg.controlPoints[2].x, seg.controlPoints[2].y, 0),
                    new THREE.Vector3(seg.points[1].x, seg.points[1].y, 0)
                );
                const pts = curve.getPoints(12);
                for (let i = 0; i < pts.length - 1; i++) {
                    arr.push(pts[i]);
                    arr.push(pts[i + 1]);
                }
            }
        });

        cutGeo.setFromPoints(cutPts);
        creaseGeo.setFromPoints(creasePts);
        return { cutGeo, creaseGeo };
    }, [panel.paths]);

    if (!shape || !geometry) {
        return null; // Không render nếu panel không có diện tích
    }

    const offsetZ = thickness / 2;

    return (
        <group ref={groupRef} matrixAutoUpdate={false}>
            {/* Outer panel mesh (Faces Z+) */}
            <mesh geometry={geometry} position={[0, 0, offsetZ]} castShadow receiveShadow>
                {texture ? (
                    <meshStandardMaterial map={texture} roughness={0.4} metalness={0.1} side={THREE.FrontSide} />
                ) : (
                    <meshStandardMaterial color={materialColor} roughness={0.4} metalness={0.1} side={THREE.FrontSide} />
                )}
            </mesh>

            {/* Inner panel mesh (Faces Z-) - BackSide to avoid having to flip the geometry vertices */}
            <mesh geometry={geometry} position={[0, 0, -offsetZ]} castShadow receiveShadow>
                <meshStandardMaterial color="#cca075" roughness={0.9} metalness={0.0} side={THREE.BackSide} />
            </mesh>
            
            {/* CAD Lines Overlay (Front) */}
            <lineSegments geometry={lineGeometries.cutGeo} position={[0, 0, offsetZ]}>
                <lineBasicMaterial color="#ffffff" transparent opacity={0.3} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
            </lineSegments>
            <lineSegments geometry={lineGeometries.creaseGeo} position={[0, 0, offsetZ]}>
                <lineBasicMaterial color="#ffffff" transparent opacity={0.15} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
            </lineSegments>

            {/* CAD Lines Overlay (Back) */}
            <lineSegments geometry={lineGeometries.cutGeo} position={[0, 0, -offsetZ]}>
                <lineBasicMaterial color="#000000" transparent opacity={0.2} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
            </lineSegments>
            <lineSegments geometry={lineGeometries.creaseGeo} position={[0, 0, -offsetZ]}>
                <lineBasicMaterial color="#000000" transparent opacity={0.1} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
            </lineSegments>
        </group>
    );
}

// ─── Scene Component ───────────────────────────────────────

function BoxScene() {
    const { dieline, foldProgress, mockupTextureUrl } = useBoxStore();

    // Load texture conditionally
    const texture = useLoader(THREE.TextureLoader, mockupTextureUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7') as THREE.Texture;

    // Setup texture color space and wrapping
    useEffect(() => {
        if (texture && mockupTextureUrl) {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            // Dieline uses standard Y-down or Y-up coords, we may need to flip Y
            texture.flipY = true;
        }
    }, [texture, mockupTextureUrl]);

    if (!dieline || dieline.panels.length === 0) {
        return null;
    }

    const { panels, params } = dieline;
    const thickness = params.T || 0.5;

    // Compute depth map for auto-phasing
    const depthMap = useMemo(() => computeDepths(panels), [panels]);
    const maxD = useMemo(() => maxDepth(depthMap), [depthMap]);

    // Find root panels (no parent)
    const rootPanels = useMemo(
        () => panels.filter(p => !p.parent),
        [panels]
    );

    // Center the model
    const center = useMemo(() => {
        const bb = dieline.boundingBox;
        return {
            x: bb.minX + bb.width / 2,
            y: bb.minY + bb.height / 2,
        };
    }, [dieline]);

    // Material color based on box type
    const materialColor = useMemo(() => {
        const colors: Record<string, string> = {
            rte: '#d4a574',      // Kraft brown
            slb: '#c9956b',
            gable: '#b8845a',
            paper_bag: '#dbb896', // Light kraft
            cup_sleeve: '#e8d5c0',
            pizza: '#c4a882',
            envelope: '#f0e6d8', // White paper
            tray: '#ccb897',
        };
        return colors[params.boxType] || '#d4a574';
    }, [params.boxType]);

    return (
        <group position={[-center.x, -center.y, 0]}>
            {panels.map(panel => (
                <FlatPanelMesh
                    key={panel.name}
                    panel={panel}
                    allPanels={panels}
                    foldProgress={foldProgress}
                    depthMap={depthMap}
                    maxD={maxD}
                    thickness={thickness}
                    materialColor={materialColor}
                    texture={mockupTextureUrl ? texture : null}
                    globalBBox={dieline.boundingBox}
                />
            ))}
        </group>
    );
}

// ─── Controls ──────────────────────────────────────────────

function FoldControls() {
    const { foldProgress, setFoldProgress, isAnimating, setIsAnimating } = useBoxStore();
    const animRef = useRef<number | null>(null);

    useEffect(() => {
        if (!isAnimating) {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            return;
        }

        let start: number | null = null;
        const duration = 2000; // 2s full fold

        const animate = (timestamp: number) => {
            if (!start) start = timestamp;
            const elapsed = timestamp - start;
            const t = Math.min(elapsed / duration, 1);
            // Ping-pong: go 0→1 then 1→0
            const pingPong = t <= 0.5 ? t * 2 : 2 - t * 2;
            setFoldProgress(pingPong);

            if (t < 1) {
                animRef.current = requestAnimationFrame(animate);
            } else {
                setIsAnimating(false);
            }
        };

        animRef.current = requestAnimationFrame(animate);
        return () => {
            if (animRef.current) cancelAnimationFrame(animRef.current);
        };
    }, [isAnimating, setFoldProgress, setIsAnimating]);

    return (
        <div className="dt-fold-controls" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>

            <button
                className={`dt-fold-play-btn ${isAnimating ? 'active' : ''}`}
                onClick={() => setIsAnimating(!isAnimating)}
                title={isAnimating ? 'Dừng' : 'Chạy hoạt ảnh gập'}
            >
                {isAnimating ? '⏸' : '▶'}
            </button>
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={foldProgress}
                onChange={(e) => {
                    setIsAnimating(false);
                    setFoldProgress(parseFloat(e.target.value));
                }}
                className="dt-fold-slider"
            />
            <span className="dt-fold-value">
                {Math.round(foldProgress * 100)}%
            </span>
        </div>
    );
}

// ─── Main Export ────────────────────────────────────────────

export default function DielineScene3D() {
    const { dieline, isStanding } = useBoxStore();

    if (!dieline) {
        return (
            <div className="dt-scene-loading">
                <p>Nhập thông số để xem mô phỏng 3D</p>
            </div>
        );
    }

    // Camera distance based on bounding box
    const camDist = Math.max(dieline.boundingBox.width, dieline.boundingBox.height) * 1.5;
    const yOffset = dieline.boundingBox.height / 2;

    return (
        <div className="dt-scene-3d-container" style={{ position: 'relative' }}>
            <Canvas
                shadows
                camera={{
                    position: [camDist * 0.5, camDist * 0.7, camDist], // Standard isometric view
                    fov: 45,
                    near: 0.1,
                    far: camDist * 10,
                }}
                style={{ background: '#0A0A0A' }}
            >
                {/* Premium Studio Environment matching boxcraft-3d */}
                <color attach="background" args={['#0A0A0A']} />
                
                {/* Ambient Light */}
                <ambientLight intensity={0.55} />
                
                {/* Studio Keylight */}
                <directionalLight
                    position={[camDist * 0.4, camDist * 0.9, camDist * 0.5]}
                    intensity={0.85}
                    castShadow
                    shadow-mapSize={[1024, 1024]}
                    shadow-bias={-0.001}
                />
                
                {/* Soft backlight for packaging reflections */}
                <directionalLight
                    position={[-camDist * 0.4, camDist * 0.4, -camDist * 0.4]}
                    intensity={0.45}
                    color="#e0f2fe"
                />
                
                {/* Subtle floor light bouncing */}
                <directionalLight
                    position={[0, -camDist * 0.6, 0]}
                    intensity={0.2}
                    color="#ffedd5"
                />

                {/* Sleek dark mirror floor with shadow reception */}
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -camDist * 0.3, 0]} receiveShadow>
                    <planeGeometry args={[camDist * 3, camDist * 3]} />
                    <shadowMaterial opacity={0.12} />
                </mesh>

                {/* Grid helper for precise desktop feel */}
                <gridHelper
                    args={[camDist * 2, 40, '#2d2e33', '#1e1f22']}
                    position={[0, -camDist * 0.3 + 1, 0]}
                />

                {/* Box layout orientation */}
                <group 
                    position={isStanding ? [0, yOffset, 0] : [0, 0, 0]}
                    rotation={isStanding ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}
                >
                    <BoxScene />
                </group>

                {/* Controls */}
                <OrbitControls
                    enablePan
                    enableZoom
                    enableRotate
                    enableDamping
                    dampingFactor={0.05}
                    makeDefault
                    maxPolarAngle={Math.PI / 2 + 0.15} // Prevent camera from going too far under ground
                    minDistance={camDist * 0.2}
                    maxDistance={camDist * 5}
                />
            </Canvas>

            {/* Fold slider overlay */}
            <FoldControls />
        </div>
    );
}

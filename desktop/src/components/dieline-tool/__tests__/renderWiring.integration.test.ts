// @vitest-environment jsdom
// ============================================================
// renderWiring.integration.test.ts — Mockup 3D Realism (Task 11.3)
//
// Integration / smoke test cho WIRING lớp render mockup 3D dưới jsdom
// với ngăn xếp R3F/drei được STUB (mock) nhẹ. Mục tiêu: xác nhận các
// component render GHÉP NỐI với nhau và chạy KHÔNG NÉM LỖI — không kiểm
// pixel-perfect rendering (WebGL thật không khả dụng trong jsdom).
//
// Vì sao mock thay vì mount <Canvas> thật:
//   - jsdom không có WebGL → Canvas R3F không khởi tạo được renderer.
//   - Nhiều component (SolidPanelMesh) giữ ref tới đối tượng three
//     (groupRef.current.matrix), không thể render qua react-dom thuần.
// Do đó ta mock @react-three/fiber + @react-three/drei thành stub nhẹ,
// rồi khẳng định composition render + props/store nối đúng (cách tiếp
// cận "pragmatic" được nêu trong mô tả task).
//
// Phạm vi kiểm:
//   • Tone mapping = ACESFilmicToneMapping trong cấu hình gl của
//     MockupCanvas (qua prop gl + callback onCreated) — Yêu cầu 3.4.
//   • DielineScene3D ghép EnvironmentRig + ShadowFloor + CameraRig +
//     SolidPanelMesh + DimensionOverlay + export bridge mount KHÔNG
//     ném lỗi và nối props từ dieline — Yêu cầu 3.1, 3.5, 7.2.
//   • useSceneExport.exportPNG / exportGLB: đường dẫn tải file phía
//     client + nhánh try/catch báo lỗi giữ cảnh — Yêu cầu 6.1, 6.3,
//     6.5, 6.6.
//   • CameraRig chuyển cảnh hoàn tất ≤500ms — Yêu cầu 7.2.
//
// _Requirements: 3.1, 3.3, 3.5, 6.1, 6.3, 6.5, 6.6, 7.2_
// Feature: mockup-3d-realism
// ============================================================

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import * as THREE from 'three';
import { toast } from 'sonner';
import type { SolidPanelMeshProps } from '../SolidPanelMesh';
import type { GussetMeshProps } from '../GussetMesh';
import type { WindowPaneMeshProps } from '../WindowPaneMesh';

const e = React.createElement;

/** Các thuộc tính renderer mà test đọc sau khi Canvas được dựng. */
interface RendererStubProps {
    antialias?: boolean;
    alpha?: boolean;
    preserveDrawingBuffer?: boolean;
    toneMapping?: number;
    toneMappingExposure?: number;
    outputColorSpace?: string;
}

/** Props tối thiểu của Canvas stub trong môi trường jsdom. */
interface CanvasStubProps {
    children?: React.ReactNode;
    gl: RendererStubProps;
    onCreated: (state: { gl: RendererStubProps }) => void;
    frameloop?: string;
    dpr?: readonly [number, number];
}

/** Texture giả: chỉ giữ các trường mà BoxScene cấu hình và test quan sát. */
interface TextureStub {
    colorSpace: string;
    generateMipmaps: boolean;
    minFilter: number;
    magFilter: number;
    anisotropy: number;
    wrapS: number;
    wrapT: number;
    flipY: boolean;
    needsUpdate: boolean;
    dispose: () => void;
}

/** Props SolidPanelMesh sau mock, cho phép texture giả có shape tối thiểu. */
type ObservedSolidPanelProps = Omit<SolidPanelMeshProps, 'texture' | 'innerTexture' | 'spotUvTexture' | 'embossTexture'> & {
    texture?: THREE.Texture | TextureStub | null;
    innerTexture?: THREE.Texture | TextureStub | null;
    spotUvTexture?: THREE.Texture | TextureStub | null;
    embossTexture?: THREE.Texture | TextureStub | null;
};

/** Renderer giả dùng chung cho useThree và useSceneExport. */
interface FakeGl {
    domElement: HTMLCanvasElement;
    getPixelRatio: () => number;
    setPixelRatio: (value: number) => void;
    setSize: (width: number, height: number) => void;
    render: (scene: THREE.Scene, camera: THREE.Camera) => void;
    getRenderTarget: () => THREE.WebGLRenderTarget | null;
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) => void;
    clear: (color?: boolean, depth?: boolean, stencil?: boolean) => void;
    readRenderTargetPixels: (...args: unknown[]) => void;
    capabilities: {
        getMaxAnisotropy: () => number;
        maxTextureSize?: number;
        maxSamples?: number;
        isWebGL2?: boolean;
    };
    getClearColor: (target: THREE.Color) => THREE.Color;
    getClearAlpha: () => number;
    setClearColor: (color: THREE.ColorRepresentation, alpha?: number) => void;
    toneMapping: number;
    toneMappingExposure: number;
    outputColorSpace: string;
}

interface FakeThreeState {
    gl: FakeGl;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    size: { width: number; height: number };
    controls: { target: THREE.Vector3; update: () => void };
    invalidate: () => void;
}

interface ChildStubProps {
    children?: React.ReactNode;
}

// ─── Hộp chứa trạng thái chia sẻ giữa mock và test (hoisted) ────────────────

const h = vi.hoisted(() => ({
    /** Props mà mock <Canvas> nhận được (để kiểm tone mapping). */
    canvasProps: [] as CanvasStubProps[],
    /** Callback đăng ký qua useFrame (để mô phỏng vòng render). */
    frameCallbacks: [] as Array<(state?: unknown, delta?: number) => void>,
    /** Props ContactShadows để khóa hành vi giữ/chụp bóng quanh animation. */
    contactShadowProps: [] as Array<{ frames?: number }>,
    /** Trạng thái giả cho useThree (gl/scene/camera/size/controls/invalidate). */
    threeState: null as FakeThreeState | null,
    /** Texture giả trả về từ useLoader. */
    fakeTexture: {
        colorSpace: '',
        generateMipmaps: false,
        minFilter: 0,
        magFilter: 0,
        anisotropy: 1,
        wrapS: 0,
        wrapT: 0,
        flipY: false,
        needsUpdate: false,
        dispose: () => undefined,
    } satisfies TextureStub,
    /** Props mà SolidPanelMesh (mock) nhận được (để kiểm wiring từ dieline). */
    solidPanelProps: [] as ObservedSolidPanelProps[],
    /** Props của bốn miếng góc khay để kiểm tra công tắc đường kỹ thuật. */
    gussetProps: [] as GussetMeshProps[],
    /** [HANGING-WINDOW 2026-07-27] Props của màng cửa sổ trong suốt. */
    windowPaneProps: [] as WindowPaneMeshProps[],
    /** Kết quả parseAsync của GLTFExporter mock. */
    glbResult: null as unknown,
    /** Cho phép GLTFExporter.parseAsync reject để kiểm nhánh lỗi. */
    glbReject: false,
}));

// ─── Mock @react-three/fiber ────────────────────────────────────────────────

vi.mock('@react-three/fiber', () => ({
    // <Canvas> stub: ghi lại props rồi render children qua react-dom.
    Canvas: (props: CanvasStubProps) => {
        h.canvasProps.push(props);
        return props.children ?? null;
    },
    // useThree dạng selector: trả về lát cắt của threeState giả.
    useThree: (selector?: (s: FakeThreeState) => unknown) => {
        const state = h.threeState;
        if (!state) throw new Error('Fake three state chưa được khởi tạo.');
        return selector ? selector(state) : state;
    },
    // useFrame: ghi lại callback để test tự "tick" vòng render.
    useFrame: (cb: (state?: unknown, delta?: number) => void) => {
        h.frameCallbacks.push(cb);
    },
    // useLoader: trả texture giả, không tải mạng.
    useLoader: () => h.fakeTexture,
}));

// ─── Mock @react-three/drei ─────────────────────────────────────────────────

vi.mock('@react-three/drei', () => ({
    Environment: (props: ChildStubProps) => props.children ?? null,
    Lightformer: () => null,
    Html: (props: ChildStubProps) => props.children ?? null,
    ContactShadows: (props: { frames?: number }) => {
        h.contactShadowProps.push(props);
        return null;
    },
    OrbitControls: () => null,
    // View cube định hướng (DielineScene3D import GizmoHelper + GizmoViewcube).
    // GizmoHelper bọc viewcube làm children → render children để wiring khớp;
    // GizmoViewcube là stub vô hại trả null (không cần WebGL trong jsdom).
    GizmoHelper: (props: ChildStubProps) => props.children ?? null,
    GizmoViewcube: () => null,
}));

// ─── Mock GLTFExporter (xuất GLB) ───────────────────────────────────────────

vi.mock('three/examples/jsm/exporters/GLTFExporter.js', () => ({
    GLTFExporter: class {
        parseAsync(): Promise<unknown> {
            if (h.glbReject) return Promise.reject(new Error('mock GLB export failed'));
            return Promise.resolve(h.glbResult);
        }
    },
}));

// ─── Mock sonner toast ───────────────────────────────────────────────────────

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

// ─── Mock SolidPanelMesh (giữ ref three, không render được qua react-dom) ───
// Stub ghi lại props để kiểm DielineScene3D nối đúng dữ liệu dieline.

vi.mock('../SolidPanelMesh', () => ({
    default: (props: ObservedSolidPanelProps) => {
        h.solidPanelProps.push(props);
        return null;
    },
}));
vi.mock('../GussetMesh', () => ({
    default: (props: GussetMeshProps) => {
        h.gussetProps.push(props);
        return null;
    },
}));
// [HANGING-WINDOW 2026-07-27] Màng cửa sổ trong suốt — chỉ ghi props để kiểm wiring.
vi.mock('../WindowPaneMesh', () => ({
    default: (props: WindowPaneMeshProps) => {
        h.windowPaneProps.push(props);
        return null;
    },
}));
// ─── Import sau khi mock đã đăng ký ─────────────────────────────────────────

import MockupCanvas from '../MockupCanvas';
import DielineScene3D from '../DielineScene3D';
import CameraRig from '../CameraRig';
import { useSceneExport } from '../useSceneExport';
import { useMockupStore } from '../../../stores/useMockupStore';
import { computeExportSize } from '../../../lib/mockup3d/exportSizing';
import { useBoxStore } from '../../../stores/useBoxStore';
import { generateDieline } from '../../../lib/dieline/engine';
import { DEFAULT_PARAMS } from '../../../lib/dieline/types';

// ─── Tiện ích dựng threeState giả ───────────────────────────────────────────

function makeFakeGl() {
    return {
        domElement: {} as HTMLCanvasElement,
        getPixelRatio: vi.fn(() => 1),
        setPixelRatio: vi.fn(),
        setSize: vi.fn(),
        render: vi.fn(),
        getRenderTarget: vi.fn(() => null),
        setRenderTarget: vi.fn(),
        clear: vi.fn(),
        readRenderTargetPixels: vi.fn(),
        capabilities: { getMaxAnisotropy: vi.fn(() => 16) },
        getClearColor: vi.fn((target: THREE.Color) => {
            target.set(0x000000);
            return target;
        }),
        getClearAlpha: vi.fn(() => 1),
        setClearColor: vi.fn(),
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1,
        outputColorSpace: THREE.SRGBColorSpace,
    };
}
function makeFakeThreeState(gl = makeFakeGl()) {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(10, 10, 10);
    return {
        gl,
        scene: new THREE.Scene(),
        camera,
        size: { width: 800, height: 600 },
        controls: { target: new THREE.Vector3(0, 0, 0), update: vi.fn() },
        invalidate: vi.fn(),
    };
}

// ─── Setup / teardown chung ─────────────────────────────────────────────────

let getContextSpy: ReturnType<typeof vi.spyOn> | null = null;
let toBlobSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
    h.canvasProps.length = 0;
    h.frameCallbacks.length = 0;
    h.contactShadowProps.length = 0;
    h.solidPanelProps.length = 0;
    h.gussetProps.length = 0;
    h.windowPaneProps.length = 0;
    h.glbReject = false;
    h.glbResult = null;
    h.threeState = makeFakeThreeState();
    Object.assign(h.fakeTexture, { colorSpace: '', generateMipmaps: false, minFilter: 0, flipY: false });

    const params = { ...DEFAULT_PARAMS };
    useBoxStore.setState({
        params,
        dieline: generateDieline(params),
        isModelCurrent: true,
    });
    // Stub WebGL detection: getContext('webgl') trả context giả → supported = true.
    // `getContext` có nhiều overload (2D/WebGL/WebGPU do @webgpu/types thêm vào),
    // nên ép kiểu qua `never` để mockReturnValue khớp với mọi overload.
    getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation(((contextId: string) => {
            if (contextId === '2d') {
                return {
                    createImageData: (width: number, height: number) => ({
                        data: new Uint8ClampedArray(width * height * 4),
                    }),
                    putImageData: vi.fn(),
                };
            }
            return {};
        }) as never);
    toBlobSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'toBlob')
        .mockImplementation((callback) => callback(new Blob(['png-bytes'], { type: 'image/png' })));
    // jsdom không có URL.createObjectURL/revokeObjectURL — stub cho downloadBlob.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
        () => 'blob:mock-url',
    );
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();

    // anchor.click() trong downloadBlob gây "navigation" chưa hỗ trợ ở jsdom;
    // stub thành no-op để giữ output sạch (vẫn xác thực qua URL.createObjectURL).
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    (toast.success as unknown as { mockClear: () => void }).mockClear();
    (toast.error as unknown as { mockClear: () => void }).mockClear();
});

afterEach(() => {
    cleanup();
    getContextSpy?.mockRestore();
    useMockupStore.getState().resetMockup();
    vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────
    useBoxStore.setState({ dieline: null, isModelCurrent: false });
// Yêu cầu 3.4 — Tone mapping ACES Filmic trong MockupCanvas
// ──────────────────────────────────────────────────────────────────────────

describe('MockupCanvas — tone mapping ACES Filmic (Yêu cầu 3.4)', () => {
    it('cấu hình gl của Canvas đặt toneMapping = ACESFilmicToneMapping + sRGB', async () => {
        await act(async () => {
            render(e(MockupCanvas, null, e('group', null)));
        });

        // WebGL supported → Canvas được render và nhận props.
        expect(h.canvasProps.length).toBeGreaterThan(0);
        const props = h.canvasProps[h.canvasProps.length - 1];
        expect(props.gl).toBeDefined();
        expect(props.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
        expect(props.gl.outputColorSpace).toBe(THREE.SRGBColorSpace);
        // PNG export dùng render target riêng; không giữ framebuffer thường trực.
        expect(props.gl.preserveDrawingBuffer).toBe(false);
        expect(props.frameloop).toBe('demand');
        expect(props.dpr).toEqual([1, 1.5]);
    });

    it('callback onCreated áp ACESFilmicToneMapping lên renderer thật', async () => {
        await act(async () => {
            render(e(MockupCanvas, null, e('group', null)));
        });

        const props = h.canvasProps[h.canvasProps.length - 1];
        expect(typeof props.onCreated).toBe('function');

        // Mô phỏng renderer được tạo: onCreated phải đặt tone mapping tường minh.
        const fakeGl: RendererStubProps = {};
        props.onCreated({ gl: fakeGl });
        expect(fakeGl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
        expect(fakeGl.outputColorSpace).toBe(THREE.SRGBColorSpace);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 3.1 / 3.5 / 7.2 — DielineScene3D ghép nối mount không ném lỗi
// ──────────────────────────────────────────────────────────────────────────

describe('DielineScene3D — composition wiring (Yêu cầu 3.1, 3.5, 7.2)', () => {
    it('mount toàn bộ cảnh 3D KHÔNG ném lỗi và nối props dieline tới panel mesh', async () => {
        await act(async () => {
            render(e(DielineScene3D, null));
        });

        // Canvas (vỏ MockupCanvas) đã render với tone mapping ACES.
        expect(h.canvasProps.length).toBeGreaterThan(0);
        const props = h.canvasProps[h.canvasProps.length - 1];
        expect(props.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);

        // SolidPanelMesh nhận props từ dieline mặc định của useBoxStore:
        // mỗi panel được wiring với globalBBox + thickness + foldProgress.
        expect(h.solidPanelProps.length).toBeGreaterThan(0);
        const first = h.solidPanelProps[0];
        expect(first.panel).toBeDefined();
        expect(first.panel.name).toBeTruthy();
        expect(first.globalBBox).toBeDefined();
        expect(typeof first.thickness).toBe('number');
        expect(first.thickness).toBeGreaterThan(0);
        expect(typeof first.foldProgress).toBe('number');

        // CameraRig đã đăng ký vòng render (useFrame) → rig hoạt động trong cảnh.
        expect(h.frameCallbacks.length).toBeGreaterThan(0);
    });

    it('pizza giữ cơ cấu gấp và chuyển artwork ngoài sang cap âm Z', async () => {
        const params = { ...DEFAULT_PARAMS, boxType: 'pizza' as const, L: 300, W: 300, D: 40, T: 1.5 };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.solidPanelProps.length).toBeGreaterThan(0);
        expect(h.solidPanelProps.every((props) => props.outerFaceNegativeZ === true)).toBe(true);
    });
    it('hộp nắp lật tự khóa chuyển artwork ngoài sang cap âm Z', async () => {
        const params = {
            ...DEFAULT_PARAMS,
            boxType: 'flip_top_tuck' as const,
            L: 200, W: 200, D: 60, T: 0.5, C: 0.5,
        };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.solidPanelProps.every((props) => props.outerFaceNegativeZ === true)).toBe(true);
    });

    // [HANGING-WINDOW 2026-07-27] Màng cửa sổ trong suốt: chỉ dựng cho panel mặt
    // trước CÓ lỗ khoét, và tắt được bằng công tắc `showWindowFilm` (thuần hiển
    // thị — không đụng khuôn bế nên không có gì phải kiểm ở generator).
    it('hộp treo có cửa sổ: dựng màng nhựa đúng panel mặt trước', async () => {
        const params = {
            ...DEFAULT_PARAMS, boxType: 'hanging_window' as const,
            L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15,
        };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });
        useMockupStore.setState({ showWindowFilm: true });

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.windowPaneProps).toHaveLength(1);
        const pane = h.windowPaneProps[0];
        expect(pane.panel.name).toBe('front');
        expect(pane.panel.holes?.length).toBe(1);
        // Màng dùng CHUNG hệ gấp với panel: nhận đủ allPanels/depthMap/thickness.
        expect(pane.allPanels.length).toBeGreaterThan(0);
        expect(pane.thickness).toBeCloseTo(params.T, 6);
        expect(pane.depthMap).toBeDefined();
    });

    it('tắt công tắc màng cửa sổ thì không dựng màng', async () => {
        const params = {
            ...DEFAULT_PARAMS, boxType: 'hanging_window' as const,
            L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15,
        };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });
        useMockupStore.setState({ showWindowFilm: false });

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.windowPaneProps).toHaveLength(0);
        useMockupStore.setState({ showWindowFilm: true });
    });

    it('loại hộp không có cửa sổ thì không dựng màng', async () => {
        const params = { ...DEFAULT_PARAMS, boxType: 'rte' as const };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });
        useMockupStore.setState({ showWindowFilm: true });

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.windowPaneProps).toHaveLength(0);
    });

    it('hộp diêm tách texture và vùng UV của khay khỏi vỏ hộp', async () => {
        const params = { ...DEFAULT_PARAMS, boxType: 'tray' as const, L: 200, W: 150, D: 40, T: 1 };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });
        useMockupStore.getState().setTrayArtworkUrl('data:image/png;base64,tray-only', 2);

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        const trayProps = h.solidPanelProps.filter((props) => !props.panel.name.startsWith('sleeve_'));
        const sleeveProps = h.solidPanelProps.filter((props) => props.panel.name.startsWith('sleeve_'));
        expect(trayProps.length).toBeGreaterThan(0);
        expect(sleeveProps.length).toBeGreaterThan(0);
        expect(trayProps.every((props) => props.artworkPart === 'tray' && props.texture === h.fakeTexture)).toBe(true);
        expect(sleeveProps.every((props) => props.artworkPart === 'sleeve' && props.texture === null)).toBe(true);
        expect(trayProps[0].globalBBox).not.toEqual(sleeveProps[0].globalBBox);
        expect(h.solidPanelProps.every((props) => props.outerFaceNegativeZ === true)).toBe(true);
        expect(h.gussetProps).toHaveLength(4);
        expect(h.gussetProps.every((props) => props.hideCadLines === true)).toBe(true);
    });
    it('nối mask Spot-UV tuyến tính tới mọi panel 3D', async () => {
        useMockupStore.getState().setFinishId('spot-uv');
        useMockupStore.getState().setSpotUvMaskUrl('data:image/png;base64,spot-mask');

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.solidPanelProps.length).toBeGreaterThan(0);
        expect(h.solidPanelProps.every((props) => props.spotUvTexture === h.fakeTexture)).toBe(true);
        expect(h.fakeTexture.colorSpace).toBe(THREE.NoColorSpace);
        expect(h.fakeTexture.anisotropy).toBe(8);
    });
    it('nối mask emboss đã tải tới mọi panel 3D', async () => {
        useMockupStore.getState().setFinishId('emboss');
        useMockupStore.getState().setEmbossMaskUrl('data:image/png;base64,mask');
        useMockupStore.getState().setEmbossHeightMm(1.2);

        await act(async () => {
            render(e(DielineScene3D, null));
        });

        expect(h.solidPanelProps.length).toBeGreaterThan(0);
        expect(h.solidPanelProps.every((props) => props.embossTexture === h.fakeTexture)).toBe(true);
        expect(h.fakeTexture.colorSpace).toBe(THREE.NoColorSpace);
        expect(h.fakeTexture.anisotropy).toBe(8);
    });
    it('không rơi vào fallback HDRI khi vừa mount (EnvironmentRig còn cấp IBL)', async () => {
        await act(async () => {
            render(e(DielineScene3D, null));
        });
        // hdriStatus chưa 'failed' → môi trường vẫn đang cung cấp IBL/phản chiếu.
        expect(useMockupStore.getState().hdriStatus).not.toBe('failed');
    });

    it('môi trường thủ tục báo ready sau mount: hdriStatus = "ready" (không kẹt "loading", không "failed")', async () => {
        // Hồi quy lỗi wiring thứ tự effect: effect của StudioEnvironment (con)
        // chạy TRƯỚC effect mount của EnvironmentRig (cha). Trước khi sửa, effect
        // cha ghi đè 'ready' (do con đặt) về 'loading', rồi timer 10s bắn sang
        // 'failed'. Sau khi sửa, hdriStatus phải ổn định ở 'ready'.
        await act(async () => {
            render(e(DielineScene3D, null));
        });
        expect(useMockupStore.getState().hdriStatus).toBe('ready');
    });

    it('giữ texture contact shadow khi animation chạy và chụp lại khi đứng yên', async () => {
        await act(async () => {
            render(e(DielineScene3D, null));
        });
        expect(h.contactShadowProps.at(-1)?.frames).toBe(1);

        await act(async () => {
            useBoxStore.getState().setIsAnimating(true);
        });
        expect(h.contactShadowProps.at(-1)?.frames).toBe(0);

        await act(async () => {
            useBoxStore.getState().setIsAnimating(false);
        });
        expect(h.contactShadowProps.at(-1)?.frames).toBe(1);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 6.1 / 6.3 / 6.5 — useSceneExport.exportPNG
// ──────────────────────────────────────────────────────────────────────────

describe('useSceneExport — exportPNG (Yêu cầu 6.1, 6.5)', () => {
    function mountExportHarness() {
        const apiRef: { current: ReturnType<typeof useSceneExport> | null } = { current: null };
        function Harness() {
            const hookApi = useSceneExport();
            React.useEffect(() => {
                apiRef.current = hookApi;
            }, [hookApi]);
            return null;
        }
        render(e(Harness));
        return apiRef;
    }

    it('xuất PNG thành công qua render target riêng, không resize canvas hiển thị', async () => {
        const gl = makeFakeGl();
        h.threeState = makeFakeThreeState(gl);

        const api = mountExportHarness();
        let ok = false;
        await act(async () => {
            ok = await api.current!.exportPNG(1);
        });

        expect(ok).toBe(true);
        expect(gl.readRenderTargetPixels).toHaveBeenCalledOnce();
        expect(gl.setRenderTarget).toHaveBeenLastCalledWith(null);
        expect(gl.setSize).not.toHaveBeenCalled();
        // Tải file phía client: tạo object URL.
        expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBeGreaterThan(0);
        // Báo thành công.
        expect(toast.success).toHaveBeenCalled();
    });

    it('nhánh lỗi PNG (toBlob trả null): trả false, báo lỗi, KHÔNG ném và khôi phục cảnh', async () => {
        const gl = makeFakeGl();
        toBlobSpy!.mockImplementationOnce((callback: (blob: Blob | null) => void) => callback(null));
        h.threeState = makeFakeThreeState(gl);

        const api = mountExportHarness();
        let ok = true;
        await act(async () => {
            ok = await api.current!.exportPNG(1);
        });

        expect(ok).toBe(false);
        expect(toast.error).toHaveBeenCalled();
        expect(gl.setRenderTarget).toHaveBeenLastCalledWith(null);
        expect(gl.setSize).not.toHaveBeenCalled();
    });

    it('từ chối khi kích thước xuất vượt giới hạn (logic computeExportSize, giữ cảnh)', () => {
        // 8000 * 4 = 32000 > 16384 → không hợp lệ.
        expect(computeExportSize(8000, 4000, 4).ok).toBe(false);
        expect(computeExportSize(1920, 1080, 2).ok).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 6.3 / 6.6 — useSceneExport.exportGLB
// ──────────────────────────────────────────────────────────────────────────

describe('useSceneExport — exportGLB (Yêu cầu 6.3, 6.6)', () => {
    function mountExportHarness() {
        const apiRef: { current: ReturnType<typeof useSceneExport> | null } = { current: null };
        function Harness() {
            const hookApi = useSceneExport();
            React.useEffect(() => {
                apiRef.current = hookApi;
            }, [hookApi]);
            return null;
        }
        render(e(Harness));
        return apiRef;
    }

    it('xuất GLB thành công qua GLTFExporter: kích hoạt tải file nhị phân', async () => {
        h.glbResult = new ArrayBuffer(16); // binary=true → ArrayBuffer
        h.threeState = makeFakeThreeState();

        const api = mountExportHarness();
        let ok = false;
        await act(async () => {
            ok = await api.current!.exportGLB();
        });

        expect(ok).toBe(true);
        expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBeGreaterThan(0);
        expect(toast.success).toHaveBeenCalled();
    });

    it('nhánh lỗi GLB (parseAsync reject): trả false, báo lỗi, KHÔNG ném', async () => {
        h.glbReject = true;
        h.threeState = makeFakeThreeState();

        const api = mountExportHarness();
        let ok = true;
        await act(async () => {
            ok = await api.current!.exportGLB();
        });

        expect(ok).toBe(false);
        expect(toast.error).toHaveBeenCalled();
    });

    it('kết quả không phải ArrayBuffer (không binary) → coi là lỗi, giữ cảnh', async () => {
        h.glbResult = { not: 'a-buffer' }; // GLTF JSON thay vì GLB nhị phân
        h.threeState = makeFakeThreeState();

        const api = mountExportHarness();
        let ok = true;
        await act(async () => {
            ok = await api.current!.exportGLB();
        });

        expect(ok).toBe(false);
        expect(toast.error).toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 7.2 — CameraRig chuyển cảnh hoàn tất ≤500ms
// ──────────────────────────────────────────────────────────────────────────

describe('CameraRig — chuyển cảnh ≤500ms (Yêu cầu 7.2)', () => {
    it('animation hoàn tất trong ≤499ms: tại mốc 499ms camera đã tới đúng preset đích', async () => {
        const distance = 10;
        const state = makeFakeThreeState();
        h.threeState = state;

        // Điều khiển thời gian qua performance.now để mô phỏng vòng render.
        let nowValue = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => nowValue);

        // Yêu cầu transitionMs cố tình rất lớn (10s) — rig PHẢI tự giới hạn <500ms.
        await act(async () => {
            render(
                e(CameraRig, { center: [0, 0, 0], distance, transitionMs: 10000 }),
            );
        });

        // Đổi sang preset 'front' để khởi động một lượt chuyển cảnh mới.
        await act(async () => {
            useMockupStore.getState().setCameraPreset('front');
        });

        // "Tick" một frame tại mốc 499ms kể từ khi bắt đầu (nowValue khởi đầu 0).
        nowValue = 499;
        const frame = h.frameCallbacks[h.frameCallbacks.length - 1];
        expect(frame).toBeTypeOf('function');
        act(() => {
            frame();
        });

        // Preset 'front' nhìn dọc +Z → vị trí camera đích = (0, 0, distance).
        // Nếu thời lượng KHÔNG bị giới hạn (=10000ms) thì ở 499ms camera mới đi ~5%
        // và sẽ KHÔNG tới đích — assertion này chứng minh chuyển cảnh ≤500ms.
        expect(state.camera.position.x).toBeCloseTo(0, 3);
        expect(state.camera.position.y).toBeCloseTo(0, 3);
        expect(state.camera.position.z).toBeCloseTo(distance, 3);
    });
});

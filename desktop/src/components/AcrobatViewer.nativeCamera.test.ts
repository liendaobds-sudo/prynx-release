// UIUX (audit 2026-09-27 §V27.CAMERA): phát lại callback JSX thật để ACK Fit
// không bị hiểu nhầm là thao tác zoom tay rồi tự thoát chế độ vừa trang.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { NativeCameraSnapshot } from '../hooks/viewer/useNativeGpuViewport';

type FitMode = 'smart' | 'page' | 'width' | 'custom';
type CameraCallback = (camera: NativeCameraSnapshot, userInitiatedZoom?: boolean) => void;

function productionCameraCallback({ zoom = 1, fitMode = 'smart', domZoomActive = false }: {
    zoom?: number;
    fitMode?: FitMode;
    domZoomActive?: boolean;
} = {}) {
    const source = readFileSync(new URL('./AcrobatViewer.tsx', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('AcrobatViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const expressions: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'NativeGpuViewportContainer') {
            const attr = node.attributes.properties.find(item => ts.isJsxAttribute(item)
                && item.name.getText(ast) === 'onCameraChange');
            if (attr && ts.isJsxAttribute(attr) && attr.initializer
                && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                expressions.push(attr.initializer.expression.getText(ast));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(expressions).toHaveLength(1);

    const setZoom = vi.fn();
    const setFitMode = vi.fn<(value: FitMode) => void>();
    const physicalDisplayScale = 92 / 96;
    const code = ts.transpileModule(`return (${expressions[0]});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const bind = new Function('isZoomingRef', 'physicalDisplayScale', 'zoom', 'setZoom', 'setFitMode', 'fitMode', code) as
        (isZoomingRef: { current: boolean }, displayScale: number, currentZoom: number,
            changeZoom: typeof setZoom, changeMode: typeof setFitMode, currentMode: FitMode) => CameraCallback;
    const callback = bind({ current: domZoomActive }, physicalDisplayScale, zoom, setZoom, setFitMode, fitMode);
    return { callback, setZoom, setFitMode, physicalDisplayScale };
}

const snapshot = (zoom: number): NativeCameraSnapshot => ({
    zoom, pan_x: 372.00048828125, pan_y: 32,
    dpr: 1, viewport_width: 1812, viewport_height: 865,
});

describe('AcrobatViewer — quyền sở hữu camera native', () => {
    // Ca runtime host20552: không có wheel, fit_page trả zoom1.427146077;
    // callback cũ đổi smart thành custom chỉ vì zoom đã hiệu chuẩn khác1.
    it.each(['smart', 'page', 'width'] as const)('ACK Fit giữ chế độ %s và vẫn đồng bộ phần trăm', fitMode => {
        const { callback, setZoom, setFitMode, physicalDisplayScale } = productionCameraCallback({ fitMode });
        const camera = snapshot(1.427146077156067);
        callback(camera, false);
        expect(setZoom).toHaveBeenCalledExactlyOnceWith(camera.zoom / (physicalDisplayScale * 96 / 72));
        expect(setFitMode).not.toHaveBeenCalled();
    });

    it.each(['smart', 'page', 'width'] as const)('ACK scene không thoát chế độ %s', fitMode => {
        const { callback, setZoom, setFitMode } = productionCameraCallback({ fitMode });
        callback(snapshot(1.2489755153656006), false);
        expect(setZoom).toHaveBeenCalledOnce();
        expect(setFitMode).not.toHaveBeenCalled();
    });

    it.each(['smart', 'page', 'width'] as const)('ACK resize không thoát chế độ %s', fitMode => {
        const { callback, setZoom, setFitMode } = productionCameraCallback({ fitMode });
        callback({ ...snapshot(1.6), viewport_width: 2100, viewport_height: 1000 }, false);
        expect(setZoom).toHaveBeenCalledOnce();
        expect(setFitMode).not.toHaveBeenCalled();
    });

    it('payload cũ thiếu provenance không được tự nhận là zoom tay', () => {
        const { callback, setZoom, setFitMode } = productionCameraCallback();
        callback(snapshot(1.427146077156067));
        expect(setZoom).toHaveBeenCalledOnce();
        expect(setFitMode).not.toHaveBeenCalled();
    });

    it.each(['smart', 'page', 'width', 'custom'] as const)('zoom tay native thật chuyển %s sang custom', fitMode => {
        const { callback, setZoom, setFitMode } = productionCameraCallback({ fitMode });
        callback(snapshot(1.6412179470062256), true);
        expect(setZoom).toHaveBeenCalledOnce();
        expect(setFitMode).toHaveBeenCalledExactlyOnceWith('custom');
    });

    it('pan cùng mức zoom không ghi zoom hoặc chế độ Fit', () => {
        const { callback, setZoom, setFitMode, physicalDisplayScale } = productionCameraCallback();
        callback({ ...snapshot(physicalDisplayScale * 96 / 72), pan_x: -800, pan_y: -400 }, false);
        expect(setZoom).not.toHaveBeenCalled();
        expect(setFitMode).not.toHaveBeenCalled();
    });

    it('provenance zoom tay tới sau ACK cùng camera vẫn thoát Fit dù phần trăm đã đồng bộ', () => {
        const { callback, setZoom, setFitMode, physicalDisplayScale } = productionCameraCallback({ fitMode: 'page' });
        callback(snapshot(physicalDisplayScale * 96 / 72), true);
        expect(setZoom).not.toHaveBeenCalled();
        expect(setFitMode).toHaveBeenCalledExactlyOnceWith('custom');
    });

    it('sai số float của ACK không làm chạy lại cả cây trang', () => {
        const { callback, setZoom, setFitMode, physicalDisplayScale } = productionCameraCallback();
        callback(snapshot((1 + 0.00001) * physicalDisplayScale * 96 / 72), false);
        expect(setZoom).not.toHaveBeenCalled();
        expect(setFitMode).not.toHaveBeenCalled();
    });

    it.each([false, true])('camera native không giành quyền khi cử chỉ DOM còn active (manual=%s)', manual => {
        const { callback, setZoom, setFitMode } = productionCameraCallback({ domZoomActive: true });
        callback(snapshot(2), manual);
        expect(setZoom).not.toHaveBeenCalled();
        expect(setFitMode).not.toHaveBeenCalled();
    });
});

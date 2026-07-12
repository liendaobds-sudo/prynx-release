// ============================================================
// EnvironmentRig — Môi trường HDRI studio + IBL/phản chiếu (Render Layer)
//
// Cung cấp ánh sáng theo ảnh (IBL) và phản chiếu cho toàn cảnh mockup
// thông qua drei `Environment` (dùng PMREM nội bộ để sinh bản đồ phản
// chiếu). Cung cấp ≥3 preset studio để người dùng chọn (Yêu cầu 3.1,
// 3.2). Khi tài nguyên HDRI nạp lỗi HOẶC quá 10 giây, Rig chuyển sang
// chiếu sáng bằng đèn studio mặc định và hiển thị banner trạng thái,
// giữ cảnh ở trạng thái render được (Yêu cầu 3.6).
//
// RÀNG BUỘC PHÍA CLIENT (Yêu cầu 9.5): KHÔNG phát sinh bất kỳ request
// mạng nào. Vì vậy ta KHÔNG dùng thuộc tính `preset` của drei
// `Environment` (sẽ tải HDRI từ CDN polyhaven qua mạng). Thay vào đó,
// mỗi preset studio được dựng *thủ tục* (procedural) hoàn toàn cục bộ
// bằng các `Lightformer` đặt trong `Environment`; drei sẽ bake thành
// env map qua PMREM ngay trên GPU, không tải dữ liệu ngoài.
//
// HDRI ASSET CỤC BỘ: nếu sau này có tệp `.hdr`/`.exr` đóng gói trong
// bundle (import cục bộ qua bundler), chỉ cần đặt đường dẫn import vào
// trường `file` của preset; Rig sẽ tự nạp qua `Environment files=...`
// với cùng cơ chế xử lý lỗi/timeout. Hiện chưa có asset HDRI nào trong
// repo nên mọi preset mặc định dùng môi trường thủ tục (file = undefined)
// để bảo đảm 0 request mạng.
//
// Component này được thiết kế để render BÊN TRONG `<Canvas>` (lớp
// MockupCanvas). Tone mapping đặt trên renderer là trách nhiệm của
// MockupCanvas, không thuộc Rig này.
//
// _Requirements: 3.1, 3.2, 3.3, 3.6, 9.5_
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Environment, Lightformer, Html } from '@react-three/drei';
import { useMockupStore } from '../../store/useMockupStore';
import { useTranslation } from 'react-i18next';

// ─── Mô tả preset ───────────────────────────────────────────────────────────

/** Hình dạng nguồn sáng phẳng dùng để dựng môi trường studio thủ tục. */
type LightformerForm = 'circle' | 'ring' | 'rect';

/** Cấu hình một nguồn sáng phẳng (Lightformer) trong env map. */
interface LightformerConfig {
    form?: LightformerForm;
    intensity: number;
    color: string;
    position: [number, number, number];
    rotation?: [number, number, number];
    /** scale có thể là số đồng nhất hoặc [x, y]. */
    scale: number | [number, number];
}

/** Định nghĩa một preset Môi_Trường_HDRI studio. */
export interface HdriPreset {
    /** Id ổn định, dùng làm khóa trong store. */
    id: string;
    /** Nhãn hiển thị cho người dùng. */
    label: string;
    /**
     * Đường dẫn import cục bộ tới tệp HDRI (.hdr/.exr) nếu có.
     * Khi `undefined`, preset dựng môi trường thủ tục bằng Lightformer
     * (không request mạng). KHÔNG dùng id preset CDN ở đây.
     */
    file?: string;
    /** Màu nền môi trường dùng khi bake (không hiển thị làm background). */
    ambient: string;
    /** Tập nguồn sáng phẳng dựng nên môi trường studio. */
    lightformers: LightformerConfig[];
}

// ─── Thư viện preset studio (≥3 — Yêu cầu 3.2) ──────────────────────────────

/**
 * Tối thiểu 3 preset studio. Mỗi preset là một cấu hình ánh sáng studio
 * khác biệt rõ rệt (mềm / tương phản cao / trung tính lạnh / hoàng hôn ấm),
 * dựng hoàn toàn cục bộ.
 */
export const HDRI_PRESETS: HdriPreset[] = [
    {
        id: 'studio-soft',
        label: 'Studio mềm',
        ambient: '#dfe6ee',
        lightformers: [
            // Softbox lớn phía trên — key light dịu
            { form: 'rect', intensity: 3.0, color: '#fff6ec', position: [0, 6, 2], rotation: [-Math.PI / 2, 0, 0], scale: [10, 10] },
            // Fill mềm phía trước
            { form: 'rect', intensity: 1.2, color: '#eaf2ff', position: [0, 1, 8], rotation: [0, 0, 0], scale: [12, 6] },
            // Rim nhẹ hai bên
            { form: 'rect', intensity: 1.0, color: '#ffffff', position: [-8, 3, -2], rotation: [0, Math.PI / 2, 0], scale: [6, 8] },
            { form: 'rect', intensity: 1.0, color: '#ffffff', position: [8, 3, -2], rotation: [0, -Math.PI / 2, 0], scale: [6, 8] },
        ],
    },
    {
        id: 'studio-contrast',
        label: 'Studio tương phản',
        ambient: '#1a1d24',
        lightformers: [
            // Key light mạnh, hẹp
            { form: 'rect', intensity: 6.0, color: '#ffffff', position: [4, 6, 4], rotation: [-Math.PI / 3, Math.PI / 6, 0], scale: [4, 6] },
            // Rim sáng tách chủ thể khỏi nền tối
            { form: 'rect', intensity: 3.0, color: '#cfe0ff', position: [-6, 4, -4], rotation: [0, Math.PI / 2, 0], scale: [3, 8] },
            // Fill rất nhẹ giữ chi tiết vùng tối
            { form: 'circle', intensity: 0.6, color: '#ffffff', position: [0, 2, 7], scale: 6 },
        ],
    },
    {
        id: 'studio-cool',
        label: 'Studio trung tính lạnh',
        ambient: '#c9d6e8',
        lightformers: [
            { form: 'rect', intensity: 2.6, color: '#eef4ff', position: [0, 7, 0], rotation: [-Math.PI / 2, 0, 0], scale: [12, 12] },
            { form: 'rect', intensity: 1.4, color: '#dbe8ff', position: [-6, 3, 4], rotation: [0, Math.PI / 4, 0], scale: [6, 8] },
            { form: 'rect', intensity: 1.4, color: '#dbe8ff', position: [6, 3, 4], rotation: [0, -Math.PI / 4, 0], scale: [6, 8] },
            { form: 'ring', intensity: 0.8, color: '#ffffff', position: [0, 2, 9], scale: 5 },
        ],
    },
    {
        id: 'studio-warm',
        label: 'Studio ấm',
        ambient: '#efe0cf',
        lightformers: [
            { form: 'rect', intensity: 3.2, color: '#ffe7c4', position: [0, 6, 3], rotation: [-Math.PI / 2.5, 0, 0], scale: [10, 8] },
            { form: 'rect', intensity: 1.6, color: '#ffd9a0', position: [-7, 2, 2], rotation: [0, Math.PI / 3, 0], scale: [5, 7] },
            { form: 'circle', intensity: 1.0, color: '#fff0dc', position: [5, 3, 6], scale: 6 },
        ],
    },
];

/** Preset mặc định nếu id không khớp preset nào. */
const FALLBACK_PRESET: HdriPreset = HDRI_PRESETS[0];

/** Trả về preset theo id; id không hợp lệ → preset mặc định đầu tiên. */
export function getHdriPreset(id: string): HdriPreset {
    return HDRI_PRESETS.find((p) => p.id === id) ?? FALLBACK_PRESET;
}

/** Ngưỡng timeout nạp HDRI (Yêu cầu 3.6): quá 10 giây → fallback. */
export const HDRI_LOAD_TIMEOUT_MS = 10_000;

// ─── Error Boundary cách ly lỗi nạp môi trường ──────────────────────────────

interface EnvErrorBoundaryProps {
    onError: () => void;
    children: React.ReactNode;
}
interface EnvErrorBoundaryState {
    hasError: boolean;
}

/**
 * Bắt mọi lỗi render/nạp phát sinh trong cây con môi trường (ví dụ nạp
 * tệp HDRI cục bộ thất bại) để KHÔNG làm sập toàn bộ cảnh; thay vào đó
 * báo lỗi lên Rig để chuyển sang đèn studio dự phòng (Yêu cầu 3.6).
 */
class EnvErrorBoundary extends React.Component<EnvErrorBoundaryProps, EnvErrorBoundaryState> {
    state: EnvErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): EnvErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(): void {
        this.props.onError();
    }

    render(): React.ReactNode {
        return this.state.hasError ? null : this.props.children;
    }
}

// ─── Môi trường studio (thủ tục hoặc tệp HDRI cục bộ) ───────────────────────

interface StudioEnvironmentProps {
    preset: HdriPreset;
    onReady: (presetId: string) => void;
}

/**
 * Dựng env map studio.
 * - Nếu preset có `file` (HDRI cục bộ import qua bundler) → nạp qua
 *   `Environment files=...`. drei nạp đồng bộ qua loader; nếu lỗi sẽ
 *   ném lên `EnvErrorBoundary`.
 * - Ngược lại → dựng thủ tục bằng Lightformer, hoàn toàn cục bộ
 *   (0 request mạng — Yêu cầu 9.5).
 *
 * Trong cả hai trường hợp, môi trường cung cấp IBL + phản chiếu cho mọi
 * vật liệu trong cảnh (Yêu cầu 3.1).
 */
function StudioEnvironment({ preset, onReady }: StudioEnvironmentProps) {
    // Báo "ready" sau khi commit để Rig xóa timer và đặt hdriStatus='ready'.
    // Môi trường thủ tục sẵn sàng ngay khi mount (không tải dữ liệu ngoài),
    // nên luôn hoàn tất rất sớm so với ngưỡng 10 giây (Yêu cầu 3.3).
    //
    // LƯU Ý THỨ TỰ EFFECT: React chạy effect của component CON trước effect
    // của component CHA. Vì vậy `onReady` ở đây chạy TRƯỚC effect mount của
    // EnvironmentRig. Ta truyền kèm `preset.id` để Rig ghi nhận "đã ready cho
    // preset nào", giúp effect của cha không ghi đè ngược trạng thái về
    // 'loading' (xem readyPresetRef trong EnvironmentRig).
    useEffect(() => {
        onReady(preset.id);
    }, [onReady, preset]);

    // Nạp HDRI cục bộ nếu preset chỉ định tệp (hiện chưa dùng — chưa có asset).
    if (preset.file) {
        return (
            <Environment files={preset.file} resolution={256} background={false} />
        );
    }

    // Môi trường studio thủ tục — bake 1 frame thành env map qua PMREM.
    return (
        <Environment resolution={256} frames={1} background={false}>
            <color attach="background" args={[preset.ambient]} />
            {preset.lightformers.map((lf, i) => {
                // Lightformer scale nhận số đồng nhất hoặc vector 3 thành phần;
                // quy đổi [x, y] → [x, y, 1] cho khớp kiểu.
                const scale: number | [number, number, number] =
                    typeof lf.scale === 'number' ? lf.scale : [lf.scale[0], lf.scale[1], 1];
                return (
                    <Lightformer
                        key={i}
                        form={lf.form ?? 'rect'}
                        intensity={lf.intensity}
                        color={lf.color}
                        position={lf.position}
                        rotation={lf.rotation ?? [0, 0, 0]}
                        scale={scale}
                    />
                );
            })}
        </Environment>
    );
}

// ─── Đèn studio dự phòng + banner ───────────────────────────────────────────

/**
 * Tổ hợp đèn studio mặc định dùng khi HDRI thất bại/timeout (Yêu cầu 3.6).
 * Giữ cảnh ở trạng thái render được mà không cần env map.
 */
function FallbackStudioLights() {
    return (
        <>
            <ambientLight intensity={0.6} />
            <directionalLight position={[5, 8, 5]} intensity={0.9} castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.001} />
            <directionalLight position={[-5, 4, -4]} intensity={0.45} color="#e0f2fe" />
            <directionalLight position={[0, -6, 0]} intensity={0.2} color="#ffedd5" />
        </>
    );
}

/**
 * Banner thông báo trạng thái khi nạp HDRI thất bại (Yêu cầu 3.6).
 * Render qua drei `Html` (overlay DOM trên canvas); `pointerEvents:none`
 * để không chặn thao tác orbit/zoom.
 */
function HdriFailureBanner() {
  const { t } = useTranslation();
    return (
        <Html fullscreen prepend zIndexRange={[100, 0]} style={{ pointerEvents: 'none' }}>
            <div
                role="alert"
                className="dt-hdri-banner"
                style={{
                    position: 'absolute',
                    top: 8,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    maxWidth: '90%',
                    padding: '6px 14px',
                    borderRadius: 8,
                    background: 'rgba(180, 83, 9, 0.92)',
                    color: '#fff',
                    fontSize: '0.75rem',
                    lineHeight: 1.3,
                    textAlign: 'center',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                    pointerEvents: 'none',
                }}
            >
                {t('dieline.environmentRig:khong_nap_duoc_moi_truong_hdri_da')}
            </div>
        </Html>
    );
}

// ─── Component chính ────────────────────────────────────────────────────────

/**
 * EnvironmentRig — quản lý preset HDRI, IBL/phản chiếu và fallback.
 *
 * Đọc `hdriPreset`/`hdriStatus` và cập nhật `hdriStatus` qua `useMockupStore`.
 * Vòng đời mỗi lần đổi preset:
 *  1. Đặt `hdriStatus='loading'`, khởi động timer 10 giây.
 *  2. Khi môi trường sẵn sàng → xóa timer, đặt `hdriStatus='ready'`.
 *  3. Nếu lỗi nạp (ErrorBoundary) HOẶC quá 10 giây → đặt `hdriStatus='failed'`,
 *     render đèn studio dự phòng + banner (Yêu cầu 3.6).
 */
export default function EnvironmentRig() {
    const hdriPreset = useMockupStore((s) => s.hdriPreset);
    const hdriStatus = useMockupStore((s) => s.hdriStatus);
    const setHdriStatus = useMockupStore((s) => s.setHdriStatus);

    const [failed, setFailed] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Preset đang hiển thị, đã resolve (id không hợp lệ → preset mặc định).
    const preset = getHdriPreset(hdriPreset);
    const presetId = preset.id;

    // Id preset hiện tại, cập nhật trong lúc render để effect/handler luôn
    // đọc được giá trị mới nhất mà không cần phụ thuộc.
    const currentPresetRef = useRef(presetId);
    currentPresetRef.current = presetId;

    // Preset mà StudioEnvironment đã báo "ready". Vì React chạy effect của
    // component CON trước effect của CHA, child có thể báo ready TRƯỚC khi
    // effect mount của Rig chạy. Ref này cho effect cha biết "đã ready cho
    // preset hiện tại" để KHÔNG ghi đè ngược trạng thái về 'loading' rồi để
    // timer 10 giây bắn nhầm sang 'failed' (lỗi wiring thứ tự effect).
    const readyPresetRef = useRef<string | null>(null);

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const handleReady = useCallback((readyId: string) => {
        readyPresetRef.current = readyId;
        clearTimer();
        setHdriStatus('ready');
    }, [clearTimer, setHdriStatus]);

    const handleError = useCallback(() => {
        clearTimer();
        setFailed(true);
        setHdriStatus('failed');
    }, [clearTimer, setHdriStatus]);

    // Vòng đời mỗi lần đổi preset. Effect này chạy SAU effect của
    // StudioEnvironment (con). Nếu con đã báo ready cho đúng preset hiện tại
    // (trường hợp môi trường thủ tục — sẵn sàng ngay khi mount), ta giữ
    // 'ready' và KHÔNG khởi động timer, tránh ghi đè 'loading'. Ngược lại
    // (vd HDRI cục bộ đang nạp/treo) mới đặt 'loading' + timer 10 giây để
    // còn fallback khi nạp lỗi/quá hạn (Yêu cầu 3.3, 3.6).
    useEffect(() => {
        setFailed(false);
        clearTimer();

        if (readyPresetRef.current === presetId) {
            setHdriStatus('ready');
            return clearTimer;
        }

        setHdriStatus('loading');
        timerRef.current = setTimeout(() => {
            setFailed(true);
            setHdriStatus('failed');
        }, HDRI_LOAD_TIMEOUT_MS);

        return clearTimer;
    }, [presetId, setHdriStatus, clearTimer]);

    // Đường dẫn dự phòng: đèn studio mặc định + banner trạng thái.
    if (failed || hdriStatus === 'failed') {
        return (
            <>
                <FallbackStudioLights />
                <HdriFailureBanner />
            </>
        );
    }

    return (
        <EnvErrorBoundary onError={handleError}>
            <StudioEnvironment preset={preset} onReady={handleReady} />
        </EnvErrorBoundary>
    );
}

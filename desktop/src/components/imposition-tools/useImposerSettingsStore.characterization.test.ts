// @vitest-environment jsdom
/**
 * Characterization ("golden snapshot") test cho useImposerSettingsStore.
 *
 * Mục đích: CHỐT hành vi store TRƯỚC khi refactor tách slice (spec imposer-store-slicing).
 * Test BLACK-BOX qua API công khai + localStorage → chạy y hệt TRƯỚC và SAU refactor.
 * Nếu refactor làm lệch default state / partialize keys / migration / tool-profile → ĐỎ.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createImposerSettingsStore } from './useImposerSettingsStore';

const PERSIST_KEY = 'ps_imposer_settings';

function defaultStateSnapshot() {
    localStorage.clear();
    const store = createImposerSettingsStore();
    const s = store.getState() as Record<string, any>;
    // Chỉ giữ field dữ liệu (bỏ function/action) để snapshot ổn định.
    const data: Record<string, any> = {};
    for (const k of Object.keys(s).sort()) {
        if (typeof s[k] !== 'function') data[k] = s[k];
    }
    return data;
}

describe('useImposerSettingsStore — characterization (golden)', () => {
    beforeEach(() => localStorage.clear());

    it('default state (mọi field dữ liệu) khớp snapshot vàng', () => {
        expect(defaultStateSnapshot()).toMatchSnapshot();
    });

    it('tập partialize keys (đưa vào localStorage) khớp snapshot vàng', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        // Kích hoạt persist bằng 1 set bất kỳ → localStorage được ghi với đúng partialize.
        store.getState().setBleed(store.getState().bleed);
        const raw = localStorage.getItem(PERSIST_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw as string);
        expect(parsed.version).toBe(9);
        const keys = Object.keys(parsed.state).sort();
        expect(keys).toMatchSnapshot();
    });

    it('migration v6 → v7: thêm gangCount/showGangCount vào reportDisplay', () => {
        localStorage.clear();
        // Giả lập state persist version 6 KHÔNG có gangCount.
        const v6 = {
            state: {
                reportDisplay: {
                    enabled: true,
                    fieldOrder: ['orderCode', 'identifier', 'labelName', 'material'],
                    showIdentifier: true,
                },
            },
            version: 6,
        };
        localStorage.setItem(PERSIST_KEY, JSON.stringify(v6));
        const store = createImposerSettingsStore();
        const rd = store.getState().reportDisplay as any;
        expect(rd.showGangCount).toBe(true);
        expect(rd.fieldOrder).toContain('gangCount');
        // gangCount chèn ngay sau identifier
        expect(rd.fieldOrder.indexOf('gangCount')).toBe(rd.fieldOrder.indexOf('identifier') + 1);
    });

    it('migration v7 → v8: persist resizeSettings (nhớ thiết lập co giãn trang)', () => {
        localStorage.clear();
        const v7 = {
            state: {
                resizeSettings: {
                    sizePresetId: 'A3',
                    targetW: 297,
                    targetH: 420,
                    scaleMode: 'fill',
                    applyTo: 'all',
                    applyToStr: 'all',
                    resizeMode: 'vector',
                    targetDpi: 150,
                },
            },
            version: 7,
        };
        localStorage.setItem(PERSIST_KEY, JSON.stringify(v7));
        const store = createImposerSettingsStore();
        const rs = store.getState().resizeSettings as any;
        expect(rs.sizePresetId).toBe('A3');
        expect(rs.scaleMode).toBe('fill');
        expect(rs.targetDpi).toBe(150);
        expect(rs.resizeMode).toBe('vector');
    });

    it('switchToolProfile lưu/khôi phục field thuật toán theo công cụ', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        const st = () => store.getState();

        // Đặt field thuật toán cho "nup"
        st().setScaleMode('fit');
        st().setSignatureMode('thread');

        // Chuyển nup → booklet: lưu profile nup, booklet chưa có profile (không restore)
        st().switchToolProfile('nup', 'booklet');
        // Thay đổi ở booklet
        st().setScaleMode('100');
        st().setSignatureMode('saddle');

        // Quay lại booklet → nup: phải khôi phục profile nup đã lưu
        st().switchToolProfile('booklet', 'nup');
        expect(st().scaleMode).toBe('fit');
        expect(st().signatureMode).toBe('thread');
    });

    it('switchToolProfile bỏ qua khi tool không nằm trong PROFILED_TOOLS', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        const st = () => store.getState();
        st().setScaleMode('fit');
        st().switchToolProfile('nup', 'unknown_tool');
        // Không đổi state thuật toán
        expect(st().scaleMode).toBe('fit');
    });

    it('mỗi công cụ nhớ riêng taskMode (Bình trang / Dàn nhiều mẫu)', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        const st = () => store.getState();

        // Tem bế: Bình trang
        st().setActiveDashboardTool('sticker_imposer');
        st().setTaskMode('step_repeat');
        expect(st().taskMode).toBe('step_repeat');
        expect(st().toolProfiles.sticker_imposer?.taskMode).toBe('step_repeat');

        // Chuyển sang cắt xén: mặc định dàn nhiều mẫu (chưa có profile)
        st().switchToolProfile('sticker_imposer', 'nup');
        expect(st().taskMode).toBe('nup');
        st().setActiveDashboardTool('nup');
        st().setTaskMode('nup');

        // Bế rớt: Bình trang riêng
        st().switchToolProfile('nup', 'cnc_imposer');
        expect(st().taskMode).toBe('nup'); // first visit default
        st().setActiveDashboardTool('cnc_imposer');
        st().setTaskMode('step_repeat');
        expect(st().toolProfiles.cnc_imposer?.taskMode).toBe('step_repeat');

        // Quay lại tem bế: vẫn Bình trang
        st().switchToolProfile('cnc_imposer', 'sticker_imposer');
        expect(st().taskMode).toBe('step_repeat');

        // Quay lại bế rớt: vẫn Bình trang
        st().switchToolProfile('sticker_imposer', 'cnc_imposer');
        expect(st().taskMode).toBe('step_repeat');

        // Cắt xén vẫn Dàn nhiều mẫu
        st().switchToolProfile('cnc_imposer', 'nup');
        expect(st().taskMode).toBe('nup');
    });

    it('restoreTaskModeForTool nạp đúng profile, chuẩn hoá legacy sticker_imposer → nup', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        const st = () => store.getState();

        st().setActiveDashboardTool('sticker_imposer');
        // Giả lập profile cũ (identity tool bị lưu như taskMode)
        store.setState({
            toolProfiles: {
                sticker_imposer: { taskMode: 'sticker_imposer' },
                cnc_imposer: { taskMode: 'step_repeat' },
            },
        } as any);

        st().restoreTaskModeForTool('sticker_imposer');
        expect(st().taskMode).toBe('nup');

        st().restoreTaskModeForTool('cnc_imposer');
        expect(st().taskMode).toBe('step_repeat');
    });

    it('dao cắt luôn mặc định khi vào tem bế / CNC (không nhớ 1 Dao lần trước)', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        const st = () => store.getState();

        st().setActiveDashboardTool('sticker_imposer');
        st().setCutType('one_dao');
        st().setDieSizeMode('page');
        st().setDieOffsetMm(-1);
        expect(st().cutType).toBe('one_dao');

        // Rời tem bế → profile không còn lưu cutType; vào lại → luôn default
        st().switchToolProfile('sticker_imposer', 'nup');
        st().switchToolProfile('nup', 'sticker_imposer');
        expect(st().cutType).toBe('default');
        expect(st().dieSizeMode).toBe('die');
        expect(st().dieOffsetMm).toBe(0);

        // Legacy profile có cutType one_dao cũng bị bỏ qua
        store.setState({
            toolProfiles: {
                cnc_imposer: { taskMode: 'step_repeat', cutType: 'one_dao', dieSizeMode: 'page' },
            },
            cutType: 'one_dao',
        } as any);
        st().switchToolProfile('sticker_imposer', 'cnc_imposer');
        expect(st().cutType).toBe('default');
        expect(st().dieSizeMode).toBe('die');
        expect(st().dieOffsetMm).toBe(0);
        // taskMode vẫn nhớ riêng
        expect(st().taskMode).toBe('step_repeat');
    });

    it('vào tem bế/CNC reset clusterMode=none (chống rò chia cọc N-Up)', () => {
        localStorage.clear();
        const store = createImposerSettingsStore();
        const st = () => store.getState();

        st().setActiveDashboardTool('nup');
        st().setClusterMode('row');
        st().setClusterCount(3);
        expect(st().clusterMode).toBe('row');

        st().switchToolProfile('nup', 'sticker_imposer');
        expect(st().clusterMode).toBe('none');

        // N-Up vẫn nhớ row sau khi quay lại
        st().setClusterMode('column'); // user đổi trong tem… rồi sang nup
        st().switchToolProfile('sticker_imposer', 'nup');
        expect(st().clusterMode).toBe('row');
    });
});

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
        expect(parsed.version).toBe(7);
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
});

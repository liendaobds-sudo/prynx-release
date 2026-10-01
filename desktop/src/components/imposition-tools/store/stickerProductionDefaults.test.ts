// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createImposerSettingsStore } from '../useImposerSettingsStore';

describe('M72.C — mặc định đơn hàng của Bình tem bế', () => {
  beforeEach(() => localStorage.clear());
  it('mở trực tiếp tem bế mới: SL 1 và xếp tự do', () => {
    const store = createImposerSettingsStore();
    store.getState().restoreTaskModeForTool('sticker_imposer');
    expect(store.getState().targetQuantity).toBe(1);
    expect(store.getState().groupingStrategy).toBe('free_gang');
  });
  it('chuyển từ cắt xén không mang theo SL/cách chia cụm', () => {
    const store = createImposerSettingsStore();
    store.getState().setTargetQuantity(500);
    store.getState().switchToolProfile('nup', 'sticker_imposer');
    expect(store.getState().targetQuantity).toBe(1);
    expect(store.getState().groupingStrategy).toBe('free_gang');
    store.getState().switchToolProfile('sticker_imposer', 'nup');
    expect(store.getState().targetQuantity).toBe(500);
  });
  it('không ghi đè lựa chọn lấp đầy đã lưu', () => {
    const store = createImposerSettingsStore();
    store.setState({ toolProfiles: { sticker_imposer: { taskMode: 'nup', targetQuantity: 0, groupingStrategy: 'maximize_area' } } });
    store.getState().switchToolProfile('nup', 'sticker_imposer');
    expect(store.getState().targetQuantity).toBe(0);
    expect(store.getState().groupingStrategy).toBe('maximize_area');
  });
  it('lưu cờ Tự lấp đầy riêng theo từng profile công cụ', () => {
    const store = createImposerSettingsStore();
    store.setState({ autoFill: true });
    store.getState().switchToolProfile('nup', 'sticker_imposer');
    expect(store.getState().autoFill).toBe(false);
    store.getState().switchToolProfile('sticker_imposer', 'nup');
    expect(store.getState().autoFill).toBe(true);
  });
  it('profile cũ thiếu cờ Tự lấp đầy không giữ cờ của công cụ trước', () => {
    const store = createImposerSettingsStore();
    store.setState({ autoFill: true, toolProfiles: { sticker_imposer: { taskMode: 'nup' } } });
    store.getState().switchToolProfile('nup', 'sticker_imposer');
    expect(store.getState().autoFill).toBe(false);
  });
  it('không đổi default CNC/cắt xén hoặc snapshot global', () => {
    const store = createImposerSettingsStore();
    expect(store.getState().targetQuantity).toBe(0);
    store.getState().restoreTaskModeForTool('cnc_imposer');
    expect(store.getState().targetQuantity).toBe(0);
  });
});

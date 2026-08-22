import { describe, expect, it, vi } from 'vitest';

import {
  createLatestSettingsWriteQueue,
  normalizePersistedRightMenuSettings,
  useAppSettingsStore,
} from './appSettingsStore';

const fallbackLayout = {
  toolMenuWidth: 390,
  homeToolMenuWidth: 320,
  toolMenuMode: 'full' as const,
  isToolMenuExpanded: false,
  isWorkspaceSidebarOpen: true,
};

describe('appSettingsStore — persistence menu công cụ phải', () => {
  it('tuần tự hóa lượt ghi và chỉ giữ snapshot mới nhất đang chờ', async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writtenValues: string[] = [];
    const writer = vi.fn(async ({ value }: { name: string; value: string }) => {
      writtenValues.push(value);
      if (value === 'snapshot-1') await firstWriteGate;
    });
    const enqueue = createLatestSettingsWriteQueue(writer);

    const first = enqueue('settings', 'snapshot-1');
    expect(writtenValues).toEqual(['snapshot-1']);

    const second = enqueue('settings', 'snapshot-2');
    const latest = enqueue('settings', 'snapshot-3');
    expect(writtenValues).toEqual(['snapshot-1']);

    releaseFirstWrite();
    await Promise.all([first, second, latest]);

    expect(writtenValues).toEqual(['snapshot-1', 'snapshot-3']);
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it('cho phép lượt ghi mới chạy sau khi hàng đợi đã rỗng', async () => {
    const writer = vi.fn(async () => undefined);
    const enqueue = createLatestSettingsWriteQueue(writer);

    await enqueue('settings', 'snapshot-1');
    await enqueue('settings', 'snapshot-2');

    expect(writer).toHaveBeenNthCalledWith(1, {
      name: 'settings',
      value: 'snapshot-1',
    });
    expect(writer).toHaveBeenNthCalledWith(2, {
      name: 'settings',
      value: 'snapshot-2',
    });
  });

  it('giữ fallback khi dữ liệu hydrate không có state menu', () => {
    expect(normalizePersistedRightMenuSettings({}, fallbackLayout)).toEqual(fallbackLayout);
    expect(normalizePersistedRightMenuSettings(null, fallbackLayout)).toEqual(fallbackLayout);
  });

  it('clamp chiều rộng và lấy mode làm nguồn chuẩn duy nhất', () => {
    expect(normalizePersistedRightMenuSettings({
      toolMenuWidth: 4_000,
      homeToolMenuWidth: -20,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
    }, fallbackLayout)).toEqual({
      toolMenuWidth: 800,
      homeToolMenuWidth: 200,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: false,
    });
  });

  it('migrate open + width cũ sang mode tường minh và full width hợp lệ', () => {
    expect(normalizePersistedRightMenuSettings({
      toolMenuWidth: 100,
      isWorkspaceSidebarOpen: false,
    }, fallbackLayout)).toMatchObject({
      toolMenuWidth: 280,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: false,
    });

    expect(normalizePersistedRightMenuSettings({
      toolMenuWidth: 220,
      isWorkspaceSidebarOpen: false,
    }, fallbackLayout)).toMatchObject({
      toolMenuWidth: 280,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: false,
    });
  });

  it('dùng home width cũ làm preferred full width khi chưa có workspace width', () => {
    expect(normalizePersistedRightMenuSettings({
      homeToolMenuWidth: 450,
    }, fallbackLayout)).toMatchObject({
      toolMenuWidth: 450,
      homeToolMenuWidth: 450,
      toolMenuMode: 'full',
    });
  });

  it('clamp seed Home khi dữ liệu cũ chỉ có workspace width lớn', () => {
    expect(normalizePersistedRightMenuSettings({
      toolMenuWidth: 800,
    }, fallbackLayout)).toMatchObject({
      toolMenuWidth: 800,
      homeToolMenuWidth: 600,
    });
  });

  it('giữ riêng width Home và width workspace khi cả hai đã được lưu', () => {
    expect(normalizePersistedRightMenuSettings({
      toolMenuWidth: 520,
      homeToolMenuWidth: 240,
      toolMenuMode: 'full',
    }, fallbackLayout)).toMatchObject({
      toolMenuWidth: 520,
      homeToolMenuWidth: 240,
    });
  });

  it('chuyển mode atomically và giữ preferred width khi caller yêu cầu min 280', () => {
    useAppSettingsStore.setState({
      toolMenuWidth: 320,
      toolMenuMode: 'full',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
    });

    useAppSettingsStore.getState().setToolMenuLayout('icons');
    expect(useAppSettingsStore.getState()).toMatchObject({
      toolMenuWidth: 320,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: false,
    });

    useAppSettingsStore.getState().openWorkspaceSidebar(280);
    expect(useAppSettingsStore.getState()).toMatchObject({
      toolMenuWidth: 320,
      toolMenuMode: 'full',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
    });

    useAppSettingsStore.getState().collapseWorkspaceSidebar();
    expect(useAppSettingsStore.getState()).toMatchObject({
      toolMenuWidth: 320,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: false,
    });
  });

  it('không notify subscriber khi lặp lại cùng layout', () => {
    useAppSettingsStore.setState({
      toolMenuWidth: 390,
      toolMenuMode: 'full',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
    });
    const listener = vi.fn();
    const unsubscribe = useAppSettingsStore.subscribe(listener);

    useAppSettingsStore.getState().openWorkspaceSidebar();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('mở panel không tự nở width 300 lên 390', () => {
    useAppSettingsStore.setState({
      toolMenuWidth: 300,
      toolMenuMode: 'icons',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: false,
    });

    useAppSettingsStore.getState().openWorkspaceSidebar();

    expect(useAppSettingsStore.getState()).toMatchObject({
      toolMenuWidth: 300,
      toolMenuMode: 'full',
      isWorkspaceSidebarOpen: true,
    });
  });

  it('đổi width Home không làm thay đổi width workspace', () => {
    useAppSettingsStore.setState({
      toolMenuWidth: 520,
      homeToolMenuWidth: 320,
    });

    useAppSettingsStore.getState().setHomeToolMenuWidth(240);

    expect(useAppSettingsStore.getState()).toMatchObject({
      toolMenuWidth: 520,
      homeToolMenuWidth: 240,
    });
  });
});

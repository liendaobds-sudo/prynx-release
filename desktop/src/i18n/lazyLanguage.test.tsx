// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const englishCatalog = {
  shell: { dong_cua_so: 'Close window', dong_alt_f4: '' },
  catalog: { khuon_be_bao_bi: 'Packaging Die' },
  'dieline.dielineGallery': { khuon_be_bao_bi: 'Packaging Dielines' },
  'misc.languageToggle': {
    chuyen_sang_tieng_viet: 'Switch to Vietnamese',
    chuyen_sang_english: 'Switch to English',
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockDelayedEnglish() {
  const gate = deferred<void>();
  const loadEnglish = vi.fn(async () => {
    await gate.promise;
    return { default: englishCatalog };
  });
  vi.doMock('./locales/en.json', loadEnglish);
  return { gate, loadEnglish };
}

let cleanupRendered: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(async () => {
  cleanupRendered?.();
  cleanupRendered = undefined;
  // i18next là dependency external nên resetModules không tạo singleton mới.
  // Không để listener của ca trước chạy trong lần init của ca tiếp theo.
  const { default: i18n } = await import('i18next');
  i18n.off('languageChanged');
  i18n.off('languageChanging');
  vi.doUnmock('./locales/en.json');
  vi.doUnmock('@tauri-apps/api/path');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PERF28.05 — chỉ nạp English khi cần', () => {
  it('khởi động tiếng Việt không đọc hay đăng ký catalog English', async () => {
    const loadEnglish = vi.fn(() => ({ default: englishCatalog }));
    vi.doMock('./locales/en.json', loadEnglish);

    const { default: i18n, tv } = await import('./index');

    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe('vi');
    expect(i18n.t('shell:dong_cua_so')).toBe('Đóng cửa sổ');
    expect(tv('Khuôn bế Bao bì')).toBe('Khuôn bế Bao bì');
    expect(loadEnglish).not.toHaveBeenCalled();
    expect(i18n.hasResourceBundle('en', 'shell')).toBe(false);
  });

  it('đổi English giữ fallback tiếng Việt cho khóa thiếu hoặc rỗng', async () => {
    vi.doMock('./locales/en.json', () => ({ default: englishCatalog }));
    const { default: i18n, tv } = await import('./index');

    await i18n.changeLanguage('en');

    expect(i18n.t('shell:dong_cua_so')).toBe('Close window');
    expect(i18n.t('shell:dong_alt_f4')).toBe('Đóng (Alt+F4)');
    expect(i18n.t('shell:phong_to')).toBe('Phóng to');
    expect(tv('Khuôn bế Bao bì')).toBe('Packaging Die');
    expect(tv('Khuôn bế Bao bì', 'dieline.dielineGallery')).toBe('Packaging Dielines');
    expect(tv('Chuỗi chưa có trong danh mục')).toBe('Chuỗi chưa có trong danh mục');
    expect(tv(undefined)).toBe('');
    expect(tv(null)).toBe('');
    expect(tv('')).toBe('');
  });

  it('giữ VI trong lúc tải, chỉ phát thay đổi khi đủ mọi namespace', async () => {
    const { gate, loadEnglish } = mockDelayedEnglish();
    const { default: i18n } = await import('./index');
    const changed = vi.fn(() => {
      const namespaces = Object.keys(i18n.options.resources?.vi ?? {});
      expect(namespaces.length).toBeGreaterThan(100);
      expect(namespaces.every(namespace => i18n.hasResourceBundle('en', namespace))).toBe(true);
    });
    i18n.on('languageChanged', changed);
    const pending = i18n.changeLanguage('en');
    await vi.waitFor(() => expect(loadEnglish).toHaveBeenCalledTimes(1));

    expect(i18n.language).toBe('vi');
    expect(i18n.t('shell:dong_cua_so')).toBe('Đóng cửa sổ');
    expect(changed).not.toHaveBeenCalled();
    gate.resolve();
    await pending;

    expect(i18n.language).toBe('en');
    expect(changed).toHaveBeenCalledExactlyOnceWith('en');
  });

  it('nhiều yêu cầu EN cùng lúc dùng chung catalog và đổi lại không tải thêm', async () => {
    const { gate, loadEnglish } = mockDelayedEnglish();
    const { default: i18n } = await import('./index');
    const pending = [i18n.changeLanguage('en'), i18n.changeLanguage('en')];
    await vi.waitFor(() => expect(loadEnglish).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all(pending);
    expect(i18n.t('shell:dong_cua_so')).toBe('Close window');

    await i18n.changeLanguage('vi');
    await i18n.changeLanguage('en');
    expect(loadEnglish).toHaveBeenCalledTimes(1);
    expect(i18n.t('shell:dong_cua_so')).toBe('Close window');
  });

  it.each(['vi', 'en'] as const)('EN chậm không ghi đè lựa chọn mới nhất %s', async (latest) => {
    const { gate, loadEnglish } = mockDelayedEnglish();
    const { default: i18n } = await import('./index');
    const pendingEnglish = i18n.changeLanguage('en');
    await vi.waitFor(() => expect(loadEnglish).toHaveBeenCalledTimes(1));
    await i18n.changeLanguage('vi');
    const pendingLatest = latest === 'en' ? i18n.changeLanguage('en') : Promise.resolve();
    gate.resolve();
    await Promise.all([pendingEnglish, pendingLatest]);

    expect(i18n.language).toBe(latest);
    expect(i18n.t('shell:dong_cua_so')).toBe(latest === 'vi' ? 'Đóng cửa sổ' : 'Close window');
    expect(loadEnglish).toHaveBeenCalledTimes(1);
  });

  it('lỗi chunk giữ fallback VI và lần chọn EN sau được thử lại', async () => {
    const loadFailed = vi.fn(() => { throw new Error('Chunk chưa đọc được'); });
    vi.doMock('./locales/en.json', loadFailed);
    const { default: i18n } = await import('./index');
    const finished = vi.fn();

    await i18n.changeLanguage('en', finished);

    expect(loadFailed).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0]).toBeTruthy();
    expect(i18n.t('shell:dong_cua_so')).toBe('Đóng cửa sổ');
    expect(i18n.hasResourceBundle('en', 'shell')).toBe(false);

    // Mô phỏng lần đọc chunk tiếp theo thành công, không sửa trạng thái nội bộ i18next.
    const loadRetry = vi.fn(() => ({ default: englishCatalog }));
    vi.doMock('./locales/en.json', loadRetry);
    await i18n.changeLanguage('vi');
    await i18n.changeLanguage('en');

    expect(loadRetry).toHaveBeenCalledTimes(1);
    expect(i18n.t('shell:dong_cua_so')).toBe('Close window');
  });

  it('lỗi EN đang tải không đổi ngược lựa chọn VI mới hơn', async () => {
    const { gate, loadEnglish } = mockDelayedEnglish();
    const { default: i18n } = await import('./index');
    const pending = i18n.changeLanguage('en');
    await vi.waitFor(() => expect(loadEnglish).toHaveBeenCalledTimes(1));
    await i18n.changeLanguage('vi');
    gate.reject(new Error('Chunk chưa đọc được'));
    await pending;

    expect(i18n.language).toBe('vi');
    expect(i18n.t('shell:dong_cua_so')).toBe('Đóng cửa sổ');
  });

  it('khôi phục EN đã lưu qua store bất đồng bộ, không cần caller mới', async () => {
    const { gate, loadEnglish } = mockDelayedEnglish();
    vi.doMock('@tauri-apps/api/path', () => ({
      appDataDir: async () => { throw new Error('Test không chạy trong Tauri'); },
    }));
    localStorage.setItem('pryn-x-app-settings', JSON.stringify({ state: { language: 'en' }, version: 0 }));
    const { default: i18n } = await import('./index');
    const { useAppSettingsStore } = await import('../stores/appSettingsStore');
    await vi.waitFor(() => expect(loadEnglish).toHaveBeenCalledTimes(1));

    expect(useAppSettingsStore.getState().language).toBe('en');
    expect(i18n.language).toBe('vi');
    expect(i18n.t('shell:dong_cua_so')).toBe('Đóng cửa sổ');
    gate.resolve();
    await vi.waitFor(() => expect(i18n.language).toBe('en'));
    expect(i18n.t('shell:dong_cua_so')).toBe('Close window');
  });

  it.each(['vi', 'en'] as const)('nút ngôn ngữ giữ lựa chọn %s và cập nhật React khi chunk hoàn tất', async (latest) => {
    const { gate, loadEnglish } = mockDelayedEnglish();
    vi.doMock('@tauri-apps/api/path', () => ({
      appDataDir: async () => { throw new Error('Test không chạy trong Tauri'); },
    }));
    const { default: i18n } = await import('./index');
    const { useAppSettingsStore } = await import('../stores/appSettingsStore');
    await vi.waitFor(() => expect(useAppSettingsStore.persist.hasHydrated()).toBe(true));
    const { LanguageToggle } = await import('../components/LanguageToggle');
    const { createElement } = await import('react');
    const { act, cleanup, fireEvent, render } = await import('@testing-library/react/pure');
    cleanupRendered = cleanup;
    const view = render(createElement(LanguageToggle));

    fireEvent.click(view.getByRole('button'));
    await vi.waitFor(() => expect(loadEnglish).toHaveBeenCalledTimes(1));
    expect(view.getByText('EN')).toBeTruthy();
    expect(view.getByRole('button').title).toBe('Chuyển sang Tiếng Việt');
    if (latest === 'vi') {
      fireEvent.click(view.getByRole('button'));
      expect(view.getByText('VN')).toBeTruthy();
    }
    await act(async () => {
      gate.resolve();
      await vi.dynamicImportSettled();
    });
    expect(useAppSettingsStore.getState().language).toBe(latest);
    expect(i18n.language).toBe(latest);
    expect(i18n.t('shell:dong_cua_so')).toBe(latest === 'vi' ? 'Đóng cửa sổ' : 'Close window');
    expect(view.getByRole('button').title).toBe(latest === 'vi' ? 'Chuyển sang English' : 'Switch to Vietnamese');
  });

  it.each([true, false])('collision diagnostic chỉ chạy khi DEV=%s và đã tải EN', async (development) => {
    vi.stubEnv('DEV', development);
    localStorage.setItem('tvDebug', '1');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    const loadEnglish = vi.fn(() => ({ default: englishCatalog }));
    vi.doMock('./locales/en.json', loadEnglish);
    const { default: i18n } = await import('./index');
    expect(loadEnglish).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();

    await i18n.changeLanguage('en');

    if (development) {
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0][0]).toContain('catalog:khuon_be_bao_bi');
      expect(warning.mock.calls[0][0]).toContain('dieline.dielineGallery:khuon_be_bao_bi');
    } else {
      expect(warning).not.toHaveBeenCalled();
    }
  });

  it('storage diagnostic bị chặn không làm hỏng lần đổi EN', async () => {
    vi.stubEnv('DEV', true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage bị chặn');
    });
    vi.doMock('./locales/en.json', () => ({ default: englishCatalog }));
    const { default: i18n } = await import('./index');
    await i18n.changeLanguage('en');
    expect(i18n.t('shell:dong_cua_so')).toBe('Close window');
  });
});

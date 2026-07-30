// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { saveBlob } from './saveBlob';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

describe('saveBlob', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete window.__TAURI_INTERNALS__;
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: vi.fn(() => 'blob:svg-download'),
            revokeObjectURL: vi.fn(),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete window.__TAURI_INTERNALS__;
    });

    it('ghi UTF-8 qua save dialog và write_file_atomic trong Tauri', async () => {
        window.__TAURI_INTERNALS__ = {};
        vi.mocked(save).mockResolvedValue('C:\\Users\\Test\\logo_vector.svg');
        vi.mocked(invoke).mockResolvedValue(undefined);

        const result = await saveBlob(
            new Blob(['<svg>đỏ</svg>'], { type: 'image/svg+xml;charset=utf-8' }),
            'logo_vector.svg',
            { title: 'Lưu file SVG', filterName: 'SVG', extensions: ['svg'] },
        );

        expect(result).toEqual({ kind: 'saved' });
        expect(save).toHaveBeenCalledWith({
            filters: [{ name: 'SVG', extensions: ['svg'] }],
            defaultPath: 'logo_vector.svg',
            title: 'Lưu file SVG',
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        const [command, payload] = vi.mocked(invoke).mock.calls[0];
        expect(command).toBe('write_file_atomic');
        expect(payload).toMatchObject({ path: 'C:\\Users\\Test\\logo_vector.svg' });
        expect(new TextDecoder().decode((payload as { contents: Uint8Array }).contents)).toBe('<svg>đỏ</svg>');
    });

    it('hủy save dialog thì không ghi file', async () => {
        window.__TAURI_INTERNALS__ = {};
        vi.mocked(save).mockResolvedValue(null);

        await expect(saveBlob(
            new Blob(['<svg/>']),
            'logo.svg',
            { title: 'Lưu file SVG', filterName: 'SVG', extensions: ['svg'] },
        )).resolves.toEqual({ kind: 'cancelled' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('gắn anchor vào DOM trong browser fallback rồi thu hồi URL', async () => {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const append = vi.spyOn(document.body, 'appendChild');

        await expect(saveBlob(
            new Blob(['<svg/>']),
            'logo.svg',
            { title: 'Lưu file SVG', filterName: 'SVG', extensions: ['svg'] },
        )).resolves.toEqual({ kind: 'saved' });

        expect(append).toHaveBeenCalled();
        expect(click).toHaveBeenCalledOnce();
        expect(document.querySelector('a[download="logo.svg"]')).toBeNull();
        await new Promise(resolve => window.setTimeout(resolve, 0));
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg-download');
    });
});

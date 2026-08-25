// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const localFileMocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./localFileTransport', () => ({ fetchLocalFileBuffer: localFileMocks.fetch }));

import {
    ArtifactLeaseOwner,
    collectArtifactLeaseTokens,
    copyArtifactLeaseToken,
    readArtifactLeaseToken,
    tagArtifactLeaseToken,
    type ArtifactLeaseAction,
} from './artifactLease';
import { getFileArrayBuffer } from './utils';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

afterEach(() => {
    vi.useRealTimers();
    delete window.__TAURI_INTERNALS__;
});

describe('artifact lease frontend', () => {
    it('giữ token qua Blob → File và dedupe union current/history', () => {
        const blob = tagArtifactLeaseToken(new Blob(['pdf']), TOKEN_A);
        const file = copyArtifactLeaseToken(blob, new File([blob], 'working.pdf'));

        expect(readArtifactLeaseToken(file)).toBe(TOKEN_A);
        expect(collectArtifactLeaseTokens([blob, file, tagArtifactLeaseToken(new Blob(), TOKEN_B)]))
            .toEqual([TOKEN_A, TOKEN_B]);
    });

    it('claim token mới trước release token cũ, heartbeat và release khi dispose', async () => {
        vi.useFakeTimers();
        const calls: Array<{ action: ArtifactLeaseAction; tokens: string[] }> = [];
        const transport = vi.fn(async (action: ArtifactLeaseAction, _tabId: string, tokens: readonly string[]) => {
            calls.push({ action, tokens: [...tokens] });
            return new Set(tokens);
        });
        const owner = new ArtifactLeaseOwner('tab-a', { transport, heartbeatMs: 1_000 });

        await owner.sync([TOKEN_A]);
        await owner.sync([TOKEN_B]);
        expect(calls.slice(0, 3)).toEqual([
            { action: 'claim', tokens: [TOKEN_A] },
            { action: 'claim', tokens: [TOKEN_B] },
            { action: 'release', tokens: [TOKEN_A] },
        ]);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(calls.some(call => call.action === 'renew' && call.tokens[0] === TOKEN_B)).toBe(true);
        await owner.dispose();
        expect(calls.at(-1)).toEqual({ action: 'release', tokens: [TOKEN_B] });
    });

    it('không giữ claim trả muộn sau khi desired đã đổi', async () => {
        let resolveClaim!: (value: ReadonlySet<string>) => void;
        const transport = vi.fn((action: ArtifactLeaseAction, _tabId: string, tokens: readonly string[]) => {
            if (action === 'claim') return new Promise<ReadonlySet<string>>(resolve => { resolveClaim = resolve; });
            return Promise.resolve(new Set(tokens));
        });
        const owner = new ArtifactLeaseOwner('tab-race', { transport });
        const pending = owner.sync([TOKEN_A]);
        await vi.waitFor(() => expect(resolveClaim).toBeTypeOf('function'));
        void owner.sync([]);
        resolveClaim(new Set([TOKEN_A]));
        await pending;
        await owner.dispose();

        expect(transport).toHaveBeenCalledWith('release', 'tab-race', [TOKEN_A]);
    });

    it('tự claim lại sau lỗi kết nối tạm thời mà không cần state React đổi', async () => {
        vi.useFakeTimers();
        let claimAttempts = 0;
        const transport = vi.fn(async (
            action: ArtifactLeaseAction,
            _tabId: string,
            tokens: readonly string[],
        ) => {
            if (action === 'claim' && ++claimAttempts === 1) {
                throw new Error('backend đang khởi động lại');
            }
            return new Set(tokens);
        });
        const owner = new ArtifactLeaseOwner('tab-retry', {
            transport,
            retryMs: 1_000,
        });

        await expect(owner.sync([TOKEN_A])).rejects.toThrow('backend đang khởi động lại');
        await vi.advanceTimersByTimeAsync(1_000);

        expect(transport.mock.calls.filter(call => call[0] === 'claim')).toHaveLength(2);
        await owner.dispose();
    });

    it('renew ngay khi cửa sổ focus lại sau sleep, không chờ nhịp interval', async () => {
        vi.useFakeTimers();
        const transport = vi.fn(async (
            _action: ArtifactLeaseAction,
            _tabId: string,
            tokens: readonly string[],
        ) => new Set(tokens));
        const owner = new ArtifactLeaseOwner('tab-resume', {
            transport,
            heartbeatMs: 60_000,
        });
        await owner.sync([TOKEN_A]);

        window.dispatchEvent(new Event('focus'));
        await vi.waitFor(() => expect(transport).toHaveBeenCalledWith(
            'renew',
            'tab-resume',
            [TOKEN_A],
        ));
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        await owner.dispose();
    });

    it('managed path mất báo lỗi có ngữ cảnh và không fallback bytes', async () => {
        window.__TAURI_INTERNALS__ = {};
        localFileMocks.fetch.mockRejectedValueOnce(new Error('ENOENT'));
        const file = tagArtifactLeaseToken(
            new File([], 'working.pdf', { type: 'application/pdf' }),
            TOKEN_A,
        );
        Object.defineProperty(file, 'path', { value: 'D:/results/nup_deadbeef.pdf' });

        await expect(getFileArrayBuffer(file)).rejects.toThrow('artifact làm việc');
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMockupStore } from './useMockupStore';

describe('useMockupStore blob resource lifecycle', () => {
    const revoke = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        revoke.mockReset();
        vi.stubGlobal('URL', { revokeObjectURL: revoke });
        useMockupStore.getState().resetMockup();
        vi.runOnlyPendingTimers();
        revoke.mockReset();
    });

    afterEach(() => {
        useMockupStore.getState().resetMockup();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('revokes a replaced object URL and removes URL snapshots from undo history', () => {
        const store = useMockupStore.getState();
        store.setOuterArtworkUrl('blob:first');
        useMockupStore.getState().setOuterArtworkTransform({
            ...useMockupStore.getState().artwork.outer.transform,
            offsetXPct: 10,
        });
        expect(useMockupStore.getState().artworkPast.length).toBeGreaterThan(0);

        useMockupStore.getState().setOuterArtworkUrl('blob:second');
        vi.runOnlyPendingTimers();
        expect(revoke).toHaveBeenCalledWith('blob:first');
        expect(useMockupStore.getState().artworkPast).toEqual([]);
        expect(useMockupStore.getState().artworkFuture).toEqual([]);
    });

    it('releases every live object URL on reset without revoking duplicates twice', () => {
        const store = useMockupStore.getState();
        store.setOuterArtworkUrl('blob:outer');
        useMockupStore.getState().setInnerArtworkUrl('blob:inner');
        useMockupStore.getState().setSpotUvMaskUrl('blob:mask');
        revoke.mockReset();

        useMockupStore.getState().resetMockup();
        vi.runOnlyPendingTimers();
        expect(new Set(revoke.mock.calls.map(([url]) => url))).toEqual(
            new Set(['blob:outer', 'blob:inner', 'blob:mask']),
        );
    });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    bindRecoverySourceFingerprint,
    clearAllSnapshots,
    createRecoveryHistoryEntry,
    deleteSnapshot,
    isRecoverySourceCurrent,
    listSnapshots,
    parseRecoverySnapshot,
    writeSnapshot,
} from './recovery';

afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('recovery — môi trường web', () => {
    it('no-op an toàn, không thử ghi file khi không có runtime Tauri', async () => {
        const snapshot = {
            v: 2 as const,
            tabId: 'tab-1',
            title: 'Tài liệu',
            savedAt: new Date(0).toISOString(),
            originalPath: 'D:\\in.pdf',
            originalName: 'in.pdf',
            sourceFingerprint: { size: 128, mtimeMs: 1_000 },
            dirty: true as const,
            pendingObjectEdits: false as const,
            vdpFields: [{ id: 'field-1', name: 'Mã khách' }],
        };

        await expect(writeSnapshot(snapshot)).resolves.toBe(false);
        await expect(listSnapshots()).resolves.toEqual([]);
        await expect(deleteSnapshot(snapshot.tabId)).resolves.toBeUndefined();
        await expect(clearAllSnapshots()).resolves.toBeUndefined();
    });
});

describe('recovery — migration và fingerprint', () => {
    it('migrate v1 nhưng không đoán instance ID theo số trang nguồn bị lặp', () => {
        const migrated = parseRecoverySnapshot({
            v: 1,
            tabId: 'legacy-tab',
            title: 'Tài liệu cũ',
            savedAt: '2026-08-25T10:00:00.000Z',
            originalPath: 'D:\\legacy.pdf',
            originalName: 'legacy.pdf',
            viewerPageOrder: [2, 1, 1],
            viewerPageRotations: { 1: 90, 2: 0 },
        });

        expect(migrated).toMatchObject({
            v: 2,
            migratedFromVersion: 1,
            sourceFingerprint: null,
            viewerPageOrder: [2, 1, 1],
            viewerPageInstanceIds: undefined,
            viewerPageRotations: [0, 90, 90],
        });

        let sequence = 0;
        const file = new File([], 'legacy.pdf', { type: 'application/pdf' });
        const entry = createRecoveryHistoryEntry(
            migrated!,
            file,
            () => `recovered-${++sequence}`,
        );
        expect(entry.file).toBe(file);
        expect(entry.pageRevision?.pageInstanceIds).toEqual([
            'recovered-1',
            'recovered-2',
            'recovered-3',
        ]);
        expect(entry.pageRevision?.pageInstanceIds[1]).not.toBe(entry.pageRevision?.pageInstanceIds[2]);
    });

    it('bỏ snapshot v1 không có thay đổi bền vững để không quảng cáo recover edit RAM', () => {
        expect(parseRecoverySnapshot({
            v: 1,
            tabId: 'edit-only',
            title: 'Edit chưa commit',
            savedAt: '2026-08-25T10:00:00.000Z',
            originalPath: 'D:\\edit.pdf',
            originalName: 'edit.pdf',
            viewerPageOrder: [1, 2],
            viewerPageRotations: [0, 0],
        })).toBeNull();
    });

    it('từ chối snapshot v2 khai báo còn edit-object chưa có journal', () => {
        expect(parseRecoverySnapshot({
            v: 2,
            tabId: 'unsafe-edit',
            title: 'Edit chưa commit',
            savedAt: '2026-08-25T10:00:00.000Z',
            originalPath: 'D:\\edit.pdf',
            originalName: 'edit.pdf',
            sourceFingerprint: { size: 100, mtimeMs: 1_000 },
            dirty: true,
            pendingObjectEdits: true,
        })).toBeNull();
    });

    it('fail-closed khi size hoặc mtime khác fingerprint snapshot', () => {
        const snapshot = parseRecoverySnapshot({
            v: 2,
            tabId: 'fingerprint',
            title: 'Fingerprint',
            savedAt: '2026-08-25T10:00:00.000Z',
            originalPath: 'D:\\source.pdf',
            originalName: 'source.pdf',
            sourceFingerprint: { size: 100, mtimeMs: 1_000 },
            dirty: true,
            pendingObjectEdits: false,
        })!;

        expect(isRecoverySourceCurrent(snapshot, { size: 100, mtimeMs: 1_000 })).toBe(true);
        expect(isRecoverySourceCurrent(snapshot, { size: 101, mtimeMs: 1_000 })).toBe(false);
        expect(isRecoverySourceCurrent(snapshot, { size: 100, mtimeMs: 1_001 })).toBe(false);
        expect(isRecoverySourceCurrent(snapshot, null)).toBe(false);
    });

    it('v1 chỉ migrate khi file không mới hơn thời điểm snapshot rồi bind fingerprint v2', () => {
        const legacy = parseRecoverySnapshot({
            v: 1,
            tabId: 'legacy-safe',
            title: 'Legacy',
            savedAt: '2026-08-25T10:00:00.000Z',
            originalPath: 'D:\\legacy.pdf',
            originalName: 'legacy.pdf',
            viewerPageOrder: [2, 1],
        })!;
        const savedAt = Date.parse(legacy.savedAt);

        expect(isRecoverySourceCurrent(legacy, { size: 50, mtimeMs: savedAt - 1 })).toBe(true);
        expect(isRecoverySourceCurrent(legacy, { size: 50, mtimeMs: savedAt + 1 })).toBe(false);

        const bound = bindRecoverySourceFingerprint(legacy, { size: 50, mtimeMs: savedAt - 1 });
        expect(bound.sourceFingerprint).toEqual({ size: 50, mtimeMs: savedAt - 1 });
        expect(bound.migratedFromVersion).toBeUndefined();
        expect(bound.viewerPageOrder).not.toBe(legacy.viewerPageOrder);
    });
});

describe('recovery — hợp đồng wiring workspace', () => {
    it('không set page state sớm và giữ dirty phục hồi tới Save', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/components/ImpositionTab.tsx'),
            'utf8',
        );
        const recoveryEffectStart = source.indexOf('// VDP không phụ thuộc loader');
        const recoveryEffectEnd = source.indexOf('// Warn before closing', recoveryEffectStart);
        const recoveryEffect = source.slice(recoveryEffectStart, recoveryEffectEnd);

        expect(recoveryEffect).not.toContain('setViewerPageOrder(');
        expect(recoveryEffect).not.toContain('setViewerPageInstanceIds(');
        expect(recoveryEffect).not.toContain('setViewerPageRotations(');
        expect(source).toContain('createRecoveryHistoryEntry(initialRecovery, openedFile)');
        expect(source).toContain('pendingHistoryEntry={pendingHistoryEntry}');
        expect(source).toContain('if (isRestoredDocumentDirty(file, restoredHistoryDirtyFile)) return true');
        expect(source).toContain('if (isSaved && restoredHistoryDirtyFile) setRestoredHistoryDirtyFile(null)');
    });

    it('xóa snapshot khi edit-object còn trong RAM và snapshot v2 mang đủ revision', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/components/ImpositionTab.tsx'),
            'utf8',
        );
        const autosaveStart = source.indexOf('// ── AUTOSAVE / CRASH RECOVERY');
        const autosaveEnd = source.indexOf('// VDP không phụ thuộc loader', autosaveStart);
        const autosave = source.slice(autosaveStart, autosaveEnd);

        expect(autosave).toContain('|| editSessionDirty');
        expect(autosave.indexOf('void deleteSnapshot(tabId)')).toBeLessThan(
            autosave.indexOf('await writeSnapshot'),
        );
        expect(autosave).toContain('pendingObjectEdits: false');
        expect(autosave).toContain('viewerPageInstanceIds: viewerPageInstanceIds || undefined');
        expect(autosave).toContain('sourceFingerprint');
    });
});

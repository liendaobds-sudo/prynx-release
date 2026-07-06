// @vitest-environment jsdom
/**
 * Unit tests cho `stripBytesIfOnDisk` (audit RAM 2026-07-06, mục #2).
 *
 * Hành vi cốt lõi cho stack undo (history / objectEdit):
 * - File CÓ .path trên Tauri → trả File RỖNG bytes (0 byte) chỉ mang tên+path
 *   → render/đọc lại qua path, KHÔNG giữ bytes PDF trong RAM.
 * - File KHÔNG path (web / blob) → GIỮ NGUYÊN file (fallback bytes) → hành vi cũ.
 * - Không ở môi trường Tauri → GIỮ NGUYÊN (fallback).
 * - null → trả null (call-site undo/redo truyền st.file: File | null).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { stripBytesIfOnDisk } from './utils';

function fileWithPath(bytes: Uint8Array, name: string, path: string, flags?: { editCommit?: boolean }): File {
    const f = new File([bytes as any], name, { type: 'application/pdf' });
    Object.defineProperty(f, 'path', { value: path });
    if (flags?.editCommit) Object.defineProperty(f, '__editCommit', { value: true, configurable: true });
    return f;
}

function setTauri(on: boolean) {
    if (on) (window as any).__TAURI_INTERNALS__ = {};
    else delete (window as any).__TAURI_INTERNALS__;
}

afterEach(() => setTauri(false));

describe('stripBytesIfOnDisk', () => {
    it('Tauri + có path → File rỗng bytes, giữ tên + path', () => {
        setTauri(true);
        const orig = fileWithPath(new Uint8Array(5000), 'doc.pdf', 'C:/tmp/doc.pdf');
        const light = stripBytesIfOnDisk(orig);
        expect(light).not.toBe(orig);
        expect(light.size).toBe(0);              // bytes đã strip
        expect(light.name).toBe('doc.pdf');
        expect((light as any).path).toBe('C:/tmp/doc.pdf');
    });

    it('giữ cờ __editCommit khi có', () => {
        setTauri(true);
        const orig = fileWithPath(new Uint8Array(100), 'e.pdf', 'C:/tmp/e.pdf', { editCommit: true });
        const light = stripBytesIfOnDisk(orig);
        expect((light as any).__editCommit).toBe(true);
    });

    it('không set __editCommit nếu file gốc không có', () => {
        setTauri(true);
        const orig = fileWithPath(new Uint8Array(100), 'e.pdf', 'C:/tmp/e.pdf');
        const light = stripBytesIfOnDisk(orig);
        expect((light as any).__editCommit).toBeUndefined();
    });

    it('Tauri nhưng KHÔNG path → giữ nguyên file (fallback bytes)', () => {
        setTauri(true);
        const orig = new File([new Uint8Array(3000) as any], 'blob.pdf', { type: 'application/pdf' });
        const out = stripBytesIfOnDisk(orig);
        expect(out).toBe(orig);                  // cùng object
        expect(out.size).toBe(3000);
    });

    it('KHÔNG Tauri (web) → giữ nguyên dù có path', () => {
        setTauri(false);
        const orig = fileWithPath(new Uint8Array(3000), 'doc.pdf', 'C:/tmp/doc.pdf');
        const out = stripBytesIfOnDisk(orig);
        expect(out).toBe(orig);
        expect(out.size).toBe(3000);
    });

    it('null → null (call-site undo/redo truyền File | null)', () => {
        setTauri(true);
        expect(stripBytesIfOnDisk(null)).toBeNull();
    });
});

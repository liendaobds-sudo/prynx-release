import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  statNativeSystemFile,
  statNativeSystemFiles,
  createPathBackedFiles,
  createPathBackedFile,
  SYSTEM_FILE_STAT_DEADLINE_MS,
} from './nativeFileAccess';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

describe('nativeFileAccess', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it('statNativeSystemFiles gọi đúng batch command stat_system_files', async () => {
    mocks.invoke.mockImplementation(async (command: string, payload?: { paths?: string[] }) => {
      if (command === 'stat_system_files') {
        return (payload?.paths ?? []).map((_, idx) => ({
          status: 'available',
          size: (idx + 1) * 1024,
        }));
      }
      return null;
    });

    const paths = ['C:\\in\\f1.png', 'C:\\in\\f2.png', 'C:\\in\\f3.png'];
    const results = await statNativeSystemFiles(paths);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('stat_system_files', { paths });
    expect(results).toEqual([
      { status: 'available', size: 1024 },
      { status: 'available', size: 2048 },
      { status: 'available', size: 3072 },
    ]);
  });

  it('statNativeSystemFiles fallback sang stat_system_file khi lệnh batch trả null hoặc throw', async () => {
    mocks.invoke.mockImplementation(async (command: string, payload?: { path?: string }) => {
      if (command === 'stat_system_files') {
        throw new Error('Command stat_system_files not found');
      }
      if (command === 'stat_system_file') {
        return {
          status: 'available',
          size: payload?.path?.endsWith('1.png') ? 500 : 800,
        };
      }
      return null;
    });

    const paths = ['C:\\in\\1.png', 'C:\\in\\2.png'];
    const results = await statNativeSystemFiles(paths);

    expect(results).toEqual([
      { status: 'available', size: 500 },
      { status: 'available', size: 800 },
    ]);
  });

  it('createPathBackedFiles tạo đủ File objects với path và size thật', async () => {
    mocks.invoke.mockImplementation(async (command: string, payload?: { paths?: string[] }) => {
      if (command === 'stat_system_files') {
        return [
          { status: 'available', size: 456789 },
          { status: 'available', size: 123456 },
        ];
      }
      return null;
    });

    const paths = ['C:\\Users\\Khanh Pham\\Desktop\\FBA\\A.png', 'C:\\Users\\Khanh Pham\\Desktop\\FBA\\B.png'];
    const created = await createPathBackedFiles(paths);

    expect(created).toHaveLength(2);
    expect(created[0].file.name).toBe('A.png');
    expect(created[0].file.size).toBe(456789);
    expect((created[0].file as File & { path?: string }).path).toBe(paths[0]);
    expect(created[0].stat.status).toBe('available');

    expect(created[1].file.name).toBe('B.png');
    expect(created[1].file.size).toBe(123456);
    expect((created[1].file as File & { path?: string }).path).toBe(paths[1]);
  });

  it('statNativeSystemFiles trả về timeout khi native probe vượt deadline', async () => {
    mocks.invoke.mockImplementation(() => new Promise(() => undefined)); // treo

    const results = await statNativeSystemFiles(['C:\\in\\hang-doi-nghen.pdf'], 50);

    expect(results).toEqual([{ status: 'timeout', size: 0 }]);
  });

  it('persistTempNativePdfFile trả về file PDF hợp lệ', async () => {
    const { persistTempNativePdfFile } = await import('./nativeFileAccess');
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const file = await persistTempNativePdfFile(bytes, 'test.pdf');
    expect(file.name).toBe('test.pdf');
    expect(file.type).toBe('application/pdf');
    expect(file.size).toBe(4);
  });
});

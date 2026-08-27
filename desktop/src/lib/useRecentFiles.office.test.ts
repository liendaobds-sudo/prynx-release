// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { markGeneratedWorkspaceFile } from './nativeFileAccess';
import { addOpenPayloadToRecent, useRecentFiles } from './useRecentFiles';

function nativeFile(name: string, path: string, size: number): File {
  const file = new File([], name);
  Object.defineProperty(file, 'path', { value: path });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('Recent cho nguồn Office', () => {
  beforeEach(() => {
    localStorage.clear();
    useRecentFiles.setState({ files: [], missingPaths: [] });
  });

  it('ghi đủ batch Office và loại đường dẫn trùng', () => {
    const docx = nativeFile('Báo giá.docx', 'D:/Đơn hàng/Báo giá.docx', 120);
    const xlsx = nativeFile('Chi phí.xlsx', '\\\\may-in\\du-lieu\\Chi phí.xlsx', 240);
    const output = markGeneratedWorkspaceFile(
      nativeFile('Imposed_result.pdf', 'D:/temp/Imposed_result.pdf', 360),
    );

    const added = addOpenPayloadToRecent({
      file: output,
      officeSourceFile: docx,
      officeSourceFiles: [docx, xlsx],
    });

    expect(added).toBe(2);
    expect(useRecentFiles.getState().files.map((file) => file.name)).toEqual([
      'Chi phí.xlsx',
      'Báo giá.docx',
    ]);
  });

  it('không ghi file không có path hoặc file generated', () => {
    const memoryOnly = new File([], 'memory.docx');
    const generated = markGeneratedWorkspaceFile(
      nativeFile('converted.docx', 'D:/temp/converted.docx', 10),
    );

    expect(addOpenPayloadToRecent({
      officeSourceFile: memoryOnly,
      officeSourceFiles: [memoryOnly, generated],
    })).toBe(0);
    expect(useRecentFiles.getState().files).toEqual([]);
  });

  it('vẫn ghi file khách có tên trùng token output cũ', () => {
    const converted = nativeFile(
      'Hop_dong_converted_2026.pdf',
      'D:/Khach/Hop_dong_converted_2026.pdf',
      101,
    );
    const edited = nativeFile(
      'Khach_Edited_final.pdf',
      'D:/Khach/Khach_Edited_final.pdf',
      102,
    );
    const part = nativeFile(
      'part_bao-gia.pdf',
      'D:/Khach/part_bao-gia.pdf',
      103,
    );

    expect(addOpenPayloadToRecent({
      file: converted,
      officeSourceFiles: [edited, part],
    })).toBe(3);
    expect(useRecentFiles.getState().files.map(file => file.name)).toEqual([
      'part_bao-gia.pdf',
      'Khach_Edited_final.pdf',
      'Hop_dong_converted_2026.pdf',
    ]);
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

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
    const output = nativeFile('Imposed_result.pdf', 'D:/temp/Imposed_result.pdf', 360);

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
    const generated = nativeFile('converted.docx', 'D:/temp/converted.docx', 10);
    Object.defineProperty(generated, 'isGenerated', { value: true });

    expect(addOpenPayloadToRecent({
      officeSourceFile: memoryOnly,
      officeSourceFiles: [memoryOnly, generated],
    })).toBe(0);
    expect(useRecentFiles.getState().files).toEqual([]);
  });
});

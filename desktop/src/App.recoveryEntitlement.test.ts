import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chính sách khôi phục sau entitlement', () => {
  it('không xóa snapshot bị chặn và chỉ thay snapshot sau ghi atomic thành công', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const start = source.indexOf('const restoreSnapshots = useCallback');
    const end = source.indexOf('const dismissRecovery = useCallback', start);
    const restore = source.slice(start, end);

    expect(restore).not.toContain('clearAllSnapshots');
    const openAt = restore.indexOf("handleOpenApp('imposition'");
    const createdGuardAt = restore.indexOf('if (!opened?.created) continue');
    const durableWriteAt = restore.indexOf('await writeSnapshot');
    const deleteOldAt = restore.indexOf('await deleteSnapshot(snap.tabId)');
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeLessThan(createdGuardAt);
    expect(createdGuardAt).toBeLessThan(durableWriteAt);
    expect(durableWriteAt).toBeLessThan(deleteOldAt);
    expect(restore).toContain('if (replacementWritten)');
  });
});

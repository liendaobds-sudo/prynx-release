import { describe, expect, it } from 'vitest';

import { isEphemeralBackendPath } from './impositionPathPolicy';

describe('isEphemeralBackendPath', () => {
    it('nhận diện thư mục artifact backend trên cả path Windows và POSIX', () => {
        expect(isEphemeralBackendPath('C:\\PrynX\\uploads\\abc.pdf')).toBe(true);
        expect(isEphemeralBackendPath('/var/prynx/results/abc.pdf')).toBe(true);
        expect(isEphemeralBackendPath('/var/prynx/temp/abc.bin')).toBe(true);
    });

    it('nhận diện tên artifact UUID.pdf do VDP upload sinh', () => {
        expect(isEphemeralBackendPath('/var/prynx/0123456789abcdef0123456789abcdef.pdf')).toBe(true);
    });

    it('không chặn path lưu thật hoặc giá trị rỗng', () => {
        expect(isEphemeralBackendPath('C:\\Jobs\\order-123.pdf')).toBe(false);
        expect(isEphemeralBackendPath('/var/prynx/uploads-final/abc.pdf')).toBe(false);
        expect(isEphemeralBackendPath(null)).toBe(false);
        expect(isEphemeralBackendPath('')).toBe(false);
    });
});

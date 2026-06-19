import { describe, it, expect } from 'vitest';
import { jobMismatch, DEFAULT_SHARED_JOB } from '@/stores/useNumberingJobStore';

describe('jobMismatch (PA1 sync)', () => {
    it('rỗng khi hai job khớp hoàn toàn', () => {
        expect(jobMismatch({ ...DEFAULT_SHARED_JOB }, { ...DEFAULT_SHARED_JOB })).toEqual([]);
    });

    it('phát hiện đúng field lệch', () => {
        const local = { ...DEFAULT_SHARED_JOB, endNum: 999, sortMethod: 'snake' as const };
        const diff = jobMismatch(local, { ...DEFAULT_SHARED_JOB });
        expect(diff.sort()).toEqual(['endNum', 'sortMethod']);
    });

    it('phát hiện lệch ở mọi tham số dải', () => {
        const local = {
            startNum: 5, endNum: 5, padding: 0, bookletCount: 1, bookletOffset: 0,
            innerMode: 'reset' as const, distribution: 'sequential' as const, sortMethod: 'cols' as const,
        };
        expect(jobMismatch(local, { ...DEFAULT_SHARED_JOB }).length).toBe(8);
    });
});

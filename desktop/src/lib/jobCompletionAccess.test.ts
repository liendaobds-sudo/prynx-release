import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJobCompletionAccess, jobCompletionHeader, rememberJobCompletionAccess } from './jobCompletionAccess';

const origin = 'http://localhost:8321';
const key = 'KEY-TEST';
const token = 'a'.repeat(64);
const receipt = () => ({ job_id: 'job-test', job_access_token: token,
  job_access_expires_at: Math.floor(Date.now() / 1000) + 3600,
  job_access_paths: ['GET /api/jobs/job-test', 'GET /api/jobs/job-test/results', 'POST /api/jobs/job-test/cancel'] });

describe('receipt chỉ dành cho tác vụ đã cấp phép', () => {
  beforeEach(() => clearJobCompletionAccess());
  it('đúng job/origin/method mới gửi receipt', () => {
    rememberJobCompletionAccess(`${origin}/api/jobs/compare`, receipt(), key);
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test/results`, 'GET', key)).toBe(token);
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test/results`, 'get', key)).toBe(token);
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test/page/2`, 'GET', key)).toBe(token);
    for (const [url, method] of [
      [`${origin}/api/jobs/other/results`, 'GET'], [`${origin}/api/jobs/job-test`, 'DELETE'],
      ['https://external.example/api/jobs/job-test', 'GET'], [`${origin}/api/jobs/job-test?other=1`, 'GET'],
      [`${origin}/api/jobs/compare`, 'POST'], [`${origin}/api/jobs/job-test/page/0`, 'GET'],
    ]) expect(jobCompletionHeader(url, method, key)).toBeNull();
  });
  it('đổi key/xóa phiên loại quyền còn lưu trong RAM', () => {
    rememberJobCompletionAccess(origin, receipt(), key);
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test`, 'GET', 'OTHER')).toBeNull();
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test`, 'GET', key)).toBeNull();
    rememberJobCompletionAccess(origin, receipt(), key);
    clearJobCompletionAccess();
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test`, 'GET', key)).toBeNull();
  });
  it('response không thể cấp đường tạo job hoặc job khác cho receipt này', () => {
    for (const path of ['POST /api/jobs/compare', 'GET /api/jobs/other', 'GET /api/system/info']) {
      rememberJobCompletionAccess(origin, { ...receipt(), job_access_paths: [path] }, key);
      expect(jobCompletionHeader(origin + path.split(' ')[1], path.split(' ')[0], key)).toBeNull();
    }
  });
  it('deadline không được kéo dài vô hạn và hết hạn thì xóa', () => {
    const sample = receipt();
    rememberJobCompletionAccess(origin, { ...sample, job_access_expires_at: sample.job_access_expires_at + 86400 }, key);
    expect(jobCompletionHeader(`${origin}/api/jobs/job-test`, 'GET', key)).toBeNull();
    rememberJobCompletionAccess(origin, sample, key);
    const now = vi.spyOn(Date, 'now').mockReturnValue((sample.job_access_expires_at + 1) * 1000);
    try { expect(jobCompletionHeader(`${origin}/api/jobs/job-test`, 'GET', key)).toBeNull(); }
    finally { now.mockRestore(); }
  });
});

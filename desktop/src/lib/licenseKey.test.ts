// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { normalizeLicenseKey, maskLicenseKey } from './licenseKey';

describe('licenseKey helpers', () => {
    it('normalize: trim + upper', () => {
        expect(normalizeLicenseKey('  ab-cd-12  ')).toBe('AB-CD-12');
        expect(normalizeLicenseKey('')).toBe('');
    });

    it('mask: 4 ký tự cuối', () => {
        expect(maskLicenseKey('PRYNX-ABC-1234')).toBe('••••1234');
        expect(maskLicenseKey('AB')).toBe('••••');
        expect(maskLicenseKey(null)).toBe('—');
        expect(maskLicenseKey('')).toBe('—');
    });
});

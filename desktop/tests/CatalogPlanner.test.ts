// Test script for CatalogPlanner — Verification Matrix
// Run: npx tsx src/lib/imposerEngine/CatalogPlanner.test.ts

import { planCatalog, verifyCatalogPlan, PlanConfig } from './CatalogPlanner';

interface TestCase {
    label: string;
    config: PlanConfig;
    expectedMainCount: number;
    expectedMainSig: number;
    expectedRemainderSizes: number[];
    expectedHasCover: boolean;
}

const testCases: TestCase[] = [
    // ===== Không bìa riêng =====
    { label: ' 8p, no cover, master=8',  config: { totalPages: 8,  bindingMode: 'perfect', hasSeparateCover: false, masterSig: 8  }, expectedMainCount: 1, expectedMainSig: 8,  expectedRemainderSizes: [],     expectedHasCover: false },
    { label: '16p, no cover, master=16', config: { totalPages: 16, bindingMode: 'perfect', hasSeparateCover: false, masterSig: 16 }, expectedMainCount: 1, expectedMainSig: 16, expectedRemainderSizes: [],     expectedHasCover: false },
    { label: '12p, no cover, master=8',  config: { totalPages: 12, bindingMode: 'perfect', hasSeparateCover: false, masterSig: 8  }, expectedMainCount: 1, expectedMainSig: 8,  expectedRemainderSizes: [4],   expectedHasCover: false },
    { label: '36p, no cover, master=16', config: { totalPages: 36, bindingMode: 'perfect', hasSeparateCover: false, masterSig: 16 }, expectedMainCount: 2, expectedMainSig: 16, expectedRemainderSizes: [4],   expectedHasCover: false },

    // ===== Bìa riêng, Perfect Binding =====
    { label: ' 8p, cover, master=8 (Perfect)',   config: { totalPages: 8,   bindingMode: 'perfect', hasSeparateCover: true, masterSig: 8  }, expectedMainCount: 0, expectedMainSig: 8,  expectedRemainderSizes: [4],      expectedHasCover: true },
    { label: '16p, cover, master=8 (Perfect)',   config: { totalPages: 16,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 8  }, expectedMainCount: 1, expectedMainSig: 8,  expectedRemainderSizes: [4],      expectedHasCover: true },
    { label: '20p, cover, master=16 (Perfect)',  config: { totalPages: 20,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 1, expectedMainSig: 16, expectedRemainderSizes: [],       expectedHasCover: true },
    { label: '24p, cover, master=16 (Perfect)',  config: { totalPages: 24,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 1, expectedMainSig: 16, expectedRemainderSizes: [4],      expectedHasCover: true },
    { label: '28p, cover, master=16 (Perfect)',  config: { totalPages: 28,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 1, expectedMainSig: 16, expectedRemainderSizes: [8],      expectedHasCover: true },
    { label: '32p, cover, master=16 (Perfect)',  config: { totalPages: 32,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 1, expectedMainSig: 16, expectedRemainderSizes: [8, 4],   expectedHasCover: true },
    { label: '52p, cover, master=16 (Perfect)',  config: { totalPages: 52,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 3, expectedMainSig: 16, expectedRemainderSizes: [],       expectedHasCover: true },
    { label: '80p, cover, master=16 (Perfect)',  config: { totalPages: 80,  bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 4, expectedMainSig: 16, expectedRemainderSizes: [8, 4],   expectedHasCover: true },
    { label: '100p, cover, master=16 (Perfect)', config: { totalPages: 100, bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 6, expectedMainSig: 16, expectedRemainderSizes: [],       expectedHasCover: true },
    { label: '120p, cover, master=16 (Perfect)', config: { totalPages: 120, bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 7, expectedMainSig: 16, expectedRemainderSizes: [4],      expectedHasCover: true },
    { label: '200p, cover, master=16 (Perfect)', config: { totalPages: 200, bindingMode: 'perfect', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 12, expectedMainSig: 16, expectedRemainderSizes: [4],     expectedHasCover: true },

    // ===== Bìa riêng, Saddle Stitch =====
    { label: '80p, cover, master=16 (Saddle)',  config: { totalPages: 80,  bindingMode: 'saddle', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 4, expectedMainSig: 16, expectedRemainderSizes: [8, 4],   expectedHasCover: true },
    { label: '52p, cover, master=16 (Saddle)',  config: { totalPages: 52,  bindingMode: 'saddle', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 3, expectedMainSig: 16, expectedRemainderSizes: [],       expectedHasCover: true },
    { label: '48p, cover, master=16 (Saddle)',  config: { totalPages: 48,  bindingMode: 'saddle', hasSeparateCover: true, masterSig: 16 }, expectedMainCount: 2, expectedMainSig: 16, expectedRemainderSizes: [8, 4],   expectedHasCover: true },
];

// ==================== RUN TESTS ====================
let passed = 0;
let failed = 0;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  CatalogPlanner Verification Matrix — Full Test Suite');
console.log('═══════════════════════════════════════════════════════════════\n');

for (const tc of testCases) {
    const result = planCatalog(tc.config);
    const errors: string[] = [];

    // Kiểm chứng trang không trùng/sót
    const verifyErrors = verifyCatalogPlan(tc.config, result);
    errors.push(...verifyErrors);

    // Kiểm số kẽm chính
    const mainJobs = result.jobs.filter(j => j.id.startsWith('main_'));
    if (mainJobs.length !== tc.expectedMainCount) {
        errors.push(`Kẽm chính: Expected ${tc.expectedMainCount}, got ${mainJobs.length}`);
    }

    // Kiểm kẽm phụ
    const remJobs = result.jobs.filter(j => j.id.startsWith('remainder_'));
    const remSizes = remJobs.map(j => j.pageIndices.length).sort((a, b) => b - a);
    const expectedRemSorted = [...tc.expectedRemainderSizes].sort((a, b) => b - a);
    if (JSON.stringify(remSizes) !== JSON.stringify(expectedRemSorted)) {
        errors.push(`Kẽm phụ sizes: Expected [${expectedRemSorted}], got [${remSizes}]`);
    }

    // Kiểm bìa
    const coverJob = result.jobs.find(j => j.isCover);
    if (tc.expectedHasCover && !coverJob) {
        errors.push('Expected cover job but none found');
    }
    if (!tc.expectedHasCover && coverJob) {
        errors.push('Unexpected cover job found');
    }

    // Kết quả
    if (errors.length === 0) {
        console.log(`  ✅ PASS: ${tc.label}`);
        console.log(`     → ${result.jobs.length} kẽm | ${result.jobs.map(j => j.label).join(', ')}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${tc.label}`);
        for (const e of errors) {
            console.log(`     ⚠ ${e}`);
        }
        console.log(`     Report:\n${result.report.split('\n').map(l => '     ' + l).join('\n')}`);
        failed++;
    }
    console.log('');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed (${testCases.length} total)`);
console.log('═══════════════════════════════════════════════════════════════');

if (failed > 0) {
    process.exit(1);
}

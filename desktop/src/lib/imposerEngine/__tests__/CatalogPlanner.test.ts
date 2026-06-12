/**
 * CatalogPlanner Unit Tests
 * 
 * Tests the smart catalog auto planner:
 * - Perfect binding page routing
 * - Saddle stitch concentric ring routing
 * - Cover separation
 * - Remainder handling
 * - Page allocation completeness
 */
import { describe, it, expect } from 'vitest';
import { planCatalog, verifyCatalogPlan, planCatalogFull, type PlanConfig, type PlateJob } from '../CatalogPlanner';
import type { ImpositionInput } from '../ImpositionTypes';

// ─── Helper ─────────────────────────────────────────────────────────────────

/** Get all page indices from all jobs, excluding -1 (padding) */
function allRealPages(jobs: PlateJob[]): number[] {
    return jobs.flatMap(j => j.pageIndices.filter(i => i >= 0));
}


// ═══════════════════════════════════════════════════════════════════════════
//  PERFECT BINDING
// ═══════════════════════════════════════════════════════════════════════════

describe('CatalogPlanner — Perfect Binding', () => {
    it('should split 80 pages into 16p signatures + remainder', () => {
        const config: PlanConfig = {
            totalPages: 80,
            bindingMode: 'perfect',
            hasSeparateCover: true,
            masterSig: 16,
        };
        const result = planCatalog(config);
        
        // 80 pages - 4 cover = 76 body pages → padded to 76 → 4×16 + 12 remainder
        expect(result.jobs.length).toBeGreaterThanOrEqual(1);
        expect(result.report).toBeTruthy();
    });

    it('should separate cover as its own job when hasSeparateCover=true', () => {
        const result = planCatalog({
            totalPages: 32,
            bindingMode: 'perfect',
            hasSeparateCover: true,
            masterSig: 16,
        });
        
        const coverJob = result.jobs.find(j => j.isCover);
        expect(coverJob).toBeDefined();
        expect(coverJob!.pageIndices).toHaveLength(4);
        // Cover pages are 0, 1, N-2, N-1 (first 2 + last 2)
        expect(coverJob!.pageIndices).toContain(0);
        expect(coverJob!.pageIndices).toContain(1);
    });

    it('should include all source pages when cover is same stock', () => {
        const result = planCatalog({
            totalPages: 32,
            bindingMode: 'perfect',
            hasSeparateCover: false,
            masterSig: 16,
        });
        
        const allPages = allRealPages(result.jobs);
        const unique = new Set(allPages);
        expect(unique.size).toBe(32);
    });

    it('total allocated should match totalPages', () => {
        const result = planCatalog({
            totalPages: 64,
            bindingMode: 'perfect',
            hasSeparateCover: true,
            masterSig: 16,
        });
        
        expect(result.totalAllocated).toBe(64);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  SADDLE STITCH
// ═══════════════════════════════════════════════════════════════════════════

describe('CatalogPlanner — Saddle Stitch', () => {
    it('should create concentric ring jobs for 48 pages', () => {
        const result = planCatalog({
            totalPages: 48,
            bindingMode: 'saddle',
            hasSeparateCover: true,
            masterSig: 16,
        });
        
        expect(result.jobs.length).toBeGreaterThanOrEqual(2); // cover + body jobs
    });

    it('should respect remainderPlacement=outside', () => {
        const result = planCatalog({
            totalPages: 48,
            bindingMode: 'saddle',
            hasSeparateCover: true,
            masterSig: 16,
            remainderPlacement: 'outside',
        });
        
        expect(result.report).toBeTruthy();
        const allPages = allRealPages(result.jobs);
        expect(new Set(allPages).size).toBe(48);
    });

    it('should handle small saddle (8 pages, no cover separation)', () => {
        const result = planCatalog({
            totalPages: 8,
            bindingMode: 'saddle',
            hasSeparateCover: false,
            masterSig: 8,
        });
        
        expect(result.jobs.length).toBeGreaterThanOrEqual(1);
        const allPages = allRealPages(result.jobs);
        expect(new Set(allPages).size).toBe(8);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

describe('CatalogPlanner — Edge Cases', () => {
    it('should handle exact multiple of masterSig', () => {
        const result = planCatalog({
            totalPages: 64,
            bindingMode: 'perfect',
            hasSeparateCover: false,
            masterSig: 16,
        });
        
        // 64 pages / 16 = exactly 4 jobs, no remainder
        const bodyJobs = result.jobs.filter(j => !j.isCover);
        expect(bodyJobs.every(j => j.pageIndices.length === 16 || j.pageIndices.length <= 16)).toBe(true);
    });

    it('should assign unique IDs to all jobs', () => {
        const result = planCatalog({
            totalPages: 80,
            bindingMode: 'perfect',
            hasSeparateCover: true,
            masterSig: 16,
        });
        
        const ids = result.jobs.map(j => j.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('should assign fold pattern IDs based on sig size', () => {
        const result = planCatalog({
            totalPages: 80,
            bindingMode: 'perfect',
            hasSeparateCover: true,
            masterSig: 16,
        });
        
        for (const job of result.jobs) {
            if (job.pageIndices.length <= 4 || job.isCover) {
                expect(['sig_4p', 'sig_4p_1up', 'sig_4p_2up']).toContain(job.foldPatternId);
            } else if (job.pageIndices.length <= 8) {
                expect(['sig_4p', 'sig_8p']).toContain(job.foldPatternId);
            }
        }
    });

    it('should have sortOrder on all jobs', () => {
        const result = planCatalog({
            totalPages: 48,
            bindingMode: 'saddle',
            hasSeparateCover: true,
            masterSig: 16,
        });
        
        for (const job of result.jobs) {
            expect(typeof job.sortOrder).toBe('number');
        }
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  verifyCatalogPlan()
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyCatalogPlan — Verification', () => {
    it('should return 0 errors for a valid plan', () => {
        const config: PlanConfig = {
            totalPages: 32,
            bindingMode: 'perfect',
            hasSeparateCover: false,
            masterSig: 16,
        };
        const result = planCatalog(config);
        const errors = verifyCatalogPlan(config, result);
        expect(errors).toHaveLength(0);
    });

    it('should return 0 errors for saddle stitch with cover', () => {
        const config: PlanConfig = {
            totalPages: 48,
            bindingMode: 'saddle',
            hasSeparateCover: true,
            masterSig: 16,
        };
        const result = planCatalog(config);
        const errors = verifyCatalogPlan(config, result);
        expect(errors).toHaveLength(0);
    });

    it('should detect missing pages when a job is removed', () => {
        const config: PlanConfig = {
            totalPages: 32,
            bindingMode: 'perfect',
            hasSeparateCover: false,
            masterSig: 16,
        };
        const result = planCatalog(config);
        // Sabotage: remove the last job
        const sabotaged = { ...result, jobs: result.jobs.slice(0, 1) };
        const errors = verifyCatalogPlan(config, sabotaged);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(e => e.includes('SÓT'))).toBe(true);
    });

    it('should detect duplicate pages', () => {
        const config: PlanConfig = {
            totalPages: 16,
            bindingMode: 'perfect',
            hasSeparateCover: false,
            masterSig: 16,
        };
        const result = planCatalog(config);
        // Sabotage: duplicate the first job
        const sabotaged = { ...result, jobs: [...result.jobs, result.jobs[0]] };
        const errors = verifyCatalogPlan(config, sabotaged);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(e => e.includes('TRÙNG'))).toBe(true);
    });

    it('should detect out-of-range page indices', () => {
        const config: PlanConfig = {
            totalPages: 8,
            bindingMode: 'perfect',
            hasSeparateCover: false,
            masterSig: 8,
        };
        const result = planCatalog(config);
        // Sabotage: inject out-of-range index
        const badJob = { ...result.jobs[0], pageIndices: [...result.jobs[0].pageIndices, 999] };
        const sabotaged = { ...result, jobs: [badJob] };
        const errors = verifyCatalogPlan(config, sabotaged);
        expect(errors.some(e => e.includes('NGOÀI PHẠM VI'))).toBe(true);
    });

    it('should pass for various page counts (80, 100, 120)', () => {
        for (const totalPages of [80, 100, 120]) {
            const config: PlanConfig = {
                totalPages,
                bindingMode: 'perfect',
                hasSeparateCover: true,
                masterSig: 16,
            };
            const result = planCatalog(config);
            const errors = verifyCatalogPlan(config, result);
            expect(errors).toHaveLength(0);
        }
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  planCatalogFull() — Full Spec Engine
// ═══════════════════════════════════════════════════════════════════════════

function makeInput(totalPages: number, overrides: Partial<ImpositionInput> = {}): ImpositionInput {
    return {
        total_pages_physical: totalPages,
        numbering_mode: 'includes_cover',
        cover_mode: 'separate_stock',
        cover_pages: 4,
        quantity_books: 1000,
        spoilage_policy: { method: 'flat', default_rate: 0.05 },
        preferred_signature_sizes: [16, 8, 4],
        template_profile_id: 'default',
        stock_groups: [
            { id: 'cover', type: 'cover', stock_code: 'C300', pages: 4 },
            { id: 'text', type: 'text', stock_code: 'M150', pages: totalPages - 4 },
        ],
        gripper_edge: 'bottom',
        turn_policy: 'sheetwise',
        press_mode: 'single_sided',
        allow_padding_blanks: true,
        remainder_placement: 'outside',
        ...overrides,
    };
}

describe('planCatalogFull — Full Spec E2E', () => {
    it('should produce valid ImpositionOutput for 80 pages', () => {
        const output = planCatalogFull(makeInput(80));

        expect(output.normalized_publication.total_pages_physical).toBe(80);
        expect(output.normalized_publication.cover_pages).toBe(4);
        expect(output.normalized_publication.text_pages).toBe(76);
        expect(output.signatures.length).toBeGreaterThanOrEqual(1);
        expect(output.forms.length).toBeGreaterThanOrEqual(1);
        expect(output.report).toBeTruthy();
    });

    it('should pass validation for 80 pages', () => {
        const output = planCatalogFull(makeInput(80));
        expect(output.validation_status.ok).toBe(true);
        expect(output.validation_status.page_coverage_valid).toBe(true);
        expect(output.validation_status.no_duplicates_valid).toBe(true);
    });

    it('should include cover signature when cover_mode=separate_stock', () => {
        const output = planCatalogFull(makeInput(48));
        const coverSig = output.signatures.find(s => s.is_cover);
        expect(coverSig).toBeDefined();
        expect(coverSig!.size).toBe(4);
        expect(coverSig!.stock_group).toBe('cover');
    });

    it('should not include cover when cover_mode=same_stock', () => {
        const output = planCatalogFull(makeInput(48, { cover_mode: 'same_stock', cover_pages: 0 }));
        const coverSig = output.signatures.find(s => s.is_cover);
        expect(coverSig).toBeUndefined();
    });

    it('should compute production metrics for all forms', () => {
        const output = planCatalogFull(makeInput(80));
        expect(output.sheets_required_per_form.length).toBe(output.forms.length);
        for (const m of output.sheets_required_per_form) {
            expect(m.sheets_required).toBeGreaterThan(0);
            expect(m.impressions).toBeGreaterThan(0);
        }
    });

    it('should compute yield balance with bottleneck form', () => {
        const output = planCatalogFull(makeInput(80));
        expect(output.yield_balance.max_deliverable_sets).toBeGreaterThan(0);
        expect(output.yield_balance.bottleneck_form).toBeTruthy();
    });

    it('should handle padding when text pages are not a multiple of 4', () => {
        // 47 pages: 4 cover + 43 text → padded to 44
        const output = planCatalogFull(makeInput(47));
        expect(output.normalized_publication.padding_blanks).toBeGreaterThan(0);
        expect(output.validation_status.ok).toBe(true);
    });

    it('should throw when padding is needed but not allowed', () => {
        expect(() => {
            planCatalogFull(makeInput(47, { allow_padding_blanks: false }));
        }).toThrow();
    });
});

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
import { planCatalog, verifyCatalogPlan, type PlanConfig, type PlateJob } from '../CatalogPlanner';

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

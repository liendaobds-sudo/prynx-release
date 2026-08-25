import { describe, it, expect } from 'vitest';
import { createPlaybackPublisher, type PlaybackRevision } from './playbackPublisher';
import { readArtifactLeaseToken, tagArtifactLeaseToken } from '../artifactLease';

function setup() {
    let seq = 0;
    const created: string[] = [];
    const revoked: string[] = [];
    const revisions: PlaybackRevision[] = [];
    const publisher = createPlaybackPublisher({
        createObjectUrl: () => { const u = `blob:${++seq}`; created.push(u); return u; },
        revokeObjectUrl: (u) => { revoked.push(u); },
        localFileUrl: (p) => `localfile://${p}`,
        onRevision: (r) => { revisions.push(r); },
    });
    return { publisher, created, revoked, revisions };
}

const pdf = (n = 1) => new Blob([new Uint8Array([n])], { type: 'application/pdf' });
const LEASE_A = 'a'.repeat(64);
const LEASE_B = 'b'.repeat(64);

describe('playbackPublisher — §PLAY.14 vòng đời blob URL', () => {
    it('chỉ giữ MỘT blob URL trung gian; thu hồi cái trước mỗi bước', () => {
        const { publisher, created, revoked } = setup();
        publisher.publish(pdf(1), 'b1.pdf');
        publisher.publish(pdf(2), 'b2.pdf');
        publisher.publish(pdf(3), 'b3.pdf');
        // 3 URL tạo ra, 2 URL trung gian đầu bị thu hồi, URL cuối còn sống.
        expect(created).toHaveLength(3);
        expect(revoked).toEqual([created[0], created[1]]);
        expect(publisher.currentObjectUrl).toBe(created[2]);
    });

    it('revision path native thu hồi blob URL còn treo và không tạo blob mới', () => {
        const { publisher, created, revoked } = setup();
        publisher.publish(pdf(1), 'b1.pdf');            // blob
        publisher.publish(pdf(2), 'n.pdf', 'D:/out/n.pdf'); // native path
        expect(created).toHaveLength(1);
        expect(revoked).toEqual([created[0]]);
        expect(publisher.currentObjectUrl).toBeNull();
    });

    it('publish gắn path vào File và onRevision nhận đúng url', () => {
        const { publisher, revisions } = setup();
        publisher.publish(pdf(1), 'blob.pdf');
        publisher.publish(pdf(2), 'native.pdf', 'D:/out/native.pdf');
        expect(revisions[0].url).toMatch(/^blob:/);
        expect(revisions[0].path).toBeUndefined();
        expect(revisions[1].url).toBe('localfile://D:/out/native.pdf');
        expect((revisions[1].file as File & { path?: string }).path).toBe('D:/out/native.pdf');
    });

    it('giữ lease token của carrier trên File revision cuối cho cả blob và path native', () => {
        const { publisher, revisions } = setup();
        publisher.publish(tagArtifactLeaseToken(pdf(1), LEASE_A), 'blob.pdf');
        publisher.publish(
            tagArtifactLeaseToken(pdf(2), LEASE_B),
            'native.pdf',
            'D:/out/native.pdf',
        );

        expect(readArtifactLeaseToken(revisions[0].file)).toBe(LEASE_A);
        expect(readArtifactLeaseToken(revisions[1].file)).toBe(LEASE_B);
    });
});

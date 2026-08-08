import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App motion policy', () => {
    it('đánh dấu tab active và pause motion của tab nền/cửa sổ nền', () => {
        const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
        const cssSource = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

        expect(appSource).toContain("import './lib/appVisibility'");
        expect(appSource).toContain("data-prynx-tab-active={tab.id === activeTabId ? 'true' : 'false'}");
        expect(cssSource).toContain('[data-prynx-tab-active="false"] *');
        expect(cssSource).toContain('html.prynx-app-backgrounded *');
        expect(cssSource).toContain('animation-play-state: paused !important');
    });
});

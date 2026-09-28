import path from 'node:path';
import { fileURLToPath } from 'node:url';

const auditDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(auditDir, '../../../desktop');

export default {
    root: desktopDir,
    test: {
        globals: true,
        environment: 'jsdom',
        include: [path.join(auditDir, 'ui_contract_probe.test.tsx').replaceAll('\\', '/')],
        setupFiles: [path.join(desktopDir, 'src/test/setup.ts')],
    },
    resolve: {
        alias: [
            { find: /^vitest$/, replacement: path.join(desktopDir, 'node_modules/vitest/dist/index.js') },
            { find: /^react$/, replacement: path.join(desktopDir, 'node_modules/react/index.js') },
            { find: /^react-pdf$/, replacement: path.join(desktopDir, 'node_modules/react-pdf/dist/esm/index.js') },
            { find: /^@testing-library\/react$/, replacement: path.join(desktopDir, 'node_modules/@testing-library/react/dist/index.js') },
            { find: /^pdf-lib$/, replacement: path.join(desktopDir, 'node_modules/pdf-lib/es/index.js') },
            { find: /^typescript$/, replacement: path.join(desktopDir, 'node_modules/typescript/lib/typescript.js') },
        ],
    },
};

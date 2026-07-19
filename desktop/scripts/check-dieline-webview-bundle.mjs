import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const forbidden = [
    '__prynxGenerateDieline',
    'DielineEngineRequest',
];

async function collectJs(dir) {
    const result = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) result.push(...await collectJs(path));
        else if (entry.name.endsWith('.js')) result.push(path);
    }
    return result;
}

for (const file of await collectJs(dist)) {
    const source = await readFile(file, 'utf8');
    for (const marker of forbidden) {
        if (source.includes(marker)) {
            throw new Error(`Protected dieline engine leaked into WebView bundle: ${marker} in ${file}`);
        }
    }
}

console.log('Dieline WebView bundle check passed: protected engine entry is absent.');

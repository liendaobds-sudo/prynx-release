import fs from 'fs';
import path from 'path';

function walkSync(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            fileList = walkSync(filePath, fileList);
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

const targetDirs = [
    'd:\\pdfcompare\\desktop\\src\\stores',
    'd:\\pdfcompare\\desktop\\src\\components'
];

let files = [];
for (const dir of targetDirs) {
    if (fs.existsSync(dir)) {
        files = walkSync(dir, files);
    }
}

console.log(`Starting Audit... Scanning ${files.length} files.`);

let report = [];

for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');

    // 1. Scan Persist Middlewares for potential data leaks
    const persistMatch = content.match(/persist\([\s\S]*?partialize:\s*\((.*?)\)\s*=>\s*(\{[\s\S]*?\})/);
    if (persistMatch) {
        const partializeBody = persistMatch[2];
        // Check for suspicious fields
        const suspicious = ['dim', 'result', 'page', 'layer', 'object', 'file'];
        for (const s of suspicious) {
            const regex = new RegExp(`[a-zA-Z0-9_]*${s}[a-zA-Z0-9_]*\\s*:`, 'i');
            if (regex.test(partializeBody)) {
                report.push(`[WARN - Persist Leak] File: ${file} | Suspicious property in partialize: matched '${s}'.`);
            }
        }
    }

    // 2. Scan Setters for missing resets
    // Looking for setFile, setFileA, setFileB, setSelectionFileId
    const setterMatches = content.matchAll(/(setFile[a-zA-Z0-9_]*|setSelectionFileId)\s*:\s*\((.*?)\)\s*=>\s*(set\([\s\S]*?\}\s*\))/g);
    for (const match of setterMatches) {
        const setterName = match[1];
        const setterBody = match[3];
        // We know we fixed useWorkspaceStore, but check others
        if (!setterBody.includes('detectedShapeType') && setterBody.includes('set(')) {
             report.push(`[INFO - Setter Checked] File: ${file} | Setter: ${setterName} | Does it clear cache? (Body length: ${setterBody.length})`);
        }
    }

    // 3. Scan useEffect for missing cleanup before API calls
    const effectMatches = content.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[([^\]]*?)\]\)/g);
    for (const match of effectMatches) {
        const body = match[1];
        const deps = match[2];
        if (deps.includes('file') || deps.includes('selectionFileId') || deps.includes('pdfFile')) {
            if (body.includes('fetch(') || body.includes('invoke(')) {
                if (!body.includes('set') && !body.includes('clear')) {
                    report.push(`[WARN - useEffect Race Condition] File: ${file} | Effect depends on file, calls API, but doesn't seem to reset state first.`);
                }
            }
        }
    }
}

if (report.length === 0) {
    console.log("No issues found.");
} else {
    report.forEach(r => console.log(r));
}

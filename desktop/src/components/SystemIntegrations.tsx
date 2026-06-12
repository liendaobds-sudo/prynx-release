import { useEffect } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

export default function SystemIntegrations() {

    const processPaths = async (paths: string[]) => {
        const validPaths = paths.filter(p => {
            if (p.includes('prynx://auth/callback')) {
                window.dispatchEvent(new CustomEvent('auth-url-received', { detail: { url: p } }));
                return false;
            }
            const lower = p.toLowerCase();
            return lower.endsWith('.pdf') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png');
        });

        if (validPaths.length === 0) return;

        const files: File[] = [];
        const { stat } = await import('@tauri-apps/plugin-fs');

        for (const path of validPaths) {
            try {
                const name = path.split('\\').pop() || path.split('/').pop() || 'unknown';
                const lower = name.toLowerCase();
                const type = lower.endsWith('.pdf') ? 'application/pdf' : 
                            lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
                
                const fileStat = await stat(path);
                const fileObj = new File([], name, { type });
                Object.defineProperty(fileObj, 'path', { value: path }); // CRITICAL: Skip HTTP upload polyfill by providing absolute path
                Object.defineProperty(fileObj, 'size', { value: fileStat.size });
                files.push(fileObj);
            } catch (err) {
                console.error("Failed to read system file:", path, err);
                alert("Không thể đọc file: " + path + "\nLỗi: " + err);
            }
        }

        if (files.length > 0) {
            window.dispatchEvent(new CustomEvent('system-files-received', { detail: { files } }));
        }
    };

    useEffect(() => {
        // 1. Process startup args (First Instance)
        invoke<string[]>('get_startup_args')
            .then(args => {
                if (args && args.length > 1) {
                    processPaths(args.slice(1));
                }
            })
            .catch(err => console.error("Failed to get startup args:", err));

        // 2. Poll for subsequent files from Single Instance Plugin
        const intervalId = setInterval(() => {
            invoke<string[]>('get_pending_system_files')
                .then(args => {
                    if (args && args.length > 0) {
                        processPaths(args);
                    }
                })
                .catch(err => {
                    console.error("Failed to poll pending system files:", err);
                });
        }, 1000);

        // 3. Listen to Tauri native drag and drop events
        let isUnmounted = false;
        let unlistenDrop: (() => void) | null = null;

        import('@tauri-apps/api/event').then(({ listen }) => {
            listen<any>('tauri://drag-drop', (event) => {
                let paths: string[] = [];
                if (Array.isArray(event.payload)) paths = event.payload;
                else if (event.payload && Array.isArray(event.payload.paths)) paths = event.payload.paths;
                
                if (paths.length > 0) {
                    processPaths(paths);
                }
            }).then(unlisten => { 
                if (isUnmounted) {
                    unlisten(); // if already unmounted, unlisten immediately
                } else {
                    unlistenDrop = unlisten;
                }
            });
        });

        return () => {
            isUnmounted = true;
            clearInterval(intervalId);
            if (unlistenDrop) unlistenDrop();
        };
    }, []);

    return null;
}

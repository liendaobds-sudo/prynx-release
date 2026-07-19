import { runDielineEngine } from './engine';
import { assertEngineRequest } from './runtimeValidation';

declare global {
    // eslint-disable-next-line no-var
    var __prynxGenerateDieline: ((requestJson: string) => string) | undefined;
}

// The native host exchanges strings so the JS boundary stays small and does
// not depend on a host-specific object conversion layer.
globalThis.__prynxGenerateDieline = (requestJson: string): string => {
    const request: unknown = JSON.parse(requestJson);
    assertEngineRequest(request);
    return JSON.stringify(runDielineEngine(request));
};

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

/** Loads `src/lib/api.ts` with its imports stubbed and a recording fake `fetch`. No real network. */
export const FP = 'f'.repeat(22);

export function apiHarness() {
  const calls: any[] = [], storage: any[] = [], exports: any = {};
  const modules: any = {
    'react-native': { Platform: { OS: 'web' } },
    'expo/fetch': { fetch: async (url: string, init: any) => {
      calls.push({ url, ...init });
      const data = url.endsWith('/api/info') ? { app: 'winglet', server_id: 's', version: '1' }
        : url.endsWith('/api/server-key') ? { fingerprint: FP }
        : url.endsWith('/api/pair') ? { server_id: 's', token: 'fake', device: { id: 'd' }, bot: { name: 'main' } } : {};
      return { ok: true, json: async () => data };
    } },
    './crypto': { newSigningKey: () => ({ secret: 'test-only-secret', public: 'test-public' }), checkServerKey: () => {},
      addressConfirmed: () => true, seal: (_: any, __: any, ___: any, data: any) => JSON.stringify(data), signedHeaders: () => ({}) },
    './storage': { getItem: async () => 'test-only-secret', setItem: async (...args: any[]) => storage.push(args) },
    './verify': { NEEDS_VERIFY: 'needs verify', useVerify: { getState: () => ({ ask: () => {} }) } },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/api.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, require: (n: string) => modules[n], URL, URLSearchParams, AbortController, setTimeout, clearTimeout, FormData, Date, JSON, Error });
  return { api: exports, calls, storage };
}

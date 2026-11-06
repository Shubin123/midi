const HASH = '643adbbb0c77eadb71182f116c9da0860814221a25194dac3ed561589929ef6d';
const LOCAL = new URL('../node_modules/@alexaltea/unicorn-js/dist/unicorn_x86.js', import.meta.url);
const CDN = 'https://cdn.jsdelivr.net/npm/@alexaltea/unicorn-js@2.1.4/dist/unicorn_x86.js';

export async function loadNativeEngine() {
 if (!globalThis.crypto?.subtle) throw new Error('The native experiment requires HTTPS or localhost for dependency integrity checking.');
 let response = await fetch(LOCAL).catch(() => null);
 if (!response?.ok) response = await fetch(CDN);
 if (!response.ok) throw new Error('Cannot load Unicorn.js. Run npm ci --ignore-scripts and serve the repository root.');
 const bytes = await response.arrayBuffer();
 if (bytes.byteLength > 2 << 20) throw new Error('Emulator dependency exceeds size limit');
 const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
 if (hash !== HASH) throw new Error('Emulator dependency failed its SHA-256 integrity check');
 const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
 try { importScripts(url); } finally { URL.revokeObjectURL(url); }
 return globalThis.MUnicorn();
}

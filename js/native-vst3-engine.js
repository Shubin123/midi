const HASH = '75c6b66b745079190372efc245e462374a5db8cc45f9e4edccd242122fc6a632';
const LOCAL = new URL('../vendor/unicorn/unicorn.cjs', import.meta.url);

export async function loadNativeEngine() {
 if (!globalThis.crypto?.subtle) throw new Error('The native experiment requires HTTPS or localhost for dependency integrity checking.');
 const response = await fetch(LOCAL).catch(() => null);
 if (!response?.ok) throw new Error('Cannot load the patched Unicorn.js engine. Serve the repository root including vendor/unicorn.');
 const bytes = await response.arrayBuffer();
 if (bytes.byteLength > 2 << 20) throw new Error('Emulator dependency exceeds size limit');
 const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
 if (hash !== HASH) throw new Error('Emulator dependency failed its SHA-256 integrity check');
 const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
 try { importScripts(url); } finally { URL.revokeObjectURL(url); }
 return globalThis.MUnicorn();
}

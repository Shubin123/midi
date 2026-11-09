const HASH = '5ff21197e8c6413b1255b28b219e901b14436d9765de8c3deda176f12fd58191';
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

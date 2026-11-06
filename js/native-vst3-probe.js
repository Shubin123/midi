export function probeNativeVst3(file, { mode = 'startup', timeout = 30000, signal, onProgress = () => {} } = {}) {
 if (!(file instanceof Blob)) return Promise.reject(new Error('Expected a plugin Blob or File'));
 if (!['startup', 'factory'].includes(mode)) return Promise.reject(new Error('Unknown native probe mode'));
 if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) return Promise.reject(new Error('Invalid native probe timeout'));
 if (signal?.aborted) return Promise.reject(new DOMException('Native probe cancelled', 'AbortError'));
 return new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./native-vst3-worker.js', import.meta.url));
  let settled = false;
  const finish = (error, value) => {
   if (settled) return;
   settled = true;
   clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate();
   if (error) reject(error); else resolve(value);
  };
  const abort = () => finish(new DOMException('Native probe cancelled', 'AbortError'));
  const timer = setTimeout(() => finish(new Error('Native probe exceeded its wall-clock limit; worker terminated')), timeout);
  signal?.addEventListener('abort', abort, { once: true });
  worker.onmessage = ({ data }) => {
   if (data.type === 'result') finish(null, data.result);
   else if (data.type === 'progress') {
    try { onProgress(data.stage); } catch (error) { finish(error); }
   }
  };
  worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'Native worker failed')); };
  worker.onmessageerror = () => finish(new Error('Could not read native worker result'));
  try { worker.postMessage({ file, mode }); } catch (error) { finish(error); }
 });
}

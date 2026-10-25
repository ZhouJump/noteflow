import { defineConfig } from 'vite';

/**
 * COOP/COEP are what let onnxruntime-web use more than one WASM thread, so the
 * timings this page reports are the ones a deployed build would see.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022' },
});

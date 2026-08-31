import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // Tauri targets a known webview, so there is no reason to ship legacy output.
  build: { target: 'es2022', sourcemap: true },
});

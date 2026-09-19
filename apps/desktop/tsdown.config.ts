import { defineConfig } from 'tsdown'

/** Bundle the transitional Electron entry and the Tauri sidecar entries. */
export default defineConfig({
  entry: [
    'lib/types/main.js',
    'lib/types/sidecar-bin.js',
    'lib/types/sidecar-directory-picker.js',
    'lib/types/sidecar-feasibility.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: ['@deepseek-ai/dsh/profile-boot'],
    neverBundle: ['electron'],
  },
})

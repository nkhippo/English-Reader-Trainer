import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages: served at https://nkhippo.github.io/English-Reader-Trainer/
export default defineConfig({
  plugins: [react()],
  base: '/English-Reader-Trainer/',
});

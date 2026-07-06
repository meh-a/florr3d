import { defineConfig } from 'vite';

// GitHub Pages serves project sites under /<repo-name>/, so asset URLs
// need that prefix in production builds.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/florr3d/' : '/',
});

// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Published on GitHub Pages as a project site: https://luismdev.github.io/promptgraph/
export default defineConfig({
  site: 'https://luismdev.github.io',
  base: '/promptgraph',
  trailingSlash: 'always',
  integrations: [sitemap()],
});

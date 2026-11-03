# promptgraph landing page

Static marketing site for promptgraph, built with [Astro](https://astro.build) and published to
GitHub Pages at <https://luismdev.github.io/promptgraph/>.

```bash
pnpm --filter @promptgraph/site dev      # local dev server
pnpm --filter @promptgraph/site build    # static output in site/dist
pnpm --filter @promptgraph/site preview  # serve the build
```

Deployment runs from `.github/workflows/pages.yml` on every push to `main` that touches `site/`.
Screenshots in `src/assets/screens/` are copies of `docs/screenshots/`; Astro converts them to
responsive WebP at build time. SEO: canonical URL, Open Graph/Twitter cards (`public/og.png`),
JSON-LD (`SoftwareApplication` and `FAQPage`), `robots.txt` and a generated sitemap.

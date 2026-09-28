// HOLDOUT build: bundles src/main.js (ESM) with esbuild and inlines everything into ONE self-contained dist/index.html.
// Usage: node build.js [--dev]   (--dev = no minify, sourcemap inline)
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const DEV = process.argv.includes('--dev');
const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const PWA = path.join(ROOT, 'pwa');

async function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const t0 = Date.now();
  const result = await esbuild.build({
    entryPoints: [path.join(SRC, 'main.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020', 'safari15', 'chrome90'],
    minify: !DEV,
    sourcemap: DEV ? 'inline' : false,
    write: false,
    legalComments: 'none',
    define: { __DEV__: DEV ? 'true' : 'false', __BUILD__: JSON.stringify(new Date().toISOString()) },
    logLevel: 'warning',
  });
  const js = result.outputFiles[0].text;
  // All CSS under src/ui is inlined: styles.css (base layout) first, then the rest in sorted order.
  const uiDir = path.join(SRC, 'ui');
  const cssFiles = fs.existsSync(uiDir) ? fs.readdirSync(uiDir).filter((f) => f.endsWith('.css')).sort((a, b) => (a === 'styles.css' ? -1 : b === 'styles.css' ? 1 : a.localeCompare(b))) : [];
  const css = cssFiles.map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(uiDir, f), 'utf8')).join('\n');
  const cssMin = DEV ? css : (await esbuild.transform(css, { loader: 'css', minify: true })).code;
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  // Inline manifest as data URL so the single file is installable-ish even standalone; real manifest is copied alongside too.
  html = html.replace('/*__CSS__*/', () => cssMin);
  html = html.replace('/*__JS__*/', () => js.replace(/<\/script>/gi, '<\\/script>'));
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  // PWA companions
  if (fs.existsSync(PWA)) {
    for (const f of fs.readdirSync(PWA)) {
      const p = path.join(PWA, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(DIST, f));
    }
  }
  const size = fs.statSync(path.join(DIST, 'index.html')).size;
  console.log(`built dist/index.html ${(size / 1024).toFixed(1)} KB in ${Date.now() - t0}ms${DEV ? ' (dev)' : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

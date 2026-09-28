// Quick screenshot: node tools/shot.js [out.png] [device] [--wait ms] [--eval "js"]
const { launch } = require('./browser');
(async () => {
  const args = process.argv.slice(2);
  const out = args.find(a => a.endsWith('.png')) || 'tests/out/shot.png';
  const device = args.find(a => ['iphone14','pixel7','se','tablet'].includes(a)) || 'iphone14';
  const wi = args.indexOf('--wait'); const wait = wi >= 0 ? Number(args[wi+1]) : 3000;
  const ei = args.indexOf('--eval'); const ev = ei >= 0 ? args[ei+1] : null;
  require('fs').mkdirSync('tests/out', { recursive: true });
  const b = await launch({ device });
  await b.page.waitForTimeout(wait);
  if (ev) { try { const r = await b.page.evaluate(ev); console.log('eval:', JSON.stringify(r)); } catch (e) { console.log('eval error:', e.message); } await b.page.waitForTimeout(800); }
  await b.page.screenshot({ path: out });
  console.log('saved', out, '| errors:', b.errors.length); b.errors.forEach(e => console.log('  ', e.split('\n')[0]));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });

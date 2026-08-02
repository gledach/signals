import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route('**/*', (route) => route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-cache' } }));
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem('signal.theme', 'dark'); } catch {} });
await page.goto('http://localhost:5180/#mode=feed', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const info = await page.evaluate(() => {
  const card = document.getElementById('feed-competitor-card');
  const meta = card?.querySelector('.cc-meta');
  const cs = meta ? getComputedStyle(meta) : null;
  return {
    cardHTML: card?.innerHTML?.slice(0, 800),
    metaDisplay: cs?.display,
    metaFlexWrap: cs?.flexWrap,
    metaLineHeight: cs?.lineHeight,
    metaText: meta?.innerText,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();

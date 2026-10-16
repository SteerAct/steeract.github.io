const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function models() {
  const context = vm.createContext({});
  for (const id of ['demo-model', 'sync-model']) {
    vm.runInContext(html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`))[1], context);
  }
  return context;
}

test('mechanism advances at 3× before and after timestep 900, clamped at the end', () => {
  const {SteerDemo} = models();
  assert.equal(SteerDemo.initialIndex, 10);
  assert.equal(SteerDemo.minIndex, 10);
  assert.equal(SteerDemo.nextIndex(70, 1000), 85);
  assert.equal(SteerDemo.nextIndex(90, 1000), 105);
  assert.equal(SteerDemo.nextIndex(115, 1000), 120);
});

test('3× transport preserves both video-to-timestep mappings on play and replay', async () => {
  const {SteerSync, SteerMedia} = models();
  // Media API boundary: production timing and transport are used unchanged.
  const entries = ['unsteered', 'steered'].map(side => ({
    timing: SteerMedia[side],
    video: {readyState: 4, duration: 130, currentTime: 0, playbackRate: 1,
      paused: true, play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }}
  }));
  const transport = SteerSync.createTransport(entries);
  for (const index of [70, 90, 100, 70]) {
    assert.equal(await transport.play(index), true);
    assert.ok(Math.abs(entries[0].video.playbackRate - 14.985) < 1e-10);
    assert.ok(Math.abs(entries[1].video.playbackRate - 5.55) < 1e-10);
    assert.ok(Math.abs(transport.clockIndex() - index) < 1e-10);
    transport.pause();
    assert.ok(entries.every(e => e.video.paused));
  }
  transport.seek(90);
  assert.ok(Math.abs(entries[0].video.currentTime - 89.91) < 1e-10);
  assert.ok(Math.abs(entries[1].video.currentTime - 33.3) < 1e-10);
});

test('pair controls are centered above videos across desktop, mobile and task changes', async () => {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined});
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({viewport: {width, height: 1000}});
      await page.route('https://steeract.github.io/**', route =>
        new URL(route.request().url()).pathname === '/'
          ? route.fulfill({contentType: 'text/html', body: html}) : route.abort());
      await page.goto('https://steeract.github.io/');
      async function assertCentered(selector) {
        const rects = await page.locator(selector).evaluate(card => {
          const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,bottom:r.bottom}; };
          return {card: rect(card), button: rect(card.querySelector('.pair-transport')),
            figures: [...card.querySelectorAll('.video-card')].map(rect)};
        });
        assert.ok(Math.abs(rects.button.x + rects.button.width/2 - rects.card.x - rects.card.width/2) < 2,
          `${selector} control must be centered at ${width}px`);
        assert.ok(rects.figures.every(r => r.y >= rects.button.bottom), 'control must precede both video panels');
      }
      await assertCentered('.robot-case');
      await assertCentered('.dataset-group');
      await page.locator('#real-tabs button').nth(1).click();
      await assertCentered('.robot-case');
      await page.getByRole('tab', {name: 'DexJoCo', exact: true}).click();
      await assertCentered('.dataset-group');
      assert.equal(await page.locator('#mechanism .playback-speed').textContent(), '3× speed');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.close();
    }
  } finally { await browser.close(); }
});

test('buffer notifications pause the mechanism only when video data is still missing', async () => {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined});
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      // Deterministic media boundary: reproduce a queued waiting event after recovery.
      const states = new WeakMap();
      const state = v => { if (!states.has(v)) states.set(v, {time:0,paused:true}); return states.get(v); };
      window.mediaReadyState = 4;
      Object.defineProperties(HTMLMediaElement.prototype, {
        src: {set() {}, get() {return '';}},
        readyState: {get() {return window.mediaReadyState;}},
        duration: {get() {return 130;}},
        currentTime: {get() {return state(this).time;}, set(t) {state(this).time=t;}},
        paused: {get() {return state(this).paused;}}
      });
      HTMLMediaElement.prototype.play = function() {state(this).paused=false;return Promise.resolve();};
      HTMLMediaElement.prototype.pause = function() {state(this).paused=true;};
    });
    await page.route('https://steeract.github.io/**', route =>
      new URL(route.request().url()).pathname === '/'
        ? route.fulfill({contentType:'text/html',body:html}) : route.abort());
    await page.goto('https://steeract.github.io/');
    await page.locator('#play-button').click();
    await page.waitForFunction(() => document.getElementById('play-button').getAttribute('aria-pressed') === 'true');
    await page.evaluate(() => document.getElementById('unsteered-linked-video').dispatchEvent(new Event('waiting')));
    assert.equal(await page.locator('#play-button').getAttribute('aria-pressed'), 'true', 'recovered video must not stop playback');
    await page.evaluate(() => {window.mediaReadyState=2;document.getElementById('unsteered-linked-video').dispatchEvent(new Event('waiting'));});
    await page.waitForFunction(() => document.getElementById('play-button').getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('#play-button').getAttribute('aria-pressed'), 'false', 'persistent buffering must pause both videos');
    assert.ok(await page.locator('#mechanism video').evaluateAll(vs=>vs.every(v=>v.paused)));
  } finally {await browser.close();}
});

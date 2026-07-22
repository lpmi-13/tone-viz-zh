import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
if (spawnSync("test", ["-x", chrome]).status !== 0) {
  console.log(`Browser flow skipped: Chrome not found at ${chrome}`);
  process.exit(0);
}

const port = 5198;
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/dev.mjs"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await waitForServer();
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const consoleErrors = [], referenceRequests = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => { if (request.url().includes("/references/")) referenceRequests.push(request.url()); });
  await page.goto(baseUrl, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelector("#resultCount")?.textContent === "60");

  assert.equal(await page.$$eval("#speakerSelect option", (items) => items.length), 6);
  assert.equal(await page.$$eval("#topicFilters [data-topic]", (items) => items.length), 7);
  assert.ok(referenceRequests.length === 1, "only the selected phrase shard should load initially");
  assert.equal(await page.$eval("#transcript", (item) => item.classList.contains("is-concealed")), true);
  assert.equal(await page.$eval("#phraseChart", (item) => item.classList.contains("is-hidden")), true);

  await page.click("#toggleLabels");
  assert.ok(await page.$("#phraseChart svg"), "revealed automatic reference layout should render");
  await page.click("#transcript [data-segment-id]");
  assert.match(await page.$eval("#detailHint", (item) => item.textContent || ""), /Underlying|Neutral/);
  assert.ok(await page.$("#phraseChart .overview-viewport"));
  await page.click("#clearZoom");

  await page.type("#phraseSearch", "beijing");
  await page.waitForFunction(() => Number(document.querySelector("#resultCount")?.textContent) === 1);
  assert.match(await page.$eval("#phraseResults", (item) => item.textContent || ""), /北京/);
  await page.click("#phraseSearch");
  await page.evaluate(() => { const input = document.querySelector("#phraseSearch"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click('#toneFilters [data-tone="tone-4"]');
  await page.waitForFunction(() => Number(document.querySelector("#resultCount")?.textContent) > 0 && Number(document.querySelector("#resultCount")?.textContent) < 60);
  await page.click('#toneFilters [data-tone="tone-4"]');

  await page.click("#phraseResults [data-phrase]:not(.is-active)");
  await page.waitForFunction(() => !document.querySelector("#practiceStatus")?.textContent?.includes("Loading"));
  assert.ok(referenceRequests.length === 2, "selecting another phrase should lazy-load one additional shard");
  await page.select("#speakerSelect", "speaker-m1");
  await page.waitForFunction(() => document.querySelector("#speakerSelect")?.value === "speaker-m1");
  await page.click('[data-speed="slowed"]');
  assert.equal(await page.$eval('[data-speed="slowed"]', (item) => item.getAttribute("aria-pressed")), "true");

  await page.click('[data-mode="quiz"]');
  await page.waitForFunction(() => !document.querySelector("#quizMode")?.classList.contains("is-hidden"));
  assert.match(
    await page.$eval("#quizPrompt", (item) => item.textContent || ""),
    /unambiguous|Which (?:word|syllable) (?:is|rises|falls)/
  );

  await page.click('[data-mode="explore"]');
  await page.evaluate(() => Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) } }));
  await page.click("#recordExplore");
  await page.waitForFunction(() => document.querySelector("#exploreStatus")?.textContent?.includes("denied"));
  assert.match(await page.$eval("#exploreStatus", (item) => item.textContent || ""), /upload fallback/i);

  await page.click("#aboutButton");
  assert.equal(await page.$eval("#aboutDialog", (item) => item.hasAttribute("open")), true);
  assert.match(await page.$eval("#aboutDialog", (item) => item.textContent || ""), /have not been reviewed by a Mandarin speaker/);
  await page.keyboard.press("Escape");

  await page.click('[data-mode="practice"]');
  for (const width of [390, 320]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `no body overflow at ${width}px`);
  }
  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(" | ")}`);
  console.log("Browser flow valid: dynamic speakers, search/tone filters, lazy shards, reveal/zoom, variants, quiz gate, denied-mic upload fallback, disclosure, and mobile layout.");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}

async function waitForServer() {
  let error;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(baseUrl); if (response.ok) return; } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw error || new Error("Dev server did not start");
}

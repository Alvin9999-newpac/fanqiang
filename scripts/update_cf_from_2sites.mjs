import fs from "node:fs";
import { chromium } from "playwright";

/* ================= 基本配置 ================= */

const WETEST_URL = "https://www.wetest.vip/page/cloudflare/address_v4.html";
const HOSTMONIT_URL = "https://stock.hostmonit.com/CloudFlareYes";

const OUTPUT_FILE = "cloudflare优选ip";
const CARRIER_ORDER = ["移动", "联通", "电信"];
const MIN_TOTAL_IPS = 10;

/* ================= 工具函数 ================= */

export function isIPv4(ip = "") {
  if (typeof ip !== "string") return false;
  const value = ip.trim();
  return /^((\d{1,3}\.){3}\d{1,3})$/.test(value) &&
    value.split(".").every(n => Number(n) >= 0 && Number(n) <= 255);
}

export function normalizeCarrier(s = "") {
  const text = String(s || "");
  if (/移动|CMCC|China Mobile/i.test(text)) return "移动";
  if (/联通|UNICOM|CUCC|China Unicom/i.test(text)) return "联通";
  if (/电信|TELECOM|CTCC|China Telecom/i.test(text)) return "电信";
  return "";
}

export function uniq(arr) {
  return [...new Set(arr)];
}

export function extractTableRowsFromHtml(html = "") {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;

  for (const rowMatch of html.matchAll(rowPattern)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(cellPattern)) {
      const text = cellMatch[1]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
      if (text) cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }

  return rows;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

async function fetchTableFromHtml(url) {
  const html = await fetchHtml(url);
  return extractTableRowsFromHtml(html);
}

async function fetchTableWithBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("table", { timeout: 60000 });

    return await page.$$eval("table tbody tr", trs =>
      trs.map(tr =>
        Array.from(tr.querySelectorAll("td,th")).map(td =>
          td.textContent?.trim() || ""
        )
      )
    );
  } finally {
    await browser.close();
  }
}

async function fetchTable(url) {
  try {
    return await fetchTableWithBrowser(url);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/Executable doesn't exist|browserType\.launch|failed to launch|Cannot find/i.test(message)) {
      throw error;
    }
    return fetchTableFromHtml(url);
  }
}

async function fetchWetest() {
  const rows = await fetchTable(WETEST_URL);
  const map = new Map();

  for (const cols of rows) {
    const carrier = normalizeCarrier(cols[0]);
    const ip = cols.find(isIPv4);
    if (!carrier || !ip) continue;
    if (!map.has(carrier)) map.set(carrier, []);
    map.get(carrier).push(ip);
  }
  return map;
}

async function fetchHostmonit() {
  const rows = await fetchTable(HOSTMONIT_URL);
  const map = new Map();

  for (const cols of rows) {
    const carrier = normalizeCarrier(cols[0]);
    const ip = cols.find(isIPv4);
    if (!carrier || !ip) continue;
    if (!map.has(carrier)) map.set(carrier, []);
    map.get(carrier).push(ip);
  }
  return map;
}

/* ================= 主逻辑 ================= */

async function main() {
  const result = new Map();

  async function tryFetch(fn, name) {
    try {
      const data = await fn();
      console.log(`${name} OK`);
      for (const [k, v] of data.entries()) {
        if (!result.has(k)) result.set(k, []);
        result.get(k).push(...v);
      }
    } catch (e) {
      console.error(`${name} FAILED:`, e.message);
    }
  }

  await Promise.all([
    tryFetch(fetchWetest, "WeTest"),
    tryFetch(fetchHostmonit, "HostMonit")
  ]);

  let total = 0;
  const lines = [];

  lines.push(`# Auto generated`);
  lines.push(`# Updated: ${new Date().toISOString()}`);
  lines.push("");

  for (const carrier of CARRIER_ORDER) {
    const ips = uniq(result.get(carrier) || []);
    if (ips.length === 0) continue;
    total += ips.length;
    lines.push(`## ${carrier} (${ips.length})`);
    lines.push(...ips);
    lines.push("");
  }

  if (total < MIN_TOTAL_IPS) {
    throw new Error(`Too few IPs (${total}), abort write.`);
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  console.log(`Wrote ${total} IPs -> ${OUTPUT_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

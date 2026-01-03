import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

/* ================= 基本配置 ================= */

const WETEST_URL = "https://www.wetest.vip/page/cloudflare/address_v4.html";
const HOSTMONIT_URL = "https://stock.hostmonit.com/CloudFlareYes";

const OUTPUT_FILE = "cloudflare优选ip";
const CARRIER_ORDER = ["移动", "联通", "电信"];
const MIN_TOTAL_IPS = 10;

/* ================= 工具函数 ================= */

function isIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split(".").every(n => Number(n) >= 0 && Number(n) <= 255);
}

function normalizeCarrier(s = "") {
  if (/移动|CMCC/i.test(s)) return "移动";
  if (/联通|UNICOM|CUCC/i.test(s)) return "联通";
  if (/电信|TELECOM|CTCC/i.test(s)) return "电信";
  return "";
}

function uniq(arr) {
  return [...new Set(arr)];
}

/* ================= 抓取函数 ================= */

async function fetchTable(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("table", { timeout: 60000 });

  const rows = await page.$$eval("table tbody tr", trs =>
    trs.map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td =>
        td.textContent?.trim() || ""
      )
    )
  );

  await browser.close();
  return rows;
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});

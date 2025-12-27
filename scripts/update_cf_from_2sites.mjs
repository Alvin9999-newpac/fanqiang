import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// 站点
const WETEST_URL = "https://www.wetest.vip/page/cloudflare/address_v4.html";
const HOSTMONIT_URL = "https://stock.hostmonit.com/CloudFlareYes";

// ✅ 你要更新的目标文件
const TARGET_FILE = "cloudflare_ipv4.txt";

// ✅ 输出顺序（按你想要的）
const CARRIERS_ORDER = ["移动", "联通", "电信"];

// ✅ 可选：每个运营商最多保留 N 个（0=不限制）
const TOP_N_PER_CARRIER = 0;

// 运营商归一化：有些站可能写“移动/CMCC”等，先统一成三大运营商
function normCarrier(s) {
  const t = (s || "").trim();
  if (t.includes("移动") || /CMCC/i.test(t)) return "移动";
  if (t.includes("联通") || /CUCC|UNICOM/i.test(t)) return "联通";
  if (t.includes("电信") || /CTCC|TELECOM/i.test(t)) return "电信";
  return ""; // 不在三大运营商内的忽略（你也可以改成“其他”）
}

function isIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every((x) => Number(x) >= 0 && Number(x) <= 255);
}

function uniqKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function mergeMap(dst, src) {
  for (const [k, v] of src.entries()) {
    if (!dst.has(k)) dst.set(k, []);
    dst.get(k).push(...v);
  }
}

async function fetchWetestByCarrier() {
  // WeTest 是静态 HTML：直接 fetch + 正则/DOM 都行，这里用简单 regex 抓全页 IPv4，再靠“运营商表格”很难可靠对应
  // 更稳方式：用浏览器读表格（同 Playwright），保证能拿到 Line/IP 列并对应运营商
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(WETEST_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector("table", { timeout: 60_000 });

  const rows = await page.$$eval("table tbody tr", (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() || ""))
  );

  // 一般列：线路 | 优选地址(IP) | Latency | Loss | Speed | Colo ...
  const out = new Map();
  for (const cols of rows) {
    const carrier = normCarrier(cols[0] || "");
    const ip = cols.find((c) => /^(\d{1,3}\.){3}\d{1,3}$/.test(c)) || cols[1] || "";
    if (!carrier || !isIPv4(ip)) continue;
    if (!out.has(carrier)) out.set(carrier, []);
    out.get(carrier).push(ip);
  }

  await browser.close();
  return out;
}

async function fetchHostmonitByCarrier() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(HOSTMONIT_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector("table", { timeout: 60_000 });

  const rows = await page.$$eval("table tbody tr", (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() || ""))
  );

  // 经验列：Line | IP | Latency | Loss | Speed | Colo | ...
  const out = new Map();
  for (const cols of rows) {
    const carrier = normCarrier(cols[0] || "");
    const ip = cols.find((c) => /^(\d{1,3}\.){3}\d{1,3}$/.test(c)) || cols[1] || "";
    if (!carrier || !isIPv4(ip)) continue;
    if (!out.has(carrier)) out.set(carrier, []);
    out.get(carrier).push(ip);
  }

  await browser.close();
  return out;
}

async function main() {
  const merged = new Map();

  const [wetest, hostmonit] = await Promise.all([
    fetchWetestByCarrier(),
    fetchHostmonitByCarrier(),
  ]);

  mergeMap(merged, wetest);
  mergeMap(merged, hostmonit);

  // 去重、裁剪、按顺序输出
  const now = new Date().toISOString();
  const lines = [];
  lines.push(`# Sources:`);
  lines.push(`# - ${WETEST_URL}`);
  lines.push(`# - ${HOSTMONIT_URL}`);
  lines.push(`# Updated (UTC): ${now}`);
  lines.push("");

  let total = 0;
  for (const carrier of CARRIERS_ORDER) {
    const ips0 = merged.get(carrier) || [];
    const ips = uniqKeepOrder(ips0);
    const picked = TOP_N_PER_CARRIER > 0 ? ips.slice(0, TOP_N_PER_CARRIER) : ips;

    lines.push(`## ${carrier} (${picked.length})`);
    lines.push(...picked);
    lines.push("");
    total += picked.length;
  }

  // 保险：避免异常写空
  if (total < 5) {
    throw new Error(`Too few IPs after merge: ${total}. Abort writing.`);
  }

  fs.mkdirSync(path.dirname(TARGET_FILE), { recursive: true });
  fs.writeFileSync(TARGET_FILE, lines.join("\n"), "utf-8");
  console.log(`Wrote ${total} IPs -> ${TARGET_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

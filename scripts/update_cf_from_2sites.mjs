import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// 数据源
const WETEST_URL = "https://www.wetest.vip/page/cloudflare/address_v4.html";
const HOSTMONIT_URL = "https://stock.hostmonit.com/CloudFlareYes";

// ✅ 你要更新的目标文件（与你仓库文件名一致）
const TARGET_FILE = "cloudflare优选ip";

// ✅ 输出顺序
const CARRIERS_ORDER = ["移动", "联通", "电信"];

// ✅ 可选：每个运营商最多保留 N 个（0=不限制）
const TOP_N_PER_CARRIER = 0;

// ✅ 最少总数阈值：低于这个就认为抓取异常，避免写空
const MIN_TOTAL_IPS = 10;

// ✅ 超时设置（HostMonit 在 Actions 容易慢/抽风：建议短一点，失败就跳过）
const TIMEOUT_WETEST_MS = 90_000;
const TIMEOUT_HOSTMONIT_MS = 35_000;

// ---------- 工具函数 ----------
function normCarrier(s) {
  const t = (s || "").trim();
  if (t.includes("移动") || /CMCC/i.test(t)) return "移动";
  if (t.includes("联通") || /CUCC|UNICOM/i.test(t)) return "联通";
  if (t.includes("电信") || /CTCC|TELECOM/i.test(t)) return "电信";
  return "";
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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function retry(fn, times = 2, delayMs = 2000) {
  let lastErr;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      console.log(`Retry ${i}/${times} failed: ${e?.message || e}`);
      if (i < times) await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function fetchRowsWithPlaywright({ url, timeoutMs }) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // 不用 networkidle，避免站点有长连接导致永远不 idle
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // 有些站表格渲染慢：等行出现
    await page.waitForSelector("table tbody tr", { timeout: timeoutMs });

    const rows = await page.$$eval("table tbody tr", (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() || ""))
    );

    return rows;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function rowsToCarrierMap(rows) {
  // 经验列：Line | IP | ...
  const out = new Map();

  for (const cols of rows) {
    const carrier = normCarrier(cols[0] || "");
    const ip = cols.find((c) => /^(\d{1,3}\.){3}\d{1,3}$/.test(c)) || cols[1] || "";
    if (!carrier || !isIPv4(ip)) continue;

    if (!out.has(carrier)) out.set(carrier, []);
    out.get(carrier).push(ip);
  }
  return out;
}

// ---------- 两个站点抓取 ----------
async function fetchWetestByCarrier() {
  return await retry(async () => {
    const rows = await fetchRowsWithPlaywright({ url: WETEST_URL, timeoutMs: TIMEOUT_WETEST_MS });
    const map = rowsToCarrierMap(rows);

    // 简单 sanity check
    const count = [...map.values()].reduce((a, b) => a + b.length, 0);
    if (count < 5) throw new Error(`WeTest extracted too few IPs: ${count}`);
    return map;
  }, 2, 1500);
}

async function fetchHostmonitByCarrier() {
  return await retry(async () => {
    const rows = await fetchRowsWithPlaywright({ url: HOSTMONIT_URL, timeoutMs: TIMEOUT_HOSTMONIT_MS });
    const map = rowsToCarrierMap(rows);

    const count = [...map.values()].reduce((a, b) => a + b.length, 0);
    if (count < 5) throw new Error(`HostMonit extracted too few IPs: ${count}`);
    return map;
  }, 2, 2000);
}

// ---------- 主流程 ----------
async function main() {
  const merged = new Map();

  // ✅ 任意一个站成功即可继续
  const results = await Promise.allSettled([fetchWetestByCarrier(), fetchHostmonitByCarrier()]);

  const [rWetest, rHost] = results;

  if (rWetest.status === "fulfilled") {
    console.log("WeTest OK");
    mergeMap(merged, rWetest.value);
  } else {
    console.log("WeTest FAILED:", rWetest.reason?.message || rWetest.reason);
  }

  if (rHost.status === "fulfilled") {
    console.log("HostMonit OK");
    mergeMap(merged, rHost.value);
  } else {
    console.log("HostMonit FAILED:", rHost.reason?.message || rHost.reason);
  }

  // 输出：去重、裁剪、按顺序分段
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

  // ✅ 两站都挂/数据太少才失败（避免写空）
  if (total < MIN_TOTAL_IPS) {
    throw new Error(`Too few IPs after merge: ${total} (<${MIN_TOTAL_IPS}). Abort writing.`);
  }

  // 写文件（目标文件在根目录时 dirname=.)
  const dir = path.dirname(TARGET_FILE);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(TARGET_FILE, lines.join("\n"), "utf-8");
  console.log(`Wrote ${total} IPs -> ${TARGET_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

importScripts("taoke-report.js", "taoke-page.js", "taoke-flow.js");
const recentDownloads = [];
const pluginDownloadIds = new Set();
const PRIVATE_DOWNLOADS_KEY = "pluginDownloadsV1";
// Discard legacy broad browser-download metadata, never the files themselves.
let downloadRecordQueue = chrome.storage.local.set({ recentDownloads: [] })
  .then(() => chrome.storage.local.get(PRIVATE_DOWNLOADS_KEY))
  .then(saved => { recentDownloads.push(...(saved[PRIVATE_DOWNLOADS_KEY] || []).slice(0, 30)); })
  .catch(() => {});

function rememberPluginDownload(item) {
  if (!item || item.state !== "complete") return downloadRecordQueue;
  const record = { id: item.id, filename: item.filename, endedAt: item.endTime };
  downloadRecordQueue = downloadRecordQueue.then(async () => {
    const previous = recentDownloads.findIndex(entry => entry.id === record.id);
    if (previous >= 0) recentDownloads.splice(previous, 1);
    recentDownloads.unshift(record);
    recentDownloads.splice(30);
    await chrome.storage.local.set({ [PRIVATE_DOWNLOADS_KEY]: recentDownloads.slice() });
  }).catch(() => {});
  return downloadRecordQueue;
}

function isCollectorSource(item) {
  return [item.url, item.finalUrl, item.referrer].some(value => {
    try {
      const url = new URL(String(value || "").replace(/^blob:/, ""));
      return url.protocol === "https:" && ["sycm.taobao.com", "myseller.taobao.com", "one.alimama.com", "ad.alimama.com"].includes(url.hostname);
    } catch { return false; }
  });
}
let activeDownloadContext = null;
let productRunActive = false;
let alimamaRunActive = false;
const PAUSE_KEY = "collectorPaused";
const SCHEDULE_ALARM = "taobaoDailyCollection";
const AFTERNOON_SCHEDULE_ALARM = "taobaoAfternoonCollection";
const SCHEDULE_ENABLED_KEY = "dailyScheduleEnabled";
const SCHEDULE_TIME_KEY = "dailyScheduleTime";
const AFTERNOON_SCHEDULE_TIME_KEY = "dailyAfternoonScheduleTime";
const SCHEDULE_PAID_KEY = "dailyScheduleIncludePaid";
const SCHEDULE_STORE_REPORT_KEY = "dailyScheduleIncludeStoreReport";
const SCHEDULE_PRODUCT_REPORT_KEY = "dailyScheduleIncludeProductReport";
const SCHEDULE_SCENE_REPORT_KEY = "dailyScheduleIncludeSceneReport";
const SCHEDULE_ITEM_REPORT_KEY = "dailyScheduleIncludeItemReport";
const SCHEDULE_CONTENT_REPORT_KEY = "dailyScheduleIncludeContentReport";
const SCHEDULE_TAOKE_REPORT_KEY = "dailyScheduleIncludeTaokeReport";
const MORNING_LAST_SUCCESS_DATE_KEY = "lastSuccessfulMorningCollectionDate";
const AFTERNOON_LAST_SUCCESS_DATE_KEY = "lastSuccessfulAfternoonCollectionDate";
const DOWNLOAD_WAIT_MS = 60000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const VERIFIED_DOWNLOADS_KEY = "verifiedAlimamaDownloads";
const SHOP_IDENTITY_KEY = "shopIdentity";
const STORE_RETRY_ALARM = "taobaoStoreRetry";
const STORE_REFRESH_ALARM = "taobaoStoreRefresh";
const DEFAULT_SHOP_IDENTITY = "我的淘宝店铺";
let shopIdentity = DEFAULT_SHOP_IDENTITY;
let scheduledRunActive = false;

chrome.storage.local.get(SHOP_IDENTITY_KEY).then((saved) => {
  const value = String(saved?.[SHOP_IDENTITY_KEY] || "").trim();
  if (value && value !== "未设置店铺") shopIdentity = value;
}).catch(() => {});

function safeShopSegment(value) {
  return String(value || "未设置店铺")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "未设置店铺";
}

async function configuredCollectorShopForScheduledRun() {
  const saved = await chrome.storage.local.get(SHOP_IDENTITY_KEY);
  const localName = String(saved?.[SHOP_IDENTITY_KEY] || shopIdentity || "").trim();
  if (localName && localName !== "未设置店铺") {
    shopIdentity = localName;
    return { id: "local-profile", name: localName };
  }
  shopIdentity = DEFAULT_SHOP_IDENTITY;
  await chrome.storage.local.set({ [SHOP_IDENTITY_KEY]: shopIdentity });
  return { id: "local-profile", name: shopIdentity };
}

const MONITORED_FLOW_STAGES = {
  sycm_store_download: { stage: "store_daily", label: "店铺经营核心日报" },
  sycm_product_download: { stage: "product_daily", label: "商品数据" },
  alimama_paid_download: { stage: "paid_scene", label: "营销场景报表" },
  alimama_scene_download: { stage: "paid_scene", label: "营销场景报表" },
  alimama_item_download: { stage: "paid_item", label: "商品推广报表" },
  alimama_content_download: { stage: "paid_content", label: "内容推广明细" },
  taoke_overview_download: { stage: "taoke_overview", label: "淘宝联盟推广概览" },
};

async function runMonitoredCollectorAction(flow, range, action, options = {}) {
  await configuredCollectorShopForScheduledRun();
  const monitored = MONITORED_FLOW_STAGES[flow] || { stage: "collection", label: "数据采集" };
  const reportDate = range?.end || range?.start || "";
  await appendCollectorLog(`开始${monitored.label}${reportDate ? ` ${reportDate}` : ""}`);
  try {
    const result = await action();
    await appendCollectorLog(result?.ok ? `${monitored.label}已完成` : result?.reason || `${monitored.label}未完成`);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendCollectorLog(`${monitored.label}异常：${reason}`);
    throw error;
  }
}

const FLOW_TABLE = {
  sycm_store_download: "store_daily",
  sycm_product_download: "product_daily",
  alimama_paid_download: "paid_scene",
  alimama_scene_download: "paid_scene",
  alimama_item_download: "paid_item",
  alimama_content_download: "paid_content",
  taoke_overview_download: "taoke_overview",
};

const ALIMAMA_ACCOUNT_URL = "https://one.alimama.com/index.html#!/report/account?rptType=account&isRequestedQztDefaultSet=1&startTime={date}&endTime={date}";
const ALIMAMA_ITEM_PROMOTION_URL = "https://one.alimama.com/index.html#!/report/item_promotion?rptType=item_promotion&isRequestedQztDefaultSet=1&startTime={date}&endTime={date}";
const ALIMAMA_CONTENT_PROMOTION_URL = "https://one.alimama.com/index.html#!/report/other_promotion?rptType=other_promotion&bizCodeIn=%5B%22onebpShortVideo%22%5D&startTime={date}&endTime={date}";
const ALIMAMA_DOWNLOAD_LIST_URL = "https://one.alimama.com/index.html#!/report/download-list";
// The outer create page embeds the actual report UI in an iframe. Open its
// template view directly so the store daily card and its download button are
// available to the extension's page script.
const SYCM_STORE_DAILY_URL = "https://sycm.taobao.com/lyone/auto_analysis/datafetch/create?insertType=sycm&layoutHide=1&useDebug=false&activeKey=template";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleepRandom(min, max) {
  await sleep(randomInt(min, max));
}

function isReportDownload(downloadItem = {}) {
  const text = [
    downloadItem.filename,
    downloadItem.finalUrl,
    downloadItem.url,
    downloadItem.mime,
  ].filter(Boolean).join(" ").toLowerCase();

  // Alimama creates a ZIP task first; treating only the extracted table as a
  // completed download leaves a multi-day run waiting forever after day one.
  return /\.(?:xls|xlsx|csv|zip)(?:$|[?#\s])|excel|spreadsheet|csv|application\/zip/.test(text);
}

function matchesExpectedReportDownload(downloadItem = {}, expected = {}, allowUnlabeled = false) {
  if (!isReportDownload(downloadItem)) return false;
  const filename = String(downloadItem.filename || "").replace(/\\/g, "/").toLowerCase();
  const dateMatches = !expected.date || filename.includes(String(expected.date).toLowerCase());
  const tableMatches = !expected.table || filename.includes(String(expected.table).toLowerCase());
  const reportName = String(expected.reportName || "").toLowerCase();
  const reportMatches = !reportName || filename.includes(reportName);
  if (dateMatches && tableMatches && reportMatches) return true;
  return allowUnlabeled && dateMatches && tableMatches && Boolean(reportName) && filename.includes(reportName);
}

function matchesActiveAlimamaTaskDownload(downloadItem = {}, expected = {}) {
  if (!isReportDownload(downloadItem)) return false;
  const context = activeDownloadContext;
  if (!context || context.expiresAt < Date.now()) return false;
  if (context.date !== expected.date || context.table !== expected.table) return false;
  const reportName = String(expected.reportName || "").toLowerCase();
  if (!reportName) return false;
  const filename = String(downloadItem.filename || "").replace(/\\/g, "/").toLowerCase();
  // Alimama may use the task creation time in the ZIP name. This fallback is
  // valid only while the extension is waiting for the task it just selected.
  return filename.includes(reportName);
}

function classifyExpectedReportDownload(downloadItem = {}, expected = {}, allowTaskScoped = false) {
  if (matchesExpectedReportDownload(downloadItem, expected)) {
    return { matched: true, taskScoped: false };
  }
  if (allowTaskScoped && matchesActiveAlimamaTaskDownload(downloadItem, expected)) {
    return { matched: true, taskScoped: true };
  }
  return { matched: false, taskScoped: false };
}

function verifiedReportKey(expected = {}) {
  return [
    expected.table || "report",
    expected.reportName || expected.flow || "generic",
    expected.date || "",
  ].join(":");
}

async function hasCompletedExpectedReportDownload(expected) {
  const saved = await chrome.storage.local.get(VERIFIED_DOWNLOADS_KEY).catch(() => ({}));
  const key = verifiedReportKey(expected);
  const verified = saved?.[VERIFIED_DOWNLOADS_KEY] || {};
  const savedItem = verified[key];
  if (savedItem?.downloadId) {
    const items = await chrome.downloads.search({ id: savedItem.downloadId }).catch(() => []);
    const item = items?.[0];
    if (item?.state === "complete" && matchesExpectedReportDownload(item, expected)) {
      return true;
    }

    // A previous version accepted any unlabeled 商品报表 ZIP. Remove that stale
    // marker instead of skipping the requested date on the next run.
    delete verified[key];
    await chrome.storage.local.set({ [VERIFIED_DOWNLOADS_KEY]: verified });
  }
  const items = await chrome.downloads.search({
    state: "complete",
    limit: 100,
    orderBy: ["-endTime"],
  }).catch(() => []);
  return items.some((item) => matchesExpectedReportDownload(item, expected));
}

async function rememberVerifiedReportDownload(expected, item, options = {}) {
  if (!options.batch && !options.taskScoped && !matchesExpectedReportDownload(item, expected)) return false;
  const saved = await chrome.storage.local.get(VERIFIED_DOWNLOADS_KEY).catch(() => ({}));
  const verified = saved?.[VERIFIED_DOWNLOADS_KEY] || {};
  verified[verifiedReportKey(expected)] = {
    downloadId: item.id,
    filename: item.filename,
    verifiedAt: new Date().toISOString(),
    batch: Boolean(options.batch),
    taskScoped: Boolean(options.taskScoped),
  };
  await chrome.storage.local.set({ [VERIFIED_DOWNLOADS_KEY]: verified });
  return true;
}

async function forgetVerifiedReportDownload(expected) {
  const saved = await chrome.storage.local.get(VERIFIED_DOWNLOADS_KEY).catch(() => ({}));
  const verified = saved?.[VERIFIED_DOWNLOADS_KEY] || {};
  const key = verifiedReportKey(expected);
  if (!(key in verified)) return;
  delete verified[key];
  await chrome.storage.local.set({ [VERIFIED_DOWNLOADS_KEY]: verified });
}

function watchForCompletedReportDownload(startedAt, timeoutMs = DOWNLOAD_WAIT_MS, expected = {}, options = {}) {
  let complete = null;
  let timer = null;
  let poller = null;
  let completed = false;
  const candidateIds = new Set();

  const finish = (result = { item: null }) => {
    if (completed) return;
    completed = true;
    if (result.item?.state === "complete") void rememberPluginDownload(result.item);
    clearTimeout(timer);
    clearInterval(poller);
    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onChanged.removeListener(onChanged);
    complete(result);
  };

  const checkExisting = async () => {
    const items = await chrome.downloads.search({
      startedAfter: new Date(startedAt - 500).toISOString(),
      limit: 20,
      orderBy: ["-startTime"],
    }).catch(() => []);
    const reports = items.filter(isReportDownload);
    for (const item of reports) {
      candidateIds.add(item.id);
      const match = options.classify
        ? await options.classify(item).catch(() => ({ matched: false }))
        : classifyExpectedReportDownload(item, expected, Boolean(options.allowTaskScoped));
      if (!match.matched) continue;
      if (item.state === "complete") {
        finish({ item, taskScoped: match.taskScoped, verifiedOfficialTask: match.verifiedOfficialTask });
        return;
      }
      if (item.state === "interrupted") {
        finish({ item: null, reason: `浏览器下载中断：${item.error || "未知错误"}` });
        return;
      }
    }
  };

  const onCreated = (downloadItem) => {
    if (isReportDownload(downloadItem)) candidateIds.add(downloadItem.id);
  };

  const onChanged = (delta) => {
    if (!candidateIds.has(delta.id) || !delta.state) return;
    chrome.downloads.search({ id: delta.id }, async (items) => {
      const item = items?.[0];
      const match = options.classify
        ? await options.classify(item).catch(() => ({ matched: false }))
        : classifyExpectedReportDownload(item, expected, Boolean(options.allowTaskScoped));
      if (!item || !match.matched) return;
      if (delta.state.current === "complete") finish({ item, taskScoped: match.taskScoped, verifiedOfficialTask: match.verifiedOfficialTask });
      if (delta.state.current === "interrupted") {
        finish({ item: null, reason: `浏览器下载中断：${item.error || "未知错误"}` });
      }
    });
  };

  const promise = new Promise((resolve) => {
    complete = resolve;
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    poller = setInterval(checkExisting, 900);
    timer = setTimeout(() => finish({ item: null, reason: `${Math.round(timeoutMs / 1000)} 秒内没有等到表格下载完成` }), timeoutMs);
    checkExisting();
  });

  return { promise, cancel: () => finish({ item: null }) };
}

async function waitForReportDownloadStarted(startedAt, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({
      startedAfter: new Date(startedAt - 500).toISOString(),
      limit: 20,
      orderBy: ["-startTime"],
    }).catch(() => []);
    const report = items.find(isReportDownload);
    if (report) return report;
    await sleep(500);
  }
  return null;
}

function watchForCompletedBatchReportDownloads(startedAt, expectedCount, timeoutMs = 60000) {
  let complete = null;
  let timer = null;
  let poller = null;
  let settled = false;
  let firstActivityAt = 0;
  let lastActivityAt = 0;
  const candidateIds = new Set();

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(poller);
    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onChanged.removeListener(onChanged);
    complete(result);
  };

  const checkDownloads = async () => {
    const items = await chrome.downloads.search({
      startedAfter: new Date(startedAt - 500).toISOString(),
      limit: Math.max(expectedCount + 20, 50),
      orderBy: ["-startTime"],
    }).catch(() => []);
    const reports = items.filter(isReportDownload);
    if (reports.length) {
      const now = Date.now();
      if (!firstActivityAt) firstActivityAt = now;
      reports.forEach((item) => candidateIds.add(item.id));
    }

    const candidates = reports.filter((item) => candidateIds.has(item.id));
    const completed = candidates.filter((item) => item.state === "complete");
    const interrupted = candidates.find((item) => item.state === "interrupted");
    if (interrupted) {
      finish({ items: completed, expectedCount, reason: `浏览器下载中断：${interrupted.error || "未知错误"}` });
      return;
    }
    if (completed.length >= expectedCount) {
      finish({ items: completed, expectedCount });
      return;
    }

    // The task center may return one combined archive instead of one ZIP per row.
    // Do not keep the browser on this page indefinitely after download activity stops.
    if (completed.length && lastActivityAt && Date.now() - lastActivityAt >= 15000) {
      finish({
        items: completed,
        expectedCount,
        reason: `已检测到 ${completed.length}/${expectedCount} 个 ZIP 下载事件`,
      });
    }
  };

  const onCreated = (item) => {
    if (!isReportDownload(item)) return;
    candidateIds.add(item.id);
    const now = Date.now();
    if (!firstActivityAt) firstActivityAt = now;
    lastActivityAt = now;
  };

  const onChanged = (delta) => {
    if (!candidateIds.has(delta.id)) return;
    lastActivityAt = Date.now();
  };

  const promise = new Promise((resolve) => {
    complete = resolve;
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    poller = setInterval(checkDownloads, 900);
    timer = setTimeout(() => {
      chrome.downloads.search({
        startedAfter: new Date(startedAt - 500).toISOString(),
        limit: Math.max(expectedCount + 20, 50),
        orderBy: ["-startTime"],
      }).then((items) => {
        finish({
          items: (items || []).filter((item) => isReportDownload(item) && item.state === "complete"),
          expectedCount,
          reason: `等待批量下载超过 ${Math.round(timeoutMs / 1000)} 秒`,
        });
      }).catch(() => finish({ items: [], expectedCount, reason: "读取浏览器下载记录失败" }));
    }, timeoutMs);
    checkDownloads();
  });

  return { promise, cancel: () => finish({ items: [], expectedCount, cancelled: true }) };
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isSycmProductPage(url) {
  const parsed = parseUrl(url);
  return Boolean(
    parsed &&
    parsed.hostname === "sycm.taobao.com" &&
    /^\/cc\/item_rank\/?$/.test(parsed.pathname)
  );
}

function sameSite(tabUrl, targetUrl) {
  const tab = parseUrl(tabUrl);
  const target = parseUrl(targetUrl);
  if (!tab || !target) return false;
  return tab.hostname === target.hostname || tab.hostname.endsWith(`.${target.hostname}`);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatLocalDate(date) === dateText ? date : null;
}

function expandDates(start, end) {
  const current = parseLocalDate(start);
  const last = parseLocalDate(end || start);
  if (!current || !last) throw new Error("日期格式不正确");
  if (current > last) throw new Error("开始日期不能晚于结束日期");

  const dates = [];
  while (current <= last) {
    dates.push(formatLocalDate(current));
    if (dates.length > 366) throw new Error("一次最多采集 366 天");
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function isFullCalendarMonth(start, end) {
  const first = parseLocalDate(start);
  const last = parseLocalDate(end || start);
  if (!first || !last || first.getDate() !== 1) return false;
  const finalDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return formatLocalDate(finalDay) === formatLocalDate(last);
}

function fillUrl(template, date) {
  return String(template || "").replaceAll("{date}", encodeURIComponent(date));
}

function localIsoDate(date = new Date()) {
  return formatLocalDate(date);
}

function yesterdayLocalDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatLocalDate(date);
}

function normalizeScheduleTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return "09:30";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "09:30";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeMorningScheduleTime(value) {
  const time = normalizeScheduleTime(value || "09:30");
  return time < "12:00" ? time : "09:30";
}

function normalizeAfternoonScheduleTime(value) {
  const time = normalizeScheduleTime(value || "14:30");
  return time > "14:00" ? time : "14:30";
}

async function appendCollectorLog(text) {
  const saved = await chrome.storage.local.get("collectorLogs");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const logs = [`${time} ${text}`, ...(saved.collectorLogs || [])].slice(0, 80);
  await chrome.storage.local.set({ collectorLogs: logs });
}

async function getCollectionSchedule() {
  const saved = await chrome.storage.local.get([
    SCHEDULE_ENABLED_KEY,
    SCHEDULE_TIME_KEY,
    AFTERNOON_SCHEDULE_TIME_KEY,
    SCHEDULE_PAID_KEY,
    SCHEDULE_STORE_REPORT_KEY,
    SCHEDULE_PRODUCT_REPORT_KEY,
    SCHEDULE_SCENE_REPORT_KEY,
    SCHEDULE_ITEM_REPORT_KEY,
    SCHEDULE_CONTENT_REPORT_KEY,
    SCHEDULE_TAOKE_REPORT_KEY,
  ]);
  const legacyIncludePaid = Boolean(saved[SCHEDULE_PAID_KEY]);
  return {
    enabled: saved[SCHEDULE_ENABLED_KEY] === true,
    time: normalizeMorningScheduleTime(saved[SCHEDULE_TIME_KEY]),
    afternoonTime: normalizeAfternoonScheduleTime(saved[AFTERNOON_SCHEDULE_TIME_KEY]),
    includeStoreReport: saved[SCHEDULE_STORE_REPORT_KEY] !== false,
    // Older versions always downloaded the product report. Preserve that setting
    // during upgrade, then let the visible checkbox control future runs.
    includeProductReport: saved[SCHEDULE_PRODUCT_REPORT_KEY] === undefined
      ? true
      : Boolean(saved[SCHEDULE_PRODUCT_REPORT_KEY]),
    includeSceneReport: saved[SCHEDULE_SCENE_REPORT_KEY] === undefined
      ? legacyIncludePaid
      : Boolean(saved[SCHEDULE_SCENE_REPORT_KEY]),
    includeItemReport: saved[SCHEDULE_ITEM_REPORT_KEY] === undefined
      ? legacyIncludePaid
      : Boolean(saved[SCHEDULE_ITEM_REPORT_KEY]),
    includeContentReport: Boolean(saved[SCHEDULE_CONTENT_REPORT_KEY]),
    // Newly added report is always opt-in; an upgrade must not start new exports.
    includeTaokeReport: Boolean(saved[SCHEDULE_TAOKE_REPORT_KEY]),
  };
}

function scheduledReportLabels(schedule) {
  const labels = [];
  if (schedule.includeStoreReport) labels.push("店铺经营核心日报");
  if (schedule.includeProductReport) labels.push("商品数据");
  if (schedule.includeSceneReport) labels.push("营销场景报表");
  if (schedule.includeItemReport) labels.push("商品推广报表");
  if (schedule.includeContentReport) labels.push("内容推广明细");
  if (schedule.includeTaokeReport) labels.push("淘宝联盟推广概览");
  return labels;
}

function hasMorningReports(schedule) {
  return schedule.includeStoreReport || schedule.includeProductReport;
}

function hasAfternoonReports(schedule) {
  return schedule.includeSceneReport || schedule.includeItemReport || schedule.includeContentReport || schedule.includeTaokeReport;
}

function scheduleForPhase(schedule, phase) {
  if (phase === "morning") {
    return {
      ...schedule,
      includeSceneReport: false,
      includeItemReport: false,
      includeContentReport: false,
      includeTaokeReport: false,
    };
  }
  if (phase === "afternoon") {
    return { ...schedule, includeStoreReport: false, includeProductReport: false };
  }
  return schedule;
}

function nextScheduleTime(time) {
  const [hour, minute] = normalizeScheduleTime(time).split(":").map(Number);
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now() + 10_000) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function isWithinScheduleCatchupWindow(time) {
  const [hour, minute] = normalizeScheduleTime(time).split(":").map(Number);
  const scheduledAt = new Date();
  scheduledAt.setHours(hour, minute, 0, 0);
  const elapsed = Date.now() - scheduledAt.getTime();
  return elapsed >= 0 && elapsed <= 12 * 60 * 60 * 1000;
}

async function configureCollectionSchedule(input = {}) {
  const current = await getCollectionSchedule();
  const hasLegacyPaidSetting = input.includePaid !== undefined;
  const schedule = {
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    time: normalizeMorningScheduleTime(input.time === undefined ? current.time : input.time),
    afternoonTime: normalizeAfternoonScheduleTime(input.afternoonTime === undefined ? current.afternoonTime : input.afternoonTime),
    includeStoreReport: input.includeStoreReport === undefined
      ? current.includeStoreReport
      : Boolean(input.includeStoreReport),
    includeProductReport: input.includeProductReport === undefined
      ? current.includeProductReport
      : Boolean(input.includeProductReport),
    includeSceneReport: input.includeSceneReport === undefined
      ? (hasLegacyPaidSetting ? Boolean(input.includePaid) : current.includeSceneReport)
      : Boolean(input.includeSceneReport),
    includeItemReport: input.includeItemReport === undefined
      ? (hasLegacyPaidSetting ? Boolean(input.includePaid) : current.includeItemReport)
      : Boolean(input.includeItemReport),
    includeContentReport: input.includeContentReport === undefined
      ? current.includeContentReport
      : Boolean(input.includeContentReport),
    includeTaokeReport: input.includeTaokeReport === undefined
      ? current.includeTaokeReport
      : Boolean(input.includeTaokeReport),
  };

  await chrome.storage.local.set({
    [SCHEDULE_ENABLED_KEY]: schedule.enabled,
    [SCHEDULE_TIME_KEY]: schedule.time,
    [AFTERNOON_SCHEDULE_TIME_KEY]: schedule.afternoonTime,
    // Keep the former key in sync so an extension update preserves the user's intent.
    [SCHEDULE_PAID_KEY]: schedule.includeSceneReport || schedule.includeItemReport || schedule.includeContentReport,
    [SCHEDULE_STORE_REPORT_KEY]: schedule.includeStoreReport,
    [SCHEDULE_PRODUCT_REPORT_KEY]: schedule.includeProductReport,
    [SCHEDULE_SCENE_REPORT_KEY]: schedule.includeSceneReport,
    [SCHEDULE_ITEM_REPORT_KEY]: schedule.includeItemReport,
    [SCHEDULE_CONTENT_REPORT_KEY]: schedule.includeContentReport,
    [SCHEDULE_TAOKE_REPORT_KEY]: schedule.includeTaokeReport,
  });
  await chrome.alarms.clear(SCHEDULE_ALARM);
  await chrome.alarms.clear(AFTERNOON_SCHEDULE_ALARM);
  if (schedule.enabled) {
    if (hasMorningReports(schedule)) {
      chrome.alarms.create(SCHEDULE_ALARM, {
        when: nextScheduleTime(schedule.time),
        periodInMinutes: 24 * 60,
      });
    }
    if (hasAfternoonReports(schedule)) {
      chrome.alarms.create(AFTERNOON_SCHEDULE_ALARM, {
        when: nextScheduleTime(schedule.afternoonTime),
        periodInMinutes: 24 * 60,
      });
    }
  }
  return schedule;
}

function buildSycmProductDateUrl(date) {
  const url = new URL("https://sycm.taobao.com/cc/item_rank");
  url.searchParams.set("dateRange", `${date}|${date}`);
  url.searchParams.set("dateType", date === localIsoDate() ? "today" : "day");
  return url.toString();
}

function buildAlimamaReportUrl(date) {
  return fillUrl(ALIMAMA_ACCOUNT_URL, date);
}

function buildAlimamaItemPromotionUrl(date) {
  return fillUrl(ALIMAMA_ITEM_PROMOTION_URL, date);
}

function buildAlimamaContentPromotionUrl(date) {
  return fillUrl(ALIMAMA_CONTENT_PROMOTION_URL, date);
}

function alimamaReportConfig(flow) {
  if (flow === "alimama_item_download") {
    return {
      flowLabel: "商品报表下载",
      reportName: "商品报表",
      reportSection: "商品数据明细",
      reportRoute: "!/report/item_promotion",
      reportUrl: buildAlimamaItemPromotionUrl,
    };
  }
  if (flow === "alimama_content_download") {
    return {
      flowLabel: "内容报表下载",
      reportName: "内容报表",
      reportSection: "内容数据明细",
      reportRoute: "!/report/other_promotion",
      reportUrl: buildAlimamaContentPromotionUrl,
    };
  }
  return {
    flowLabel: "营销场景报表下载",
    reportName: "营销场景报表",
    reportSection: "营销场景数据明细",
    reportRoute: "!/report/account",
    reportUrl: buildAlimamaReportUrl,
  };
}

function alimamaHashParams(url) {
  const parsed = parseUrl(url);
  if (!parsed) return new URLSearchParams();
  const hash = String(parsed.hash || "");
  const queryIndex = hash.indexOf("?");
  return new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : "");
}

function isCurrentAlimamaReportDate(url, date, route = "!/report/account") {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== "one.alimama.com") return false;
  const hash = String(parsed.hash || "");
  const params = alimamaHashParams(url);
  return hash.includes(route) &&
    params.get("startTime") === date &&
    params.get("endTime") === date;
}

function isCurrentSycmProductDate(url, date) {
  const parsed = parseUrl(url);
  return Boolean(
    parsed &&
    parsed.hostname === "sycm.taobao.com" &&
    /^\/cc\/item_rank\/?$/.test(parsed.pathname) &&
    parsed.searchParams.get("dateRange") === `${date}|${date}`
  );
}

function isSycmStoreDailyPage(url) {
  const parsed = parseUrl(url);
  return Boolean(
    parsed &&
    parsed.hostname === "sycm.taobao.com" &&
    /^\/adm\/v3\/micro\/auto_analysis\/datafetch\/create\/?$/.test(parsed.pathname)
  );
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function isPaused() {
  const saved = await chrome.storage.local.get(PAUSE_KEY);
  return Boolean(saved[PAUSE_KEY]);
}

async function setPageStatus(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (message) => {
        let panel = document.getElementById("__taobao_product_download_status__");
        if (!panel) {
          panel = document.createElement("div");
          panel.id = "__taobao_product_download_status__";
          panel.style.cssText = [
            "position:fixed",
            "z-index:2147483647",
            "right:22px",
            "top:86px",
            "max-width:360px",
            "padding:10px 12px",
            "border-radius:8px",
            "background:#0f7a68",
            "color:#fff",
            "font:14px/1.45 Microsoft YaHei,Arial,sans-serif",
            "box-shadow:0 8px 24px rgba(0,0,0,.2)",
            "pointer-events:none"
          ].join(";");
          document.documentElement.appendChild(panel);
        }
        panel.textContent = message;
      },
      args: [text],
    });
  } catch {
  }
}

async function setBadge(tabId, text, color) {
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function waitWhilePaused(tabId) {
  while (await isPaused()) {
    await setPageStatus(tabId, "已暂停：点击插件里的“继续”后再采集下一天");
    await sleep(1500);
  }
}

async function sleepBetweenDates(tabId, waitMs) {
  const endAt = Date.now() + waitMs;
  while (Date.now() < endAt) {
    await waitWhilePaused(tabId);
    await sleep(Math.min(1500, Math.max(0, endAt - Date.now())));
  }
}

async function findReusableTab(targetUrl) {
  const active = await activeTab();
  if (active?.id && sameSite(active.url, targetUrl)) return { tab: active, reused: true };
  const target = parseUrl(targetUrl);
  if (target) {
    const tabs = await chrome.tabs.query({ url: `${target.origin}/*` });
    if (tabs[0]?.id) return { tab: tabs[0], reused: true };
  }
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  return { tab, reused: false };
}

async function openOrReuseUrl(url) {
  const found = await findReusableTab(url);
  if (found.reused) {
    await chrome.tabs.update(found.tab.id, { url, active: true });
  }
  return { ok: true, tabId: found.tab.id, reused: found.reused };
}

async function openNewUrl(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  return { ok: true, tabId: tab.id, reused: false };
}

function inspectAlimamaDownloadTargetInPage() {
  const clean = (value, limit = 600) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const isVisible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      className: clean(element.className || "", 500),
      text: clean([element.innerText, element.textContent, element.value, element.getAttribute("title"), element.getAttribute("aria-label")].filter(Boolean).join(" ")),
      title: element.getAttribute("title") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      visible: isVisible(element),
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      outerHTML: clean(element.outerHTML, 2400),
    };
  };
  const chain = (element) => {
    const result = [];
    let current = element;
    for (let level = 0; current && level < 7; level += 1, current = current.parentElement) {
      const rect = current.getBoundingClientRect();
      result.push({
        level,
        tag: current.tagName.toLowerCase(),
        id: current.id || "",
        className: clean(current.className || "", 500),
        text: clean(current.innerText || "", 500),
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }
    return result;
  };
  const selector = "button,a,[role='button'],[role='menuitem'],[tabindex],[class*='button'],[class*='Button'],[class*='btn'],[class*='Btn']";
  const seen = new Set();
  const candidates = Array.from(document.querySelectorAll(selector))
    .filter((element) => {
      if (!isVisible(element) || seen.has(element)) return false;
      seen.add(element);
      const text = clean([element.innerText, element.textContent, element.getAttribute("title"), element.getAttribute("aria-label")].filter(Boolean).join(" "));
      return /下载|导出|报表/.test(text);
    })
    .map((element) => ({ ...describe(element), ancestors: chain(element) }))
    .slice(0, 120);
  const exactNodes = Array.from(document.querySelectorAll("*"))
    .filter(isVisible)
    .filter((element) => clean(element.innerText || element.textContent || "") === "下载报表")
    .slice(0, 30)
    .map((element) => ({ ...describe(element), ancestors: chain(element) }));
  const dateControls = Array.from(document.querySelectorAll("input,button,span,div,[role='button'],[class*='date'],[class*='Date'],[class*='picker'],[class*='Picker']"))
    .filter(isVisible)
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 520 || rect.height > 100) return false;
      const text = clean([element.innerText, element.textContent, element.value, element.getAttribute("placeholder"), element.getAttribute("title"), element.getAttribute("aria-label")].filter(Boolean).join(" "));
      const ancestors = chain(element);
      const ancestorText = ancestors.map((item) => item.text).join(" ");
      return /\d{4}-\d{1,2}-\d{1,2}|数据汇总周期|统计周期|昨日|今天|自定义/.test(`${text} ${ancestorText}`);
    })
    .map((element) => ({ ...describe(element), ancestors: chain(element) }))
    .slice(0, 120);
  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    pageTextAroundDownload: clean((document.body?.innerText || "").match(/.{0,100}下载.{0,500}/s)?.[0] || "", 800),
    exactDownloadReportNodes: exactNodes,
    dateControls,
    candidates,
  };
}

async function exportAlimamaDownloadInspection() {
  const tab = await activeTab();
  if (!tab?.id || !String(tab.url || "").includes("one.alimama.com")) {
    return { ok: false, reason: "请先切换到阿里妈妈的营销场景报表页面" };
  }
  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: inspectAlimamaDownloadTargetInPage,
  });
  const report = injected?.[0]?.result;
  if (!report) return { ok: false, reason: "没有读取到页面 DOM" };
  const content = JSON.stringify(report, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `淘宝店铺数据采集/diagnostics/alimama_download_target_${stamp}.json`;
  await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(content)}`,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  return {
    ok: true,
    filename,
    candidates: report.candidates.length,
    exactMatches: report.exactDownloadReportNodes.length,
    dateControls: report.dateControls.length,
  };
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(reason);
    }

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish("complete");
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") finish("complete");
    });
  });
}

async function switchCurrentProductPageDate(tabId, date) {
  const targetUrl = buildSycmProductDateUrl(date);
  await chrome.tabs.update(tabId, { url: targetUrl, active: true });
  const loadState = await waitForTabComplete(tabId, 60000);
  const tab = await chrome.tabs.get(tabId);
  if (loadState === "timeout" || !isCurrentSycmProductDate(tab.url, date)) {
    throw new Error(`商品排行页没有切换到 ${date}`);
  }
  await sleepRandom(1500, 2500);
  return tab;
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

async function trustedClick(tabId, point) {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error("没有拿到官方下载按钮坐标");
  }
  if (!chrome.debugger) throw new Error("Chrome 调试点击权限未生效，请重新加载插件");

  const target = { tabId };
  let attached = false;
  await focusTab(tabId);
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    });
    await sleepRandom(90, 180);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await sleepRandom(80, 150);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function fallbackClickAtPoint(tabId, point) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: (clickPoint) => {
      const element = document.elementFromPoint(clickPoint.x, clickPoint.y);
      const target = element?.closest("button,a,label,li,[role='button'],[role='option'],[role='menuitem'],.ant-picker-preset,.ant-select-item-option") || element;
      if (!target) return { ok: false, reason: "点击坐标没有对应的页面元素" };
      const options = { bubbles: true, cancelable: true, view: window, clientX: clickPoint.x, clientY: clickPoint.y };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, options));
      }
      return { ok: true };
    },
    args: [point],
  });
  return injected?.[0]?.result || { ok: false, reason: "普通点击没有返回结果" };
}

async function clickWithFallback(tabId, point) {
  try {
    await trustedClick(tabId, point);
    return { ok: true, method: "trusted" };
  } catch (error) {
    const fallback = await fallbackClickAtPoint(tabId, point).catch((fallbackError) => ({ ok: false, reason: fallbackError.message }));
    return fallback.ok
      ? { ok: true, method: "fallback", warning: error.message }
      : { ok: false, reason: `${error.message}；普通点击也失败：${fallback.reason || "未知错误"}` };
  }
}

// Kept in the service worker so an Alimama tab never relies on a stale content-script listener.
async function locateAlimamaDownloadButtonInPage(tabId, date, route = "!/report/account", sectionTitle = "营销场景数据明细") {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targetDate, targetRoute, targetSectionTitle) => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isDisabled = (element) => Boolean(element?.disabled) || element?.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/i.test(String(element?.className || ""));
      const current = (() => {
        const hash = String(location.hash || "");
        const queryIndex = hash.indexOf("?");
        const params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : "");
        return {
          reportPage: hash.includes(targetRoute),
          start: params.get("startTime") || "",
          end: params.get("endTime") || "",
        };
      })();
      if (!current.reportPage || current.start !== targetDate || current.end !== targetDate) {
        return { ok: false, reason: `阿里妈妈当前页面日期不是 ${targetDate}` };
      }

      const matchesTarget = (button) => {
        if (!isVisible(button) || isDisabled(button) || cleanText(button.innerText || button.textContent) !== "下载报表") return false;
        const card = button.closest(".mxgc-grid");
        return Boolean(card && cleanText(card.innerText || card.textContent).includes(targetSectionTitle));
      };
      const selectButton = () => {
        const exact = Array.from(document.querySelectorAll(
          "#universalBP_common_layout_main_content .mxgc-grid .ml20.fr.flex-column button[data-btn$='_btn']"
        )).find(matchesTarget);
        if (exact) return exact;
        return Array.from(document.querySelectorAll("#universalBP_common_layout_main_content .mxgc-grid button[data-btn], .mxgc-grid button"))
          .find(matchesTarget) || null;
      };

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const button = selectButton();
        if (button) {
          button.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          await new Promise((resolve) => setTimeout(resolve, 250));
          const clickTarget = button.closest("[mx-click*='download']") || button;
          const rect = clickTarget.getBoundingClientRect();
          return {
            ok: true,
            label: cleanText(button.innerText || button.textContent),
            clickPoint: {
              x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
              y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { ok: false, reason: `阿里妈妈页面加载 30 秒后仍未找到${targetSectionTitle}中的下载报表按钮` };
    },
    args: [date, route, sectionTitle],
  });
  return injected?.[0]?.result || { ok: false, reason: "页面按钮定位脚本没有返回结果" };
}

async function locateAlimamaDownloadConfirmationInPage(tabId, date) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targetDate) => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const normalizeDate = (value) => {
        const match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(value || ""));
        return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
      };
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const candidates = Array.from(document.querySelectorAll("button,[role='button']"))
          .filter(isVisible)
          .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true")
          .filter((element) => cleanText(element.innerText || element.textContent) === "确定")
          .map((button) => {
            let container = button.parentElement;
            for (let level = 0; container && level < 12; level += 1, container = container.parentElement) {
              const text = cleanText(container.innerText || container.textContent);
              if (text.includes("下载报表") && text.includes("日期范围") && text.includes("时间粒度")) {
                return { button, container, text };
              }
            }
            return null;
          })
          .filter(Boolean)
          .sort((a, b) => {
            const aRect = a.container.getBoundingClientRect();
            const bRect = b.container.getBoundingClientRect();
            return (Number(getComputedStyle(b.container).zIndex) || 0) - (Number(getComputedStyle(a.container).zIndex) || 0) || bRect.top - aRect.top;
          });
        if (candidates[0]) {
          const { button, text } = candidates[0];
          const modalDates = Array.from(String(text).matchAll(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g))
            .map((match) => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
          const pageText = cleanText(document.body?.innerText || "");
          const exactPageRange = [
            `数据范围为：${targetDate}至${targetDate}`,
            `数据范围:${targetDate}至${targetDate}`,
            `${targetDate}至${targetDate}`,
          ].some((range) => pageText.includes(range));
          const modalUsesYesterday = /昨日|昨天/.test(text);
          const dateConfirmed = modalDates.includes(targetDate)
            || (modalUsesYesterday && exactPageRange);
          if (!dateConfirmed) {
            return {
              ok: false,
              reason: `下载弹窗日期无法核验为 ${targetDate}（识别到：${modalDates.join("、") || "无日期"}）`,
            };
          }
          button.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          const rect = button.getBoundingClientRect();
          return {
            ok: true,
            clickPoint: {
              x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
              y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return { ok: false, reason: "点击下载报表后 8 秒内没有找到下载弹窗中的确定按钮" };
    },
    args: [date],
  });
  return injected?.[0]?.result || { ok: false, reason: "页面确认按钮定位脚本没有返回结果" };
}

async function waitForAlimamaTaskCreatedInPage(tabId, timeoutMs = 15000) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (timeout) => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const text = cleanText(document.body?.innerText || "");
        if (text.includes("离线数据生成成功")) return { ok: true };
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return { ok: false, reason: "点击确定后未出现离线数据生成成功提示" };
    },
    args: [timeoutMs],
  });
  return injected?.[0]?.result || { ok: false, reason: "任务生成结果核验脚本没有返回结果" };
}

async function locateAlimamaGeneratedTaskInPage(tabId, date, reportName = "营销场景报表") {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targetDate, targetReportName) => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, "").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const getPoint = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
          y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
        };
      };
      if (!String(location.hash || "").includes("!/report/download-list")) {
        return { ok: false, reason: "当前不是阿里妈妈下载任务管理页面" };
      }

      const expectedRange = `${targetDate}至${targetDate}`;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const candidates = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"))
          .filter(isVisible)
          .map((checkbox) => {
            const directRow = checkbox.closest("tr,[role='row']");
            if (directRow) {
              const text = cleanText(directRow.innerText || directRow.textContent);
              const rect = directRow.getBoundingClientRect();
              return rect.height >= 28 && rect.height <= 120
                && text.includes(targetReportName)
                && text.includes("生成成功")
                && text.includes(expectedRange)
                ? { checkbox, container: directRow, text }
                : null;
            }
            let container = checkbox.parentElement;
            for (let level = 0; container && level < 12; level += 1, container = container.parentElement) {
              const text = cleanText(container.innerText || container.textContent);
              const rect = container.getBoundingClientRect();
              // The task row itself is short. This rejects the table header whose text contains every task.
              if (rect.height >= 28 && rect.height <= 120 && text.includes(targetReportName) && text.includes("生成成功") && text.includes(expectedRange)) {
                return { checkbox, container, text };
              }
            }
            return null;
          })
          .filter(Boolean)
          .sort((a, b) => a.container.getBoundingClientRect().top - b.container.getBoundingClientRect().top);
        if (candidates[0]) {
          const { checkbox, container } = candidates[0];
          checkbox.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            ok: true,
            selected: Boolean(checkbox.checked || checkbox.getAttribute("aria-checked") === "true"),
            clickPoint: getPoint(checkbox),
            rowText: cleanText(container.innerText || container.textContent).slice(0, 180),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      return { ok: false, retryable: true, reason: `下载任务管理中尚未出现 ${targetDate} 的“生成成功”营销场景报表` };
    },
    args: [date, reportName],
  });
  return injected?.[0]?.result || { ok: false, reason: "下载任务定位脚本没有返回结果" };
}

async function locateAlimamaTaskListRefreshButtonInPage(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],[mx-click],span,div"))
        .filter(isVisible)
        .filter((element) => cleanText(element.innerText || element.textContent || element.getAttribute("title")) === "刷新表格")
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 150 && rect.top <= 340 && rect.width >= 40 && rect.width <= 180 && rect.height >= 20 && rect.height <= 72;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const button = candidates[0];
      if (!button) return { ok: false, reason: "下载任务管理页面未找到刷新表格按钮" };
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        clickPoint: {
          x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
          y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
        },
      };
    },
  });
  return injected?.[0]?.result || { ok: false, reason: "刷新表格按钮定位脚本没有返回结果" };
}

async function locateAlimamaTaskListNextPageButtonInPage(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isDisabled = (element) => Boolean(element?.disabled)
        || element?.getAttribute("aria-disabled") === "true"
        || /disabled|is-disabled/i.test(String(element?.className || ""));
      const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],[title],[aria-label]"))
        .filter(isVisible)
        .map((element) => {
          const text = cleanText([
            element.innerText,
            element.textContent,
            element.getAttribute("title"),
            element.getAttribute("aria-label"),
          ].filter(Boolean).join(" "));
          const classes = String(element.className || "");
          return { element, text, classes };
        })
        .filter((item) => /下一页|next\s*page|pagination.*next/i.test(item.text)
          || /pagination.*next|next-page|page-next/i.test(item.classes)
          || ([">", "›", "»"].includes(item.text) && item.element.getBoundingClientRect().top > innerHeight * 0.6))
        .sort((a, b) => b.element.getBoundingClientRect().top - a.element.getBoundingClientRect().top
          || b.element.getBoundingClientRect().left - a.element.getBoundingClientRect().left);
      const candidate = candidates[0];
      if (!candidate) return { ok: false, reason: "下载任务管理页面未找到下一页按钮" };
      const host = candidate.element.closest("button,a,[role='button']") || candidate.element;
      if (isDisabled(candidate.element) || isDisabled(host)) return { ok: false, exhausted: true, reason: "下载任务管理已是最后一页" };
      host.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const rect = host.getBoundingClientRect();
      return {
        ok: true,
        clickPoint: {
          x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
          y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
        },
      };
    },
  });
  return injected?.[0]?.result || { ok: false, reason: "下一页按钮定位脚本没有返回结果" };
}

async function locateAlimamaTaskDownloadButtonInPage(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isDisabled = (element) => Boolean(element?.disabled) || element?.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/i.test(String(element?.className || ""));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const seen = new Set();
        const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],[mx-click],span,div"))
          .filter((element) => {
            if (seen.has(element)) return false;
            seen.add(element);
            return isVisible(element);
          })
          .filter((element) => cleanText(element.innerText || element.textContent || element.getAttribute("title")) === "下载")
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            // The task action toolbar is directly below the table header. On a maximized
            // window it is often around 120px from the top, so do not exclude it here.
            return rect.top >= 80 && rect.width >= 28 && rect.width <= 180 && rect.height >= 20 && rect.height <= 72;
          })
          .map((element) => {
            const host = element.closest("button,a,[role='button'],[mx-click]") || element;
            return { element, disabled: isDisabled(element) || isDisabled(host) };
          })
          .sort((a, b) => a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top || a.element.getBoundingClientRect().left - b.element.getBoundingClientRect().left);
        const candidate = candidates[0];
        if (candidate?.disabled) return { ok: false, retryable: true, reason: "下载任务已出现，但下载按钮尚未生效" };
        const button = candidate?.element;
        if (button) {
          button.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          await new Promise((resolve) => setTimeout(resolve, 200));
          const rect = button.getBoundingClientRect();
          return {
            ok: true,
            clickPoint: {
              x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
              y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return { ok: false, retryable: true, reason: "下载任务管理页面中未找到可用的下载按钮" };
    },
  });
  return injected?.[0]?.result || { ok: false, reason: "任务下载按钮定位脚本没有返回结果" };
}

async function inspectAlimamaTaskPageForBatch(tabId, dates, reportName) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetDates, targetReportName) => {
      const targetSet = new Set(targetDates);
      const cleanText = (value) => String(value || "").replace(/\s+/g, "").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isSelected = (checkbox) => Boolean(checkbox.checked || checkbox.getAttribute("aria-checked") === "true");
      const point = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
          y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
        };
      };
      const dateFor = (text) => {
        const match = /(\d{4}-\d{2}-\d{2})(?:至|到|~|-)(\d{4}-\d{2}-\d{2})/.exec(text);
        return match && match[1] === match[2] ? match[1] : "";
      };

      const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']")).filter(isVisible);
      const taskCheckboxes = new Set();
      const taskRows = [];
      for (const checkbox of checkboxes) {
        const directRow = checkbox.closest("tr,[role='row']");
        let container = directRow || checkbox.parentElement;
        const maxLevels = directRow ? 1 : 12;
        for (let level = 0; container && level < maxLevels; level += 1, container = container.parentElement) {
          const rect = container.getBoundingClientRect();
          const text = cleanText(container.innerText || container.textContent);
          const date = dateFor(text);
          if (rect.height >= 28 && rect.height <= 120 && date && text.includes("生成成功")) {
            taskCheckboxes.add(checkbox);
            taskRows.push({
              date,
              text: text.slice(0, 260),
              selected: isSelected(checkbox),
              clickPoint: point(checkbox),
              isTarget: text.includes(targetReportName) && targetSet.has(date),
            });
            break;
          }
        }
      }

      const targetRows = taskRows.filter((row) => row.isTarget);
      const otherRows = taskRows.filter((row) => !row.isTarget);
      const firstTaskTop = Math.min(...taskRows.map((row) => row.clickPoint.y), Infinity);
      const header = checkboxes
        .filter((checkbox) => !taskCheckboxes.has(checkbox))
        .filter((checkbox) => {
          const rect = checkbox.getBoundingClientRect();
          return rect.left < 100 && rect.top < firstTaskTop - 12;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
          || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      const headerSelected = Boolean(header && isSelected(header));
      const allTargetsSelected = targetRows.length > 0 && targetRows.every((row) => row.selected);

      return {
        targetRows,
        otherRows,
        canUseHeader: Boolean(header) && targetRows.length > 0 && otherRows.length === 0,
        headerSelected,
        headerClickPoint: header ? point(header) : null,
        allTargetsSelected,
        pageSignature: taskRows.map((row) => `${row.date}:${row.text}`).join("|").slice(0, 2400),
      };
    },
    args: [dates, reportName],
  });
  return injected?.[0]?.result || {
    targetRows: [],
    otherRows: [],
    canUseHeader: false,
    headerSelected: false,
    headerClickPoint: null,
    allTargetsSelected: false,
    pageSignature: "",
  };
}

async function applyAlimamaBatchSelection(tabId, selection, dates, reportName) {
  if (!selection?.targetRows?.length) return { ok: false, reason: "当前页没有指定日期的已生成任务" };

  if (selection.canUseHeader) {
    if (!selection.allTargetsSelected) {
      const click = await clickWithFallback(tabId, selection.headerClickPoint);
      if (!click.ok) return click;
      await sleepRandom(500, 900);
    }
  } else {
    for (const row of selection.otherRows.filter((row) => row.selected)) {
      const click = await clickWithFallback(tabId, row.clickPoint);
      if (!click.ok) return click;
      await sleepRandom(220, 420);
    }
    for (const row of selection.targetRows.filter((row) => !row.selected)) {
      const click = await clickWithFallback(tabId, row.clickPoint);
      if (!click.ok) return click;
      await sleepRandom(220, 420);
    }
  }

  const verified = await inspectAlimamaTaskPageForBatch(tabId, dates, reportName);
  if (verified.otherRows.some((row) => row.selected)) {
    return { ok: false, reason: "下载任务页仍选中了范围外的报表，已停止批量下载" };
  }
  if (!verified.allTargetsSelected) {
    return { ok: false, reason: "未能选中当前页全部指定日期的报表任务" };
  }
  return { ok: true, selection: verified };
}

async function clearAlimamaTaskPageSelection(tabId, dates, reportName) {
  const selection = await inspectAlimamaTaskPageForBatch(tabId, dates, reportName);
  if (selection.canUseHeader && selection.headerSelected) {
    await clickWithFallback(tabId, selection.headerClickPoint);
    await sleepRandom(300, 600);
    return;
  }

  for (const row of [...selection.targetRows, ...selection.otherRows].filter((row) => row.selected)) {
    await clickWithFallback(tabId, row.clickPoint);
    await sleepRandom(180, 320);
  }
}

async function downloadAlimamaTaskPageBatch(tabId, selection, reportName, flow, flowLabel, monthLabel) {
  const expectedCount = selection.targetRows.length;
  const table = FLOW_TABLE[flow] || "paid_export";
  const startedAt = Date.now();
  const watcher = watchForCompletedBatchReportDownloads(startedAt, expectedCount);
  activeDownloadContext = {
    flow,
    table,
    batchLabel: monthLabel,
    expiresAt: Date.now() + 240000,
  };

  try {
    const taskDownload = await locateAlimamaTaskDownloadButtonInPage(tabId);
    if (!taskDownload?.ok) return { ok: false, reason: taskDownload?.reason || "未找到批量下载按钮" };
    await setPageStatus(tabId, `${flowLabel}：本页已选 ${expectedCount} 个任务，点击一次下载`);
    const click = await clickWithFallback(tabId, taskDownload.clickPoint);
    if (!click.ok) return click;

    const watched = await watcher.promise;
    if (watched.items.length < expectedCount) {
      return {
        ok: false,
        downloadedCount: watched.items.length,
        expectedCount,
        reason: watched.reason || `批量下载只检测到 ${watched.items.length}/${expectedCount} 个 ZIP 文件`,
      };
    }

    const datesByRow = [...new Set(selection.targetRows.map((row) => row.date))];
    const matches = datesByRow.map((date) => ({
      date,
      items: watched.items.filter((item) => matchesExpectedReportDownload(item, { date, table, reportName })),
    }));
    if (matches.some(({ items }) => items.length !== 1) || new Set(matches.map(({ items }) => items[0].id)).size !== datesByRow.length) {
      return { ok: false, downloadedCount: watched.items.length, expectedCount, reason: "批量 ZIP 无法逐份核对业务日期；请按单日任务下载" };
    }
    for (const { date, items } of matches) {
      await rememberVerifiedReportDownload({ date, table, reportName }, items[0], { batch: true });
    }
    await setBadge(tabId, "完成", "#16a34a");
    return {
      ok: true,
      downloadedCount: watched.items.length,
      expectedCount,
      dates: datesByRow,
      filenames: watched.items.map((item) => item.filename),
    };
  } finally {
    watcher.cancel();
    activeDownloadContext = null;
  }
}

async function downloadAlimamaMonthlyTasksInBatches(tabId, dates, reportName, flowLabel, flow) {
  const remainingDates = new Set(dates);
  const processedDates = new Set();
  const batches = [];
  const seenPages = new Set();

  for (let page = 1; page <= 20 && remainingDates.size; page += 1) {
    await waitWhilePaused(tabId);
    const activeDates = [...remainingDates].sort();
    const selection = await inspectAlimamaTaskPageForBatch(tabId, activeDates, reportName);
    if (selection.pageSignature && seenPages.has(selection.pageSignature)) {
      return { ok: false, batches, reason: "下载任务列表没有切换到下一页" };
    }
    if (selection.pageSignature) seenPages.add(selection.pageSignature);

    if (selection.targetRows.length) {
      const applied = await applyAlimamaBatchSelection(tabId, selection, activeDates, reportName);
      if (!applied.ok) return { ok: false, batches, reason: applied.reason };

      const selected = applied.selection;
      await setBadge(tabId, "下载", "#2563eb");
      const batch = await downloadAlimamaTaskPageBatch(tabId, selected, reportName, flow, flowLabel, dates[0].slice(0, 7));
      await clearAlimamaTaskPageSelection(tabId, activeDates, reportName).catch(() => {});
      if (!batch.ok) return { ok: false, batches, ...batch };

      batch.dates.forEach((date) => {
        processedDates.add(date);
        remainingDates.delete(date);
      });
      batches.push(batch);
    }

    if (!remainingDates.size) break;
    const nextPage = await locateAlimamaTaskListNextPageButtonInPage(tabId);
    if (!nextPage?.ok) {
      return {
        ok: false,
        batches,
        missingDates: [...remainingDates].sort(),
        reason: nextPage?.reason || "下载任务管理页面没有下一页",
      };
    }
    await setPageStatus(tabId, `${flowLabel}：本页批量下载完成，切换到下一页继续`);
    const pageClick = await clickWithFallback(tabId, nextPage.clickPoint);
    if (!pageClick.ok) return { ok: false, batches, reason: pageClick.reason };
    await sleepRandom(1500, 2600);
  }

  if (remainingDates.size) {
    return { ok: false, batches, missingDates: [...remainingDates].sort(), reason: "没有在下载任务列表中找到全部指定日期" };
  }
  return { ok: true, batches, dates: [...processedDates].sort() };
}

function findProductDownloadConfirmationInPage() {
  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const textOf = (element) => cleanText([element.innerText, element.textContent, element.getAttribute("title"), element.getAttribute("aria-label")].filter(Boolean).join(" "));
  const modalSelector = ["[role='dialog']", ".ant-modal", ".next-dialog", ".next-overlay-wrapper", ".oui-dialog", ".el-dialog", ".semi-modal", "[class*='modal']", "[class*='dialog']", "[class*='popover']"].join(",");
  const modal = Array.from(document.querySelectorAll(modalSelector))
    .filter(isVisible)
    .filter((element) => /下载|报表|导出|文件/.test(textOf(element)))
    .sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0];
  if (!modal) return { ok: true, clickPoint: null };

  const candidate = Array.from(modal.querySelectorAll("button,a,[role='button'],span,div"))
    .filter(isVisible)
    .map((element) => {
      const text = textOf(element);
      const rect = element.getBoundingClientRect();
      const cls = String(element.className || "");
      let score = 0;
      if (!text || /取消|关闭|返回/.test(text) || element.disabled || /disabled|is-disabled/.test(cls)) return { element, score: -Infinity };
      if (text === "确定" || text === "确认") score += 100;
      else if (text === "下载" || text === "导出") score += 80;
      else if (/生成报表|提交/.test(text)) score += 50;
      if (/primary|main/.test(cls)) score += 30;
      if (rect.top > modal.getBoundingClientRect().top + modal.getBoundingClientRect().height * 0.5) score += 15;
      return { element, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.element;
  if (!candidate) return { ok: true, clickPoint: null };
  const rect = candidate.getBoundingClientRect();
  return {
    ok: true,
    clickPoint: {
      x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1)),
      y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)),
    },
  };
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "TAOBAO_COLLECTOR_PING" });
    if (response?.version === "official-download-v6") return;
  } catch {
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function navigateAndRun(tabId, flow, url, date) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabComplete(tabId);
  await sleep(4500);
  await ensureContentScript(tabId);
  activeDownloadContext = {
    flow,
    table: FLOW_TABLE[flow] || "unknown",
    date,
    expiresAt: Date.now() + 30000,
  };
  const result = await chrome.tabs.sendMessage(tabId, {
    type: "TAOBAO_COLLECTOR_RUN_FLOW",
    flow,
    date,
  });
  await sleep(6500);
  return result || { ok: true };
}

async function productDownloadOnceInPage(date) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function humanWait(min, max) {
    await sleep(randomInt(min, max));
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function status(text) {
    let panel = document.getElementById("__taobao_product_download_status__");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "__taobao_product_download_status__";
      panel.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "right:22px",
        "top:86px",
        "max-width:360px",
        "padding:10px 12px",
        "border-radius:8px",
        "background:#0f7a68",
        "color:#fff",
        "font:14px/1.45 Microsoft YaHei,Arial,sans-serif",
        "box-shadow:0 8px 24px rgba(0,0,0,.2)",
        "pointer-events:none"
      ].join(";");
      document.documentElement.appendChild(panel);
    }
    panel.textContent = text;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function visibleElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }

  function elementText(element) {
    return cleanText([
      element.innerText,
      element.textContent,
      element.value,
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("data-title")
    ].filter(Boolean).join(" "));
  }

  async function humanClick(element) {
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    await humanWait(700, 1600);
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.max(2, Math.min(rect.width - 2, rect.width / 2));
    const y = rect.top + Math.max(2, Math.min(rect.height - 2, rect.height / 2));
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    for (const type of ["pointerover", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, options));
      await sleep(type === "click" ? 0 : randomInt(90, 230));
    }
  }

  function smallestMatchingElement(match, selector = "button,a,span,div,label") {
    return visibleElements(selector)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, text: elementText(element), area: rect.width * rect.height, top: rect.top };
      })
      .filter((item) => item.text && item.area > 0 && item.area < 90000 && match(item.text, item.element))
      .sort((a, b) => a.area - b.area || a.top - b.top)[0]?.element || null;
  }

  function dateRoots() {
    const selector = [
      ".oui-date-picker-menu-ebase-v2",
      ".oui-date-picker-period-panel",
      ".ant-picker-dropdown",
      ".next-overlay-wrapper",
      ".next-date-picker-panel",
      "[class*='calendar']",
      "[class*='date-picker']"
    ].join(",");
    const roots = visibleElements(selector)
      .filter((root) => /一\s*二\s*三\s*四\s*五\s*六\s*日|日\s*一\s*二\s*三\s*四\s*五\s*六|\d{4}年/.test(cleanText(root.innerText || "")));
    return roots.length ? roots : [];
  }

  function yearOf(value) {
    return Number(String(value).slice(0, 4));
  }

  function monthOf(value) {
    return Number(String(value).slice(5, 7));
  }

  function dayOf(value) {
    return String(Number(String(value).slice(8, 10)));
  }

  function toIsoDate(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function parseCurrentToolbarDate() {
    const text = cleanText(document.body?.innerText || "");
    const matches = [...text.matchAll(/统计时间\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      return toIsoDate(Number(last[1]), Number(last[2]), Number(last[3]));
    }
    const anyDate = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (anyDate) {
      return toIsoDate(Number(anyDate[1]), Number(anyDate[2]), Number(anyDate[3]));
    }
    return "";
  }

  function dayDistance(fromDate, toDate) {
    const from = new Date(`${fromDate}T00:00:00`);
    const to = new Date(`${toDate}T00:00:00`);
    return Math.round((to - from) / 86400000);
  }

  async function openDatePanel() {
    status(`正在打开自定义日期控件`);
    if (dateRoots().length) return true;

    const dayMode = smallestMatchingElement((text) => text === "日", "button,a,span,div");
    if (dayMode) {
      await humanClick(dayMode);
      await humanWait(1800, 3600);
      if (dateRoots().length) return true;
    }

    const customDate = smallestMatchingElement((text) => text === "自定义", "button,a,span,div");
    if (customDate) {
      status(`正在打开自定义日期控件`);
      await humanClick(customDate);
      await humanWait(1800, 3600);
      if (dateRoots().length) return true;
    }

    const dateText = smallestMatchingElement(
      (text) => text.includes("统计时间") || /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text),
      "button,a,span,div,label"
    );
    if (dateText) {
      await humanClick(dateText);
      await humanWait(1800, 3600);
      if (dateRoots().length) return true;
    }

    return Boolean(dateRoots().length);
  }

  function calendarHasTargetMonth(targetDate) {
    const year = `${yearOf(targetDate)}年`;
    const month = `${monthOf(targetDate)}月`;
    return dateRoots().some((root) => {
      const text = cleanText(root.innerText || "");
      return text.includes(year) && text.includes(month);
    });
  }

  async function clickCalendarArrow(direction) {
    const selectors = direction === "prev"
      ? [".oui-dt-calendar-prev-month-btn", ".ant-picker-header-prev-btn", "[class*='prev']", "[aria-label*='Previous']"]
      : [".oui-dt-calendar-next-month-btn", ".ant-picker-header-next-btn", "[class*='next']", "[aria-label*='Next']"];
    for (const selector of selectors) {
      const element = visibleElements(selector)[0];
      if (element) {
        await humanClick(element);
        await humanWait(2500, 5200);
        return true;
      }
    }
    return false;
  }

  async function moveToMonth(targetDate) {
    if (calendarHasTargetMonth(targetDate)) return true;
    const target = yearOf(targetDate) * 12 + monthOf(targetDate);
    for (let index = 0; index < 18; index += 1) {
      const text = dateRoots().map((root) => cleanText(root.innerText || "")).join(" ");
      const match = text.match(/(\d{4})年\s*(\d{1,2})月/);
      if (!match) break;
      const current = Number(match[1]) * 12 + Number(match[2]);
      if (current === target) return true;
      const moved = await clickCalendarArrow(current < target ? "next" : "prev");
      if (!moved) break;
      if (calendarHasTargetMonth(targetDate)) return true;
    }
    return calendarHasTargetMonth(targetDate);
  }

  function findDayCell(targetDate) {
    const day = dayOf(targetDate);
    for (const root of dateRoots()) {
      const cells = Array.from(root.querySelectorAll("td,button,span,div,[role='gridcell']"))
        .filter(isVisible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element,
            text: cleanText(element.innerText || element.textContent || ""),
            cls: String(element.className || ""),
            area: rect.width * rect.height
          };
        })
        .filter((item) => item.text === day)
        .filter((item) => !/disabled|unavailable|prev|next|other|outside/i.test(item.cls))
        .filter((item) => item.area > 0 && item.area < 5000)
        .sort((a, b) => a.area - b.area);
      if (cells[0]) return cells[0].element;
    }
    return null;
  }

  function findDateConfirmButton() {
    for (const root of dateRoots()) {
      const candidates = Array.from(root.querySelectorAll("button,a,[role='button'],span,div"))
        .filter(isVisible)
        .map((element) => {
          const text = elementText(element);
          const rect = element.getBoundingClientRect();
          return { element, text, area: rect.width * rect.height };
        })
        .filter((item) => ["确定", "确认", "应用"].includes(item.text))
        .filter((item) => item.area > 500 && item.area < 22000)
        .sort((a, b) => a.area - b.area);
      if (candidates[0]?.element) return candidates[0].element;
    }
    return null;
  }

  function findDownloadButton() {
    const candidates = visibleElements("button,a,[role='button'],span,div")
      .map((element) => {
        const text = elementText(element);
        const rect = element.getBoundingClientRect();
        const cls = String(element.className || "");
        const disabled = element.disabled || element.getAttribute("disabled") !== null || element.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/.test(cls);
        let score = 0;
        if (!text || disabled || ["下载管理", "下载任务", "最近下载"].some((value) => text.includes(value))) {
          return { element, text, score: -Infinity, area: rect.width * rect.height };
        }
        if (text === "下载") score += 100;
        else if (text === "下载报表") score += 80;
        else if (text.includes("下载") || text.includes("导出")) score += 50;
        if (/download|export/i.test(cls)) score += 20;
        if (rect.top >= 80 && rect.top <= 320 && rect.left > window.innerWidth * 0.55) score += 40;
        if (/primary|main/.test(cls) || /24, 144, 255|36, 107, 254|47, 106, 255/.test(getComputedStyle(element).backgroundColor)) score += 25;
        return { element, text, score, area: rect.width * rect.height };
      })
      .filter((item) => item.score > 0 && item.area >= 500 && item.area < 22000)
      .sort((a, b) => b.score - a.score || a.area - b.area);
    return candidates[0]?.element || null;
  }

  async function waitForDownloadButton(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const button = findDownloadButton();
      if (button) return button;
      status(`商品数据下载：等待官方下载按钮 ${date}`);
      await humanWait(700, 1200);
    }
    return null;
  }

  function getClickPoint(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1)),
      y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)),
    };
  }

  function findDownloadConfirmButton() {
    const modalSelector = [
      "[role='dialog']",
      ".ant-modal",
      ".next-dialog",
      ".next-overlay-wrapper",
      ".oui-dialog",
      ".el-dialog",
      ".semi-modal",
      "[class*='modal']",
      "[class*='dialog']",
      "[class*='popover']",
    ].join(",");
    const modal = visibleElements(modalSelector)
      .filter((element) => /下载|报表|导出|文件/.test(elementText(element)))
      .sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0];
    if (!modal) return null;

    return Array.from(modal.querySelectorAll("button,a,[role='button'],span,div"))
      .filter(isVisible)
      .map((element) => {
        const text = elementText(element);
        const rect = element.getBoundingClientRect();
        const cls = String(element.className || "");
        let score = 0;
        if (!text || /取消|关闭|返回/.test(text) || element.disabled || /disabled|is-disabled/.test(cls)) return { element, score: -Infinity };
        if (text === "确定" || text === "确认") score += 100;
        else if (text === "下载" || text === "导出") score += 80;
        else if (/生成报表|提交/.test(text)) score += 50;
        if (/primary|main/.test(cls)) score += 30;
        if (rect.top > modal.getBoundingClientRect().top + modal.getBoundingClientRect().height * 0.5) score += 15;
        return { element, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  if (!location.hostname.includes("sycm.taobao.com")) {
    return { ok: false, reason: "当前页不是生意参谋页面" };
  }

  const currentUrl = new URL(location.href);
  const currentRange = currentUrl.searchParams.get("dateRange");
  if (currentRange !== `${date}|${date}`) {
    return { ok: false, reason: `页面日期参数是 ${currentRange || "空"}，未切换到 ${date}` };
  }

  status(`商品数据下载：页面已切换到 ${date}`);
  status(`商品数据下载：等待下载按钮 ${date}`);
  const download = await waitForDownloadButton();
  if (!download) {
    status(`未找到下载按钮`);
    return { ok: false, reason: "页面加载 30 秒后仍未找到商品页官方下载按钮" };
  }
  download.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  await humanWait(500, 1200);
  status(`商品数据下载：已定位官方下载按钮 ${date}`);
  return { ok: true, summary: `已切换到 ${date} 并定位官方下载按钮`, clickPoint: getClickPoint(download) };
}

async function runFlow(message) {
  if (message.flow === "taoke_overview_download") {
    return runExclusiveAlimamaFlow("推广报表下载", () => runTaokeOverviewDownload(message));
  }
  if (message.flow === "sycm_product_download") {
    return runCurrentProductPageFlow(message);
  }
  if (message.flow === "sycm_store_download") {
    const date = message.range?.start;
    if (!date) return { ok: false, reason: "缺少店铺日报的统计日期" };
    return runScheduledStoreDownload(date);
  }
  if (["alimama_paid_download", "alimama_scene_download", "alimama_item_download", "alimama_content_download"].includes(message.flow)) {
    return runAlimamaOfficialDownloadFlow(message);
  }

  const start = message.range?.start;
  const end = message.range?.end || start;
  if (!start) return { ok: false, reason: "缺少采集开始日期" };

  const dates = expandDates(start, end);
  const firstUrl = fillUrl(message.urlTemplate, dates[0]);
  const found = await findReusableTab(firstUrl);
  const tabId = found.tab.id;
  const results = [];

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    await waitWhilePaused(tabId);
    const url = fillUrl(message.urlTemplate, date);
    const result = await navigateAndRun(tabId, message.flow, url, date);
    results.push({ date, url, ...result });
    if (index < dates.length - 1) {
      const waitMs = randomInt(45000, 120000);
      await setPageStatus(tabId, `已完成 ${date}，随机等待 ${Math.round(waitMs / 1000)} 秒后继续`);
      await sleepBetweenDates(tabId, waitMs);
      await waitWhilePaused(tabId);
    }
  }

  const success = results.filter((item) => item.ok).length;
  return {
    ok: success > 0,
    reused: found.reused,
    success,
    failed: results.length - success,
    results,
  };
}

async function runCurrentProductPageFlow(message) {
  if (productRunActive) {
    return { ok: false, reason: "商品数据下载正在运行，请勿重复点击开始下载。" };
  }

  const start = message.range?.start;
  const end = message.range?.end || start;
  if (!start) return { ok: false, reason: "缺少采集开始日期" };

  const tab = message.tabId
    ? await chrome.tabs.get(message.tabId).catch(() => null)
    : await activeTab();
  if (!tab?.id || !isSycmProductPage(tab.url)) {
    if (tab?.id && String(tab.url || "").includes("sycm.taobao.com")) {
      await setPageStatus(tab.id, "当前是生意参谋首页，请点击插件里的“打开商品数据”进入商品排行页后再下载");
    }
    return { ok: false, reason: "当前不是商品数据的商品排行页。请先点击插件里的“打开商品数据”，进入商品排行页后再点击开始下载。" };
  }

  productRunActive = true;
  try {
    await ensureContentScript(tab.id);
    const dates = expandDates(start, end);
    const results = [];
    for (let index = 0; index < dates.length; index += 1) {
      const date = dates[index];
      await waitWhilePaused(tab.id);
      await setBadge(tab.id, "下载", "#2563eb");
      let currentTab;
      try {
        await setPageStatus(tab.id, `商品数据下载：切换当前页面到 ${date}`);
        currentTab = await switchCurrentProductPageDate(tab.id, date);
      } catch (error) {
        const result = { ok: false, reason: error.message };
        results.push({ date, url: tab.url, ...result });
        return {
          ok: false,
          currentPage: true,
          success: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
          results,
          reason: result.reason,
        };
      }

      activeDownloadContext = {
        flow: message.flow,
        table: FLOW_TABLE[message.flow] || "product_daily",
        date,
        expiresAt: Date.now() + DOWNLOAD_WAIT_MS + 90000,
      };

      const startedAt = Date.now();
      const downloadWatcher = watchForCompletedReportDownload(startedAt);
      let result;
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: productDownloadOnceInPage,
          args: [date],
        });
        result = injected?.[0]?.result || { ok: false, reason: "页面脚本没有返回结果" };

        if (result.ok) {
          await setPageStatus(tab.id, `商品数据下载：触发官方下载 ${date}`);
          const firstClick = await clickWithFallback(tab.id, result.clickPoint);
          if (!firstClick.ok) {
            result = { ...result, ok: false, reason: firstClick.reason };
          } else {
            await sleepRandom(1200, 2800);
            const confirmationInjected = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: findProductDownloadConfirmationInPage,
            });
            const confirmation = confirmationInjected?.[0]?.result;
            if (confirmation?.clickPoint) {
              await setPageStatus(tab.id, `商品数据下载：确认下载 ${date}`);
              const confirmClick = await clickWithFallback(tab.id, confirmation.clickPoint);
              if (!confirmClick.ok) result = { ...result, ok: false, reason: confirmClick.reason };
            }
          }
        }

        if (result.ok) {
          await setPageStatus(tab.id, `商品数据下载：等待浏览器完成 ${date} 的表格文件`);
          let startedDownload = await waitForReportDownloadStarted(startedAt);
          if (!startedDownload) {
            await appendCollectorLog(`商品数据：${date} 首次点击未创建下载任务，正在使用页面点击重试`);
            await setPageStatus(tab.id, `商品数据下载：首次点击未生效，正在重试 ${date}`);
            const retryClick = await fallbackClickAtPoint(tab.id, result.clickPoint).catch((error) => ({ ok: false, reason: error.message }));
            if (!retryClick.ok) {
              result = { ...result, ok: false, reason: `首次点击未产生下载任务；页面点击重试失败：${retryClick.reason}` };
            } else {
              await sleepRandom(900, 1500);
              const retryConfirmationInjected = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: findProductDownloadConfirmationInPage,
              });
              const retryConfirmation = retryConfirmationInjected?.[0]?.result;
              if (retryConfirmation?.clickPoint) {
                await fallbackClickAtPoint(tab.id, retryConfirmation.clickPoint).catch(() => ({ ok: false }));
              }
              startedDownload = await waitForReportDownloadStarted(startedAt, 8000);
              if (!startedDownload) {
                result = { ...result, ok: false, reason: `${date} 两次点击后浏览器仍未创建商品表格下载任务` };
              }
            }
          }
        }

        if (result.ok) {
          const downloadResult = await downloadWatcher.promise;
          const downloadItem = downloadResult.item;
          if (downloadItem) {
            result = {
              ...result,
              downloadId: downloadItem.id,
              filename: downloadItem.filename,
              summary: `${result.summary || `已触发 ${date}`}，表格已下载完成`,
            };
            await setPageStatus(tab.id, `商品数据下载：${date} 的表格已下载完成`);
            await setBadge(tab.id, "完成", "#16a34a");
          } else {
            result = {
              ...result,
              ok: false,
              reason: `${date} 已点击下载，但 ${downloadResult.reason || "没有检测到 XLS/CSV/XLSX 文件"}`,
            };
            await setPageStatus(tab.id, `商品数据下载失败：${date} 未完成表格下载`);
            await setBadge(tab.id, "!", "#dc2626");
          }
        }
      } finally {
        downloadWatcher.cancel();
      }

      results.push({ date, url: currentTab.url, ...(result || { ok: false, reason: "下载结果为空" }) });
      if (!result?.ok) {
        await setBadge(tab.id, "!", "#dc2626");
        return {
          ok: false,
          currentPage: true,
          success: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
          results,
          reason: result?.reason || `${date} 下载未完成`,
        };
      }

      if (index < dates.length - 1) {
        const waitMs = 3000;
        await setPageStatus(tab.id, `已完成 ${date}，静待 3 秒后继续下一天`);
        await sleepBetweenDates(tab.id, waitMs);
        await waitWhilePaused(tab.id);
      }
    }

    return {
      ok: true,
      currentPage: true,
      success: results.length,
      failed: 0,
      results,
    };
  } finally {
    productRunActive = false;
    activeDownloadContext = null;
  }
}

async function navigateToAlimamaReport(tabId, date, targetUrl = buildAlimamaReportUrl(date), route = "!/report/account") {
  await chrome.tabs.update(tabId, { url: targetUrl, active: true });
  const loadState = await waitForTabComplete(tabId, 60000);
  const tab = await chrome.tabs.get(tabId);
  if (loadState === "timeout" || !isCurrentAlimamaReportDate(tab.url, date, route)) {
    throw new Error(`阿里妈妈页面没有切换到 ${date}`);
  }
  await sleepRandom(3000, 5000);
  return tab;
}

async function navigateToAlimamaDownloadList(tabId) {
  await chrome.tabs.update(tabId, { url: ALIMAMA_DOWNLOAD_LIST_URL, active: true });
  const loadState = await waitForTabComplete(tabId, 60000);
  const tab = await chrome.tabs.get(tabId);
  if (loadState === "timeout" || !String(tab.url || "").includes("!/report/download-list")) {
    throw new Error("阿里妈妈没有打开下载任务管理页面");
  }
  // The task table is populated after the route completes; wait before reading its first render.
  await sleep(2500);
  return tab;
}

async function findOtherSelectedAlimamaTasksInPage(tabId, date, reportName = "营销场景报表") {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetDate, targetReportName) => {
      const cleanText = (value) => String(value || "").replace(/\s+/g, "").trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const point = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
          y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
        };
      };
      const expectedRange = `${targetDate}至${targetDate}`;
      return Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"))
        .filter(isVisible)
        .filter((checkbox) => Boolean(checkbox.checked || checkbox.getAttribute("aria-checked") === "true"))
        .map((checkbox) => {
          const directRow = checkbox.closest("tr,[role='row']");
          let container = directRow || checkbox.parentElement;
          const maxLevels = directRow ? 1 : 12;
          for (let level = 0; container && level < maxLevels; level += 1, container = container.parentElement) {
            const text = cleanText(container.innerText || container.textContent);
            const rect = container.getBoundingClientRect();
            if (rect.height >= 28 && rect.height <= 120 && text.includes("生成成功")) {
              const isRequestedTask = text.includes(targetReportName) && text.includes(expectedRange);
              return isRequestedTask ? null : point(checkbox);
            }
          }
          return null;
        })
        .filter(Boolean);
    },
    args: [date, reportName],
  });
  return injected?.[0]?.result || [];
}

async function downloadGeneratedAlimamaTask(tabId, date, reportName = "营销场景报表", flowLabel = "营销场景报表下载") {
  const deadline = Date.now() + 90000;
  let lastReason = "";
  while (Date.now() < deadline) {
    const task = await locateAlimamaGeneratedTaskInPage(tabId, date, reportName);
    if (task?.ok) {
      const selectedOthers = await findOtherSelectedAlimamaTasksInPage(tabId, date, reportName);
      for (const point of selectedOthers) {
        const clearClick = await clickWithFallback(tabId, point);
        if (!clearClick.ok) return { ok: false, reason: clearClick.reason };
        await sleepRandom(300, 600);
      }
      if (!task.selected) {
        await setPageStatus(tabId, `${flowLabel}：选择 ${date} 的已生成报表任务`);
        const selectTask = await clickWithFallback(tabId, task.clickPoint);
        if (!selectTask.ok) return { ok: false, reason: selectTask.reason };
        await sleepRandom(700, 1200);
      }

      const taskDownload = await locateAlimamaTaskDownloadButtonInPage(tabId);
      if (taskDownload?.ok) {
        await setPageStatus(tabId, `${flowLabel}：点击下载任务管理中的下载 ${date}`);
        const downloadClick = await clickWithFallback(tabId, taskDownload.clickPoint);
        return downloadClick.ok ? { ok: true } : { ok: false, reason: downloadClick.reason };
      }
      lastReason = taskDownload?.reason || "下载按钮尚未生效";
    } else {
      lastReason = task?.reason || "下载任务尚未显示";
    }

    const nextPage = await locateAlimamaTaskListNextPageButtonInPage(tabId);
    if (!task?.ok && nextPage?.ok) {
      const pageClick = await clickWithFallback(tabId, nextPage.clickPoint);
      if (!pageClick.ok) return { ok: false, reason: pageClick.reason };
      await sleepRandom(1200, 2200);
      continue;
    }

    const refresh = await locateAlimamaTaskListRefreshButtonInPage(tabId);
    if (!refresh?.ok) return { ok: false, reason: refresh?.reason || lastReason };
    await setPageStatus(tabId, `${flowLabel}：${lastReason}，刷新表格后重试`);
    const refreshClick = await clickWithFallback(tabId, refresh.clickPoint);
    if (!refreshClick.ok) return { ok: false, reason: refreshClick.reason };
    await sleep(2500);
  }
  return { ok: false, reason: `等待 ${date} 的下载任务与可用下载按钮超时：${lastReason || "任务未生成"}` };
}

async function runAlimamaOfficialDownloadFlowSequential(message) {
  const start = message.range?.start;
  const end = message.range?.end || start;
  if (!start) return { ok: false, reason: "缺少采集开始日期" };

  const { flowLabel, reportName, reportSection, reportRoute, reportUrl } = alimamaReportConfig(message.flow);
  const dates = expandDates(start, end);
  const firstUrl = reportUrl(dates[0]);
  const found = await findReusableTab(firstUrl);
  const tabId = found.tab.id;
  const results = [];

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    await waitWhilePaused(tabId);
    await setBadge(tabId, "下载", "#2563eb");
    let currentTab;
    let result;
    try {
      await setPageStatus(tabId, `${flowLabel}：切换阿里妈妈页面到 ${date}`);
      currentTab = await navigateToAlimamaReport(tabId, date, reportUrl(date), reportRoute);
      activeDownloadContext = {
        flow: message.flow,
        table: FLOW_TABLE[message.flow] || "paid_export",
        date,
        expiresAt: Date.now() + 210000,
      };
      const startedAt = Date.now();
      const downloadWatcher = watchForCompletedReportDownload(startedAt, 150000);
      try {
        await setPageStatus(tabId, `${flowLabel}：定位官方报表下载按钮 ${date}`);
        const located = await locateAlimamaDownloadButtonInPage(tabId, date, reportRoute, reportSection);
        if (!located?.ok) {
          result = { ok: false, reason: located?.reason || "未找到阿里妈妈官方下载按钮" };
        } else if (!result) {
          await setPageStatus(tabId, `${flowLabel}：已定位${reportSection}中的下载报表按钮 ${date}`);
          const primaryClick = await clickWithFallback(tabId, located.clickPoint);
          if (!primaryClick.ok) {
            result = { ok: false, reason: primaryClick.reason };
          } else {
            await sleepRandom(1200, 2400);
            await setPageStatus(tabId, `${flowLabel}：等待 ${date} 的下载确认弹窗`);
            const confirmation = await locateAlimamaDownloadConfirmationInPage(tabId, date)
              .catch((error) => ({ ok: false, reason: error.message }));
            if (!confirmation?.ok) {
              result = { ok: false, reason: confirmation?.reason || "未找到下载确认弹窗" };
              await setPageStatus(tabId, `${flowLabel}失败：${result.reason}`);
            } else if (confirmation.clickPoint) {
              await setPageStatus(tabId, `${flowLabel}：确认下载 ${date}`);
              const confirmClick = await clickWithFallback(tabId, confirmation.clickPoint);
              if (!confirmClick.ok) result = { ok: false, reason: confirmClick.reason };
            }
            if (!result) {
              await sleepRandom(1500, 2600);
              await setPageStatus(tabId, `${flowLabel}：打开下载任务管理，等待页面刷新后查找 ${date} 的报表`);
              const taskTab = await navigateToAlimamaDownloadList(tabId);
              currentTab = taskTab;
              const taskDownload = await downloadGeneratedAlimamaTask(tabId, date, reportName, flowLabel);
              if (!taskDownload?.ok) {
                result = { ok: false, reason: taskDownload?.reason || "未找到已生成的阿里妈妈下载任务" };
                await setPageStatus(tabId, `${flowLabel}失败：${result.reason}`);
              } else {
                result = { ok: true, summary: `已提交并下载 ${date} 的阿里妈妈官方报表` };
              }
            }
          }
        }

        if (result.ok) {
          await setPageStatus(tabId, `${flowLabel}：等待 ${date} 的表格文件完成`);
          const downloadResult = await downloadWatcher.promise;
          if (downloadResult.item) {
            result = {
              ...result,
              downloadId: downloadResult.item.id,
              filename: downloadResult.item.filename,
              summary: `${result.summary}，表格已下载完成`,
            };
            await setPageStatus(tabId, `${flowLabel}：${date} 的官方表格已下载完成`);
            await setBadge(tabId, "完成", "#16a34a");
          } else {
            result = {
              ...result,
              ok: false,
              reason: `${date} 已点击下载，但 ${downloadResult.reason || "没有检测到 XLS/CSV/XLSX 文件"}`,
            };
            await setPageStatus(tabId, `${flowLabel}失败：${date} 未完成表格下载`);
            await setBadge(tabId, "!", "#dc2626");
          }
        }
      } finally {
        downloadWatcher.cancel();
      }
    } catch (error) {
      result = { ok: false, reason: error.message };
      await setBadge(tabId, "!", "#dc2626");
    }

    results.push({ date, url: currentTab?.url || reportUrl(date), ...(result || { ok: false, reason: "下载结果为空" }) });
    if (!result?.ok) {
      activeDownloadContext = null;
      return {
        ok: false,
        reused: found.reused,
        success: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
        results,
        reason: result?.reason || `${date} 下载未完成`,
      };
    }

    if (index < dates.length - 1) {
      const waitMs = randomInt(8000, 15000);
      await setPageStatus(tabId, `已完成 ${date}，静待 ${Math.round(waitMs / 1000)} 秒后继续下一天`);
      await sleepBetweenDates(tabId, waitMs);
    }
  }

  activeDownloadContext = null;
  return { ok: true, reused: found.reused, success: results.length, failed: 0, results };
}

async function queueAlimamaReportTask(tabId, date, reportUrl, reportRoute, reportSection, flowLabel) {
  const currentTab = await navigateToAlimamaReport(tabId, date, reportUrl(date), reportRoute);
  await setPageStatus(tabId, `${flowLabel}：生成 ${date} 的下载任务`);
  let lastReason = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const located = await locateAlimamaDownloadButtonInPage(tabId, date, reportRoute, reportSection);
    if (!located?.ok) {
      return { ok: false, url: currentTab.url, reason: located?.reason || "未找到阿里妈妈官方下载按钮" };
    }

    const primaryClick = await clickWithFallback(tabId, located.clickPoint);
    if (!primaryClick.ok) return { ok: false, url: currentTab.url, reason: primaryClick.reason };

    await sleepRandom(1200, 2400);
    const confirmation = await locateAlimamaDownloadConfirmationInPage(tabId, date)
      .catch((error) => ({ ok: false, reason: error.message }));
    if (!confirmation?.ok) {
      lastReason = confirmation?.reason || "未找到下载确认弹窗";
      if (attempt < 2) {
        await setPageStatus(tabId, `${flowLabel}：首次未打开确认弹窗，重新点击 ${date} 的下载报表`);
        await sleepRandom(700, 1200);
        continue;
      }
      return { ok: false, url: currentTab.url, reason: lastReason };
    }

    for (let confirmAttempt = 1; confirmAttempt <= 2; confirmAttempt += 1) {
      const confirmClick = await clickWithFallback(tabId, confirmation.clickPoint);
      if (!confirmClick.ok) return { ok: false, url: currentTab.url, reason: confirmClick.reason };
      const created = await waitForAlimamaTaskCreatedInPage(tabId);
      if (created?.ok) {
        return { ok: true, url: currentTab.url, summary: `${date} 已加入下载任务管理` };
      }
      lastReason = created?.reason || "下载任务没有生成成功";
      if (confirmAttempt < 2) {
        const retryConfirmation = await locateAlimamaDownloadConfirmationInPage(tabId, date)
          .catch((error) => ({ ok: false, reason: error.message }));
        if (!retryConfirmation?.ok) break;
        confirmation.clickPoint = retryConfirmation.clickPoint;
      }
    }
    if (attempt < 2) {
      await setPageStatus(tabId, `${flowLabel}：${date} 的任务未确认生成，重新提交一次`);
      await sleepRandom(700, 1200);
    }
  }
  return { ok: false, url: currentTab.url, reason: lastReason || `${date} 的下载任务未生成成功` };
}

async function downloadQueuedAlimamaReportSingleAttempt(tabId, date, reportName, flowLabel, flow) {
  const expected = { date, table: FLOW_TABLE[flow] || "paid_export", reportName };
  activeDownloadContext = {
    flow,
    table: expected.table,
    date,
    expiresAt: Date.now() + 210000,
  };
  const startedAt = Date.now();
  const downloadWatcher = watchForCompletedReportDownload(startedAt, 150000, expected, { allowTaskScoped: true });
  try {
    const taskDownload = await downloadGeneratedAlimamaTask(tabId, date, reportName, flowLabel);
    if (!taskDownload?.ok) {
      return { ok: false, reason: taskDownload?.reason || "未找到已生成的下载任务" };
    }

    await setPageStatus(tabId, `${flowLabel}：等待浏览器完成 ${date} 的 ZIP 文件下载`);
    const downloadResult = await downloadWatcher.promise;
    if (!downloadResult.item) {
      return {
        ok: false,
        reason: `${date} 已点击下载，但 ${downloadResult.reason || "未检测到对应日期的 ZIP 文件"}`,
      };
    }

    await setPageStatus(tabId, `${flowLabel}：已核验下载文件 ${downloadResult.item.filename}`);
    await setBadge(tabId, "完成", "#16a34a");
    return {
      ok: true,
      downloadId: downloadResult.item.id,
      filename: downloadResult.item.filename,
      summary: `${date} 的浏览器 ZIP 文件已下载完成${downloadResult.taskScoped ? "（按已选下载任务识别文件名）" : ""}`,
    };
  } finally {
    downloadWatcher.cancel();
    activeDownloadContext = null;
  }
}

async function downloadQueuedAlimamaReport(tabId, date, reportName, flowLabel, flow) {
  const expected = { date, table: FLOW_TABLE[flow] || "paid_export", reportName };
  activeDownloadContext = {
    flow,
    table: expected.table,
    date,
    expiresAt: Date.now() + 210000,
  };
  let lastReason = "";
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const startedAt = Date.now();
      const downloadWatcher = watchForCompletedReportDownload(startedAt, 35000, expected, { allowTaskScoped: true });
      try {
        const taskDownload = await downloadGeneratedAlimamaTask(tabId, date, reportName, flowLabel);
        if (!taskDownload?.ok) {
          return { ok: false, reason: taskDownload?.reason || "未找到已生成的下载任务" };
        }

        await setPageStatus(tabId, `${flowLabel}：第 ${attempt} 次等待浏览器完成 ${date} 的 ZIP 文件下载`);
        const downloadResult = await downloadWatcher.promise;
        if (downloadResult.item) {
          await rememberVerifiedReportDownload(expected, downloadResult.item, { taskScoped: downloadResult.taskScoped });
          await setPageStatus(tabId, `${flowLabel}：已核验下载文件 ${downloadResult.item.filename}`);
          await setBadge(tabId, "完成", "#16a34a");
          return {
            ok: true,
            downloadId: downloadResult.item.id,
            filename: downloadResult.item.filename,
            summary: `${date} 的浏览器 ZIP 文件已下载完成${downloadResult.taskScoped ? "（按已选下载任务识别文件名）" : ""}`,
          };
        }
        lastReason = downloadResult.reason || "未检测到对应日期的 ZIP 文件";
      } finally {
        downloadWatcher.cancel();
      }

      if (attempt < 3) {
        await setPageStatus(tabId, `${flowLabel}：${date} 未产生下载事件，刷新任务后重试第 ${attempt + 1} 次`);
        const refresh = await locateAlimamaTaskListRefreshButtonInPage(tabId);
        if (refresh?.ok) {
          const refreshClick = await clickWithFallback(tabId, refresh.clickPoint);
          if (!refreshClick.ok) return { ok: false, reason: refreshClick.reason };
        }
        await sleepRandom(1800, 3200);
      }
    }
    return { ok: false, reason: `${date} 已重试 3 次，${lastReason}` };
  } finally {
    activeDownloadContext = null;
  }
}

async function runAlimamaOfficialDownloadFlowInternal(message) {
  const start = message.range?.start;
  const end = message.range?.end || start;
  if (!start) return { ok: false, reason: "缺少采集开始日期" };

  const { flowLabel, reportName, reportSection, reportRoute, reportUrl } = alimamaReportConfig(message.flow);
  const table = FLOW_TABLE[message.flow] || "paid_export";
  const dates = expandDates(start, end);
  const found = await findReusableTab(reportUrl(dates[0]));
  const tabId = found.tab.id;
  const results = [];
  const pendingDates = [];

  // Phase 1: add every missing day to Alimama's download task list first.
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const expected = { date, table, reportName };
    await waitWhilePaused(tabId);
    if (message.force) {
      await forgetVerifiedReportDownload(expected);
    } else if (await hasCompletedExpectedReportDownload(expected)) {
      results.push({ date, ok: true, skipped: true, downloaded: true, summary: `${date} 已有已核验的本地下载文件` });
      continue;
    }

    await setBadge(tabId, "排队", "#2563eb");
    let queued;
    try {
      queued = await queueAlimamaReportTask(tabId, date, reportUrl, reportRoute, reportSection, flowLabel);
    } catch (error) {
      queued = { ok: false, reason: error.message };
    }
    results.push({ date, queued: Boolean(queued?.ok), url: queued?.url || reportUrl(date), ...(queued || {}) });
    if (!queued?.ok) {
      activeDownloadContext = null;
      await setBadge(tabId, "!", "#dc2626");
      return {
        ok: false,
        reused: found.reused,
        success: results.filter((item) => item.downloaded).length,
        failed: 1,
        results,
        reason: queued?.reason || `${date} 下载任务创建失败`,
      };
    }
    pendingDates.push(date);

    if (index < dates.length - 1) {
      const waitMs = randomInt(4000, 7000);
      await setPageStatus(tabId, `${flowLabel}：${date} 已加入任务，静待 ${Math.round(waitMs / 1000)} 秒后继续创建下一天`);
      await sleepBetweenDates(tabId, waitMs);
    }
  }

  if (!pendingDates.length) {
    activeDownloadContext = null;
    return { ok: true, reused: found.reused, success: results.length, failed: 0, results };
  }

  // Phase 2: visit the task page once, then download and verify each queued ZIP.
  await setPageStatus(tabId, `${flowLabel}：已创建 ${pendingDates.length} 个任务，进入下载任务管理`);
  try {
    await navigateToAlimamaDownloadList(tabId);
  } catch (error) {
    activeDownloadContext = null;
    await setBadge(tabId, "!", "#dc2626");
    return {
      ok: false,
      reused: found.reused,
      success: results.filter((item) => item.downloaded).length,
      failed: pendingDates.length,
      results,
      reason: error.message,
    };
  }

  const downloadDates = [...pendingDates].sort().reverse();
  for (let index = 0; index < downloadDates.length; index += 1) {
    const date = downloadDates[index];
    await waitWhilePaused(tabId);
    await setBadge(tabId, "下载", "#2563eb");
    const result = await downloadQueuedAlimamaReport(tabId, date, reportName, flowLabel, message.flow)
      .catch((error) => ({ ok: false, reason: error.message }));
    const row = results.find((item) => item.date === date);
    Object.assign(row, result, { downloaded: Boolean(result?.ok) });
    if (!result?.ok) {
      await setBadge(tabId, "!", "#dc2626");
      return {
        ok: false,
        reused: found.reused,
        success: results.filter((item) => item.downloaded).length,
        failed: results.filter((item) => !item.downloaded).length,
        results,
        reason: result?.reason || `${date} 下载未完成`,
      };
    }

    if (index < downloadDates.length - 1) {
      const waitMs = randomInt(6000, 10000);
      await setPageStatus(tabId, `${flowLabel}：${date} 已下载并核验，静待 ${Math.round(waitMs / 1000)} 秒后下载下一天`);
      await sleepBetweenDates(tabId, waitMs);
    }
  }

  activeDownloadContext = null;
  return { ok: true, reused: found.reused, success: results.length, failed: 0, results };
}

async function resumeQueuedAlimamaDownloadsInternal(message) {
  const start = message.range?.start;
  const end = message.range?.end || start;
  if (!start) return { ok: false, reason: "缺少采集开始日期" };

  const { flowLabel, reportName } = alimamaReportConfig(message.flow);
  const table = FLOW_TABLE[message.flow] || "paid_export";
  const requestedDates = Array.isArray(message.dates) && message.dates.length
    ? message.dates.filter((date) => parseLocalDate(String(date))).map(String)
    : expandDates(start, end);
  const downloadDates = [...new Set(requestedDates)].sort().reverse();
  if (!downloadDates.length) return { ok: false, reason: "没有可继续下载的报表日期" };
  const found = await findReusableTab(ALIMAMA_DOWNLOAD_LIST_URL);
  const tabId = found.tab.id;
  const results = [];

  try {
    await navigateToAlimamaDownloadList(tabId);
  } catch (error) {
    return { ok: false, reused: found.reused, success: 0, failed: downloadDates.length, results, reason: error.message };
  }

  for (let index = 0; index < downloadDates.length; index += 1) {
    const date = downloadDates[index];
    const expected = { date, table, reportName };
    await waitWhilePaused(tabId);
    if (await hasCompletedExpectedReportDownload(expected)) {
      results.push({ date, ok: true, skipped: true, downloaded: true, summary: `${date} 已有已核验的本地下载文件` });
      continue;
    }

    await setBadge(tabId, "下载", "#2563eb");
    const result = await downloadQueuedAlimamaReport(tabId, date, reportName, flowLabel, message.flow)
      .catch((error) => ({ ok: false, reason: error.message }));
    results.push({ date, downloaded: Boolean(result?.ok), ...(result || {}) });
    if (!result?.ok) {
      await setBadge(tabId, "!", "#dc2626");
      return {
        ok: false,
        reused: found.reused,
        success: results.filter((item) => item.downloaded).length,
        failed: results.filter((item) => !item.downloaded).length,
        results,
        reason: result?.reason || `${date} 下载未完成`,
      };
    }

    if (index < downloadDates.length - 1) {
      const waitMs = randomInt(6000, 10000);
      await setPageStatus(tabId, `${flowLabel}：${date} 已下载并核验，静待 ${Math.round(waitMs / 1000)} 秒后下载下一天`);
      await sleepBetweenDates(tabId, waitMs);
    }
  }

  activeDownloadContext = null;
  return { ok: true, reused: found.reused, success: results.length, failed: 0, results };
}

async function runExclusiveAlimamaFlow(label, action) {
  if (alimamaRunActive) {
    return { ok: false, reason: `${label}仍在等待上一任务结束，请勿重复点击；暂停不会取消已提交的报表。请查看运行日志及浏览器下载记录` };
  }
  alimamaRunActive = true;
  try {
    return await action();
  } finally {
    activeDownloadContext = null;
    alimamaRunActive = false;
  }
}

async function runAlimamaOfficialDownloadFlow(message) {
  return runExclusiveAlimamaFlow("阿里妈妈报表下载", () => runAlimamaOfficialDownloadFlowInternal(message));
}

async function resumeQueuedAlimamaDownloads(message) {
  return runExclusiveAlimamaFlow("阿里妈妈下载任务", () => resumeQueuedAlimamaDownloadsInternal(message));
}

async function runScheduledProductDownload(date) {
  const targetUrl = buildSycmProductDateUrl(date);
  const found = await findReusableTab(targetUrl);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (found.reused || attempt > 1) {
      await chrome.tabs.update(found.tab.id, { url: targetUrl, active: true });
    }
    await waitForTabComplete(found.tab.id, 60000);
    const current = await chrome.tabs.get(found.tab.id).catch(() => null);
    if (isSycmProductPage(current?.url)) break;
    if (attempt === 1) {
      await appendCollectorLog(`商品数据：${date} 首次深链跳回首页，正在重试商品排行页`);
    }
  }
  return runCurrentProductPageFlow({
    flow: "sycm_product_download",
    range: { start: date, end: date },
    tabId: found.tab.id,
  });
}

async function runProductDownloadRange(range = {}) {
  const start = range.start;
  const end = range.end || start;
  if (!start) return { ok: false, reason: "缺少商品数据开始日期" };
  const dates = expandDates(start, end);
  const results = [];
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    await appendCollectorLog(`商品数据：正在自动打开并下载 ${date}`);
    const result = await runScheduledProductDownload(date).catch((error) => ({ ok: false, reason: error.message }));
    results.push({ date, ...(result || {}) });
    if (!result?.ok) {
      return {
        ok: false,
        success: results.filter((item) => item.ok).length,
        failed: 1,
        results,
        reason: result?.reason || `${date} 商品数据下载失败`,
      };
    }
    if (index < dates.length - 1) await sleepRandom(3500, 6000);
  }
  return { ok: true, success: results.length, failed: 0, results };
}

function findStoreDailyDownloadPointInPage() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const point = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1)),
      y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)),
    };
  };
  const roots = Array.from(document.querySelectorAll("div,li,section,article"))
    .filter(visible)
    .filter((element) => clean(element.innerText).includes("店铺经营核心日报"))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { element, area: rect.width * rect.height, text: clean(element.innerText) };
    })
    .filter((item) => item.area > 8_000 && item.area < window.innerWidth * window.innerHeight * 0.45)
    .sort((left, right) => left.area - right.area);

  for (const root of roots) {
    const download = Array.from(root.element.querySelectorAll("a,button,[role='button'],span,div"))
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, text: clean(element.innerText || element.textContent), area: rect.width * rect.height };
      })
      .filter((item) => item.text === "下载" && item.area > 80 && item.area < 12_000)
      .sort((left, right) => left.area - right.area)[0];
    if (download) return { ok: true, clickPoint: point(download.element), label: "店铺经营核心日报" };
  }
  return { ok: false, reason: "页面尚未加载店铺经营核心日报下载按钮" };
}

async function waitForStoreDailyDownloadPoint(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitWhilePaused(tabId);
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: findStoreDailyDownloadPointInPage,
    }).catch(() => []);
    const point = result?.[0]?.result;
    if (point?.ok) return point;
    await setPageStatus(tabId, "店铺日报下载：等待店铺经营核心日报模板加载");
    await sleepRandom(900, 1400);
  }
  return { ok: false, reason: "30 秒内未定位到店铺经营核心日报的下载按钮" };
}

async function runScheduledStoreDownload(date, force = false) {
  const expected = { table: "store_daily", date };
  if (!force && await hasCompletedExpectedReportDownload(expected)) {
    return { ok: true, skipped: true, summary: `${date} 的店铺经营核心日报已下载并核验` };
  }
  if (force) await forgetVerifiedReportDownload(expected);

  const found = await findReusableTab(SYCM_STORE_DAILY_URL);
  if (found.reused) {
    await chrome.tabs.update(found.tab.id, { url: SYCM_STORE_DAILY_URL, active: true });
  }
  await waitForTabComplete(found.tab.id, 60000);
  await sleepRandom(1800, 3000);
  const target = await waitForStoreDailyDownloadPoint(found.tab.id);
  if (!target.ok) return { ok: false, reused: found.reused, reason: target.reason };

  await forgetVerifiedReportDownload(expected);
  activeDownloadContext = {
    table: "store_daily",
    date,
    expiresAt: Date.now() + DOWNLOAD_WAIT_MS + 30_000,
  };
  const startedAt = Date.now();
  const watcher = watchForCompletedReportDownload(startedAt, DOWNLOAD_WAIT_MS, expected);
  try {
    await setBadge(found.tab.id, "下载", "#2563eb");
    await setPageStatus(found.tab.id, `店铺日报下载：已定位店铺经营核心日报，开始下载 ${date}`);
    await trustedClick(found.tab.id, target.clickPoint);
    const watched = await watcher.promise;
    if (!watched?.item) {
      await setBadge(found.tab.id, "!", "#dc2626");
      return { ok: false, reused: found.reused, reason: watched?.reason || "没有检测到店铺日报下载完成" };
    }
    await rememberVerifiedReportDownload(expected, watched.item);
    await setBadge(found.tab.id, "完成", "#16a34a");
    await setPageStatus(found.tab.id, `店铺日报下载完成：${date}`);
    return { ok: true, reused: found.reused, filename: watched.item.filename, summary: `${date} 店铺经营核心日报已下载` };
  } finally {
    activeDownloadContext = null;
  }
}

function inspectJushengsuanControlInPage(action, label = "") {
  const clean = (value) => String(value || "").replace(/\s+/g, "").trim();
  const visible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const resultFor = (element, extra = {}) => {
    if (!element) return { ok: false, ...extra };
    const rect = element.getBoundingClientRect();
    return {
      ok: true,
      point: {
        x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1)),
        y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)),
      },
      text: clean(element.innerText || element.textContent),
      ...extra,
    };
  };
  const smallest = (elements) => [...elements]
    .filter(visible)
    .sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return a.width * a.height - b.width * b.height;
    })[0];
  const exact = (root, selector, text) => smallest([...root.querySelectorAll(selector)]
    .filter((element) => clean(element.innerText || element.textContent) === clean(text)));
  const formItem = (text) => {
    const formLabel = [...document.querySelectorAll(".ant-form-item label")]
      .find((element) => clean(element.innerText || element.textContent) === clean(text));
    return formLabel?.closest(".ant-form-item") || null;
  };
  const modal = [...document.querySelectorAll(".ant-modal")].filter(visible).at(-1) || null;

  if (action === "page") {
    const body = document.body?.innerText || "";
    return {
      ok: /时间范围/.test(body) && /订单时间类型/.test(body) && /店铺/.test(body),
      href: location.href,
      loginRequired: /登录|重新登录/.test(body) && !/时间范围/.test(body),
    };
  }
  if (action === "date-picker") return resultFor(document.querySelector(".ss-common-ss-picker-range"));
  if (action === "click-date-picker") {
    const target = document.querySelector(".ss-common-ss-picker-range");
    if (!target) return { ok: false };
    target.click();
    return { ok: true };
  }
  if (action === "date-preset") {
    const root = [...document.querySelectorAll(".ant-picker-dropdown")].find(visible) || document;
    return resultFor(exact(root, "span,li", label));
  }
  if (action === "click-date-cell") {
    const root = [...document.querySelectorAll(".ant-picker-dropdown")].find(visible) || document;
    const target = [...root.querySelectorAll("td[title], td[aria-label]")]
      .find((element) => element.getAttribute("title") === label || element.getAttribute("aria-label") === label);
    if (!target || !visible(target)) return { ok: false };
    target.click();
    return { ok: true };
  }
  if (action === "date-value") {
    const match = (document.body?.innerText || "").match(/时间范围：\s*(\d{4}-\d{2}-\d{2})(?:\s*~\s*(\d{4}-\d{2}-\d{2}))?/);
    const value = match ? (match[2] ? `${match[1]}~${match[2]}` : match[1]) : "";
    return { ok: value === label, value };
  }
  if (action === "form-select") {
    const item = formItem(label);
    const select = item?.querySelector(".ant-select");
    const target = select?.querySelector(".ant-select-selector");
    const selected = select?.querySelector(".ant-select-selection-item")?.getAttribute("title")
      || select?.querySelector(".ant-select-selection-item")?.textContent
      || "";
    return resultFor(target, { selected: clean(selected) });
  }
  if (action === "select-option") {
    const target = exact(document, ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .title, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content", label);
    return resultFor(target);
  }
  if (action === "select-clear") {
    const item = formItem(label);
    return resultFor(item?.querySelector(".ant-select-clear"));
  }
  if (action === "shop-input") {
    const input = document.querySelector("#shop");
    return resultFor(input, { value: String(input?.value || "").trim() });
  }
  if (action === "shop-clear") {
    const input = document.querySelector("#shop");
    return resultFor(input?.closest(".ant-input-affix-wrapper")?.querySelector(".ant-input-clear-icon"));
  }
  if (action === "shop-option") {
    const target = modal && exact(modal, ".label-remark", label);
    const choice = target?.closest("label") || target;
    return resultFor(choice, { checked: Boolean(choice?.querySelector("input")?.checked) });
  }
  if (action === "click-shop-option") {
    const target = modal && exact(modal, ".label-remark", label);
    const choice = target?.closest("label") || target;
    if (!choice) return { ok: false };
    choice.click();
    return { ok: true };
  }
  if (action === "button") return resultFor(exact(document, "button", label));
  if (action === "click-button") {
    const target = exact(document, "button", label);
    if (!target) return { ok: false };
    target.click();
    return { ok: true };
  }
  if (action === "modal") return { ok: Boolean(modal) };
  if (action === "modal-button") return resultFor(modal && exact(modal, "button", label));
  if (action === "click-modal-button") {
    const target = modal && exact(modal, "button", label);
    if (!target) return { ok: false };
    target.click();
    return { ok: true };
  }
  if (action === "download-menu") {
    const root = [...document.querySelectorAll(".ant-dropdown")].find(visible) || document;
    return resultFor(exact(root, "li,[role='menuitem']", label));
  }
  if (action === "click-download-menu") {
    const root = [...document.querySelectorAll(".ant-dropdown")].find(visible) || document;
    const target = exact(root, "li,[role='menuitem']", label);
    if (!target) return { ok: false };
    target.click();
    return { ok: true };
  }
  if (action === "choice") {
    const target = exact(document, "label", label);
    const input = target?.querySelector("input");
    return resultFor(target, { checked: Boolean(input?.checked || /-checked(?:\s|$)/.test(target?.className || "")) });
  }
  if (action === "click-choice") {
    const target = exact(document, "label", label);
    if (!target) return { ok: false };
    target.click();
    return { ok: true };
  }
  if (action === "modal-checkbox") {
    const target = modal && exact(modal, "label", label);
    return resultFor(target, { checked: Boolean(target?.querySelector("input")?.checked || /-checked(?:\s|$)/.test(target?.className || "")) });
  }
  if (action === "table") {
    const table = [...document.querySelectorAll(".art-table-body")].find(visible);
    const body = document.body?.innerText || "";
    const text = table?.innerText || body;
    return {
      ok: Boolean(text.includes(label.date) && text.includes(label.shop) && !/暂无数据|请点击查询按钮后查看数据/.test(text)),
      empty: /暂无数据/.test(body),
    };
  }
  return { ok: false };
}

async function inspectJushengsuanControl(tabId, action, label = "") {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: inspectJushengsuanControlInPage,
    args: [action, label],
  }).catch(() => []);
  return injected?.[0]?.result || { ok: false };
}

async function waitForJushengsuanControl(tabId, action, label = "", timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false };
  while (Date.now() < deadline) {
    await waitWhilePaused(tabId);
    last = await inspectJushengsuanControl(tabId, action, label);
    if (last?.ok) return last;
    await sleep(500);
  }
  return last;
}

async function clickJushengsuanControl(tabId, action, label = "", timeoutMs = 30000) {
  const target = await waitForJushengsuanControl(tabId, action, label, timeoutMs);
  if (!target?.ok || !target.point) throw new Error(`聚胜算页面未找到“${typeof label === "string" ? label : action}”控件`);
  const clicked = await clickWithFallback(tabId, target.point);
  if (!clicked?.ok) throw new Error(clicked?.reason || "聚胜算页面点击失败");
  await sleepRandom(350, 650);
  return target;
}

async function ensureJushengsuanSelect(tabId, label, expected) {
  let current = await waitForJushengsuanControl(tabId, "form-select", label);
  if (!current?.ok) throw new Error(`聚胜算页面未加载“${label}”`);
  if (current.selected === String(expected).replace(/\s+/g, "")) return;
  const opened = await clickWithFallback(tabId, current.point);
  if (!opened?.ok) throw new Error(opened?.reason || `聚胜算“${label}”无法展开`);
  await sleepRandom(250, 500);
  await clickJushengsuanControl(tabId, "select-option", expected);
  current = await waitForJushengsuanControl(tabId, "form-select", label, 5000);
  if (current.selected !== String(expected).replace(/\s+/g, "")) {
    throw new Error(`聚胜算“${label}”未切换为“${expected}”`);
  }
}

async function ensureJushengsuanBlankSelect(tabId, label) {
  let current = await waitForJushengsuanControl(tabId, "form-select", label);
  if (!current?.ok) throw new Error(`聚胜算页面未加载“${label}”`);
  if (!current.selected) return;
  const clear = await inspectJushengsuanControl(tabId, "select-clear", label);
  if (!clear?.ok || !clear.point) throw new Error(`聚胜算“${label}”无法清空`);
  const cleared = await clickWithFallback(tabId, clear.point);
  if (!cleared?.ok) throw new Error(cleared?.reason || `聚胜算“${label}”无法清空`);
  await sleepRandom(250, 500);
  current = await waitForJushengsuanControl(tabId, "form-select", label, 5000);
  if (current.selected) throw new Error(`聚胜算“${label}”未清空`);
}

async function ensureJushengsuanChoice(tabId, label, checked = true) {
  const choice = await waitForJushengsuanControl(tabId, "choice", label);
  if (!choice?.ok) throw new Error(`聚胜算页面未加载“${label}”`);
  if (choice.checked === checked) return;
  const changed = await inspectJushengsuanControl(tabId, "click-choice", label);
  if (!changed?.ok) throw new Error(`聚胜算“${label}”无法切换`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const verified = await inspectJushengsuanControl(tabId, "choice", label);
    if (verified?.checked === checked) return;
    await sleep(250);
  }
  throw new Error(`聚胜算“${label}”未切换到所需状态`);
}

function jushengsuanExactShopName() {
  const value = String(shopIdentity || "").trim();
  return value.startsWith("天猫-") ? value : `天猫-${value}`;
}

async function ensureJushengsuanShop(tabId, exactShop) {
  let shop = await waitForJushengsuanControl(tabId, "shop-input");
  if (!shop?.ok) throw new Error("聚胜算店铺选择器未加载");
  if (shop.value === exactShop) return;
  if (shop.value) {
    const clear = await inspectJushengsuanControl(tabId, "shop-clear");
    if (!clear?.ok || !clear.point) throw new Error("聚胜算已有店铺条件无法清空");
    const cleared = await clickWithFallback(tabId, clear.point);
    if (!cleared?.ok) throw new Error(cleared?.reason || "聚胜算已有店铺条件无法清空");
    await sleepRandom(250, 500);
  }
  await clickJushengsuanControl(tabId, "shop-input");
  const option = await waitForJushengsuanControl(tabId, "shop-option", exactShop, 15000);
  if (!option?.ok) throw new Error(`聚胜算店铺列表没有“${exactShop}”`);
  const selected = await inspectJushengsuanControl(tabId, "click-shop-option", exactShop);
  if (!selected?.ok) throw new Error(`聚胜算店铺“${exactShop}”无法选择`);
  const selectionDeadline = Date.now() + 5000;
  let selectionChecked = false;
  while (Date.now() < selectionDeadline) {
    const state = await inspectJushengsuanControl(tabId, "shop-option", exactShop);
    if (state?.checked) {
      selectionChecked = true;
      break;
    }
    await sleep(250);
  }
  if (!selectionChecked) throw new Error(`聚胜算店铺“${exactShop}”未被选中`);
  const confirmed = await inspectJushengsuanControl(tabId, "click-modal-button", "确定");
  if (!confirmed?.ok) throw new Error("聚胜算店铺选择窗口无法确认");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    shop = await inspectJushengsuanControl(tabId, "shop-input");
    if (shop?.value === exactShop) return;
    await sleep(250);
  }
  throw new Error(`聚胜算店铺条件不是“${exactShop}”`);
}

async function configureJushengsuanProfitQuery(tabId, date, kind) {
  if (!parseLocalDate(date) || date >= localIsoDate()) {
    throw new Error("聚胜算自动采集只支持今天之前的单日数据");
  }
  const page = await waitForJushengsuanControl(tabId, "page", "", 30000);
  if (!page?.ok) throw new Error(page?.loginRequired ? "聚胜算登录已失效，请重新登录" : "聚胜算利润报表页面未加载完成");

  const picker = await inspectJushengsuanControl(tabId, "click-date-picker");
  if (!picker?.ok) throw new Error("聚胜算日期选择器无法打开");
  await sleepRandom(250, 450);
  const startDate = await inspectJushengsuanControl(tabId, "click-date-cell", date);
  if (!startDate?.ok) throw new Error(`聚胜算日期面板未找到 ${date}`);
  await sleepRandom(250, 450);
  const endDate = await inspectJushengsuanControl(tabId, "click-date-cell", date);
  if (!endDate?.ok) throw new Error(`聚胜算日期面板未完成 ${date} 的单日区间`);
  const dateState = await waitForJushengsuanControl(tabId, "date-value", date, 5000);
  if (!dateState?.ok) throw new Error(`聚胜算日期未切换为 ${date}，当前为 ${dateState?.value || "未知"}`);
  await ensureJushengsuanSelect(tabId, "订单时间类型", "订单发货时间");
  await ensureJushengsuanSelect(tabId, "退款统计口径", "以订单实时统计");
  if (kind === "store") await ensureJushengsuanSelect(tabId, "费用取值方案", "复盘（按发生时间）");
  else await ensureJushengsuanBlankSelect(tabId, "费用取值方案");
  const exactShop = jushengsuanExactShopName();
  await ensureJushengsuanShop(tabId, exactShop);

  if (kind === "store") {
    await ensureJushengsuanChoice(tabId, "按日", true);
  } else {
    for (const label of ["按店铺", "按日期", "按店铺款式编码"]) {
      await ensureJushengsuanChoice(tabId, label, true);
    }
    for (const label of ["按店铺商品编码", "按款", "按SKU", "按品牌", "按分类", "按虚拟分类", "运营云仓", "发货仓库", "业务员", "线下客户", "线上颜色规格"]) {
      await ensureJushengsuanChoice(tabId, label, false);
    }
  }
  const queried = await inspectJushengsuanControl(tabId, "click-button", "查询");
  if (!queried?.ok) throw new Error("聚胜算查询按钮无法点击");
  const table = await waitForJushengsuanControl(tabId, "table", { date, shop: kind === "store" ? "" : exactShop }, 45000);
  if (!table?.ok) throw new Error(table?.empty ? `${date} 的聚胜算利润报表暂无数据` : `聚胜算查询结果未出现 ${date} 与指定店铺`);
  return exactShop;
}

async function openJushengsuanExportModal(tabId) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const modal = await inspectJushengsuanControl(tabId, "modal");
    if (modal?.ok) return;
    const exportButton = await waitForJushengsuanControl(tabId, "button", "导出数据", 10000);
    if (!exportButton?.ok || !exportButton.point) throw new Error("聚胜算导出按钮无法点击");
    const opened = await clickWithFallback(tabId, exportButton.point);
    if (!opened?.ok) throw new Error(opened?.reason || "聚胜算导出按钮无法点击");
    await sleepRandom(300, 600);
    const menu = await waitForJushengsuanControl(tabId, "download-menu", "导出数据", 3000);
    if (!menu?.ok || !menu.point) continue;
    const clicked = await inspectJushengsuanControl(tabId, "click-download-menu", "导出数据");
    if (!clicked?.ok) throw new Error("聚胜算“导出数据”菜单无法点击");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const openedModal = await inspectJushengsuanControl(tabId, "modal");
      if (openedModal?.ok) return;
      await sleep(350);
    }
  }
  throw new Error("聚胜算导出设置窗口未打开");
}

async function ensureJushengsuanModalCheckbox(tabId, label) {
  let checkbox = await waitForJushengsuanControl(tabId, "modal-checkbox", label, 10000);
  if (!checkbox?.ok || !checkbox.point) throw new Error(`聚胜算导出设置缺少“${label}”`);
  if (checkbox.checked) return;
  const clicked = await clickWithFallback(tabId, checkbox.point);
  if (!clicked?.ok) throw new Error(clicked?.reason || `聚胜算导出设置“${label}”无法勾选`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    checkbox = await inspectJushengsuanControl(tabId, "modal-checkbox", label);
    if (checkbox?.checked) return;
    await sleep(250);
  }
  throw new Error(`聚胜算导出设置“${label}”未勾选`);
}

async function ensureJushengsuanProfitPageLoaded(tabId, label) {
  let last = { ok: false };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitForTabComplete(tabId, 60000);
    await sleepRandom(1200, 2000);
    last = await waitForJushengsuanControl(tabId, "page", "", 15000);
    if (last?.ok) {
      await appendCollectorLog(`${label}：页面加载完成${attempt > 1 ? `（第 ${attempt} 次）` : ""}`);
      return;
    }
    if (last?.loginRequired) throw new Error("聚胜算登录已失效，请重新登录");
    if (attempt < 3) {
      await appendCollectorLog(`${label}：页面未完成加载，正在重试第 ${attempt + 1} 次`);
      await chrome.tabs.reload(tabId);
    }
  }
  throw new Error("聚胜算利润报表页面连续 3 次未加载完成");
}

async function runScheduledJushengsuanProfitDownload(date, kind, force = false) {
  const isStore = kind === "store";
  const table = isStore ? "profit_store" : "profit_product";
  const label = isStore ? "聚胜算全店利润" : "聚胜算商品利润";
  const url = isStore ? JUSHENGSUAN_STORE_PROFIT_URL : JUSHENGSUAN_PRODUCT_PROFIT_URL;
  const expected = { table, date };
  if (!force && await hasCompletedExpectedReportDownload(expected)) {
    return { ok: true, skipped: true, summary: `${date} 的${label}已下载并核验` };
  }
  if (force) await forgetVerifiedReportDownload(expected);

  const found = await findReusableTab(url);
  if (found.reused) {
    const currentUrl = parseUrl(found.tab.url);
    const targetUrl = parseUrl(url);
    const alreadyOnTarget = currentUrl && targetUrl && currentUrl.origin === targetUrl.origin && currentUrl.pathname === targetUrl.pathname;
    await chrome.tabs.update(found.tab.id, alreadyOnTarget ? { active: true } : { url, active: true });
  }
  await ensureJushengsuanProfitPageLoaded(found.tab.id, label);
  await setPageStatus(found.tab.id, `${label}：正在设置 ${date} 的查询条件`);
  await configureJushengsuanProfitQuery(found.tab.id, date, kind);
  await appendCollectorLog(`${label}：${date} 查询完成，正在打开导出设置`);
  await openJushengsuanExportModal(found.tab.id);
  await appendCollectorLog(`${label}：${date} 导出设置已打开`);
  for (const option of ["二级利润表项目", "一级利润表项目", "查询条件"]) {
    await ensureJushengsuanModalCheckbox(found.tab.id, option);
  }
  await appendCollectorLog(`${label}：${date} 已包含一级、二级费用科目和查询条件`);

  await forgetVerifiedReportDownload(expected);
  activeDownloadContext = { table, date, expiresAt: Date.now() + 150_000 };
  const startedAt = Date.now();
  const watcher = watchForCompletedReportDownload(startedAt, 120_000, expected);
  try {
    await setBadge(found.tab.id, "下载", "#2563eb");
    await setPageStatus(found.tab.id, `${label}：开始导出 ${date}`);
    const exported = await inspectJushengsuanControl(found.tab.id, "click-modal-button", "导出");
    if (!exported?.ok) throw new Error("聚胜算导出确认按钮无法点击");
    const watched = await watcher.promise;
    if (!watched?.item) {
      await setBadge(found.tab.id, "!", "#dc2626");
      return { ok: false, reused: found.reused, reason: watched?.reason || `${label}下载未完成` };
    }
    await rememberVerifiedReportDownload(expected, watched.item);
    await setBadge(found.tab.id, "完成", "#16a34a");
    await setPageStatus(found.tab.id, `${label}下载完成：${date}`);
    return { ok: true, reused: found.reused, filename: watched.item.filename, summary: `${date} ${label}已下载` };
  } finally {
    activeDownloadContext = null;
  }
}

function normalizeCollectionBackfillPlan(input = {}) {
  const keys = ["storeDaily", "productDaily", "paidScene", "paidItem", "paidContent", "taokeOverview"];
  const today = localIsoDate();
  const normalized = {};
  for (const key of keys) {
    // Preserve callers from 1.1.2 that do not know the new optional report.
    if (key === "taokeOverview" && input[key] === undefined) { normalized[key] = []; continue; }
    if (!Array.isArray(input[key])) throw new Error(`补采计划缺少 ${key}`);
    const dates = [...new Set(input[key].map(String))].sort();
    if (dates.length > 31 || dates.some((date) => !parseLocalDate(date) || date >= today)) {
      throw new Error(`补采计划 ${key} 的日期无效`);
    }
    normalized[key] = dates;
  }
  return normalized;
}

async function runCollectionBackfill(input = {}) {
  if (scheduledRunActive) return { ok: false, reason: "采集任务正在运行，请等待当前任务完成" };
  if (await isPaused()) return { ok: false, reason: "插件当前处于暂停状态" };
  const plan = normalizeCollectionBackfillPlan(input.plan);
  const range = input.range || {};
  const start = String(range.start || "");
  const end = String(range.end || start);
  if (!parseLocalDate(start) || !parseLocalDate(end) || start > end) throw new Error("补采期间无效");
  await configuredCollectorShopForScheduledRun();

  const jobs = [];
  const addJobs = (key, label, flow, run) => {
    for (const date of plan[key]) jobs.push({ key, label, flow, date, run: () => run(date) });
  };
  addJobs("storeDaily", "店铺经营核心日报", "sycm_store_download", (date) => runScheduledStoreDownload(date, true));
  addJobs("productDaily", "商品数据", "sycm_product_download", (date) => runScheduledProductDownload(date));
  addJobs("paidScene", "营销场景报表", "alimama_paid_download", (date) => runFlow({
    flow: "alimama_paid_download", urlTemplate: ALIMAMA_ACCOUNT_URL, range: { start: date, end: date }, force: true,
  }));
  addJobs("paidItem", "商品推广报表", "alimama_item_download", (date) => runFlow({
    flow: "alimama_item_download", urlTemplate: ALIMAMA_ITEM_PROMOTION_URL, range: { start: date, end: date }, force: true,
  }));
  addJobs("paidContent", "内容推广明细", "alimama_content_download", (date) => runFlow({
    flow: "alimama_content_download", urlTemplate: ALIMAMA_CONTENT_PROMOTION_URL, range: { start: date, end: date }, force: true,
  }));
  addJobs("taokeOverview", "淘宝联盟推广概览", "taoke_overview_download", (date) => runFlow({
    flow: "taoke_overview_download", range: { start: date, end: date }, force: true,
  }));
  if (!jobs.length) return { ok: true, start, end, success: 0, failed: 0, results: [] };
  scheduledRunActive = true;
  const results = [];
  try {
    await appendCollectorLog(`历史补采启动：${start} 至 ${end}，共 ${jobs.length} 个报表日`);
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      await waitWhilePaused((await activeTab())?.id);
      await appendCollectorLog(`历史补采：${job.label} ${job.date}`);
      const result = await runMonitoredCollectorAction(
        job.flow,
        { start: job.date, end: job.date },
        job.run,
        { useConfiguredShop: true },
      ).catch((error) => ({ ok: false, reason: error.message }));
      results.push({ key: job.key, label: job.label, date: job.date, ...result });
      await appendCollectorLog(result?.ok
        ? `历史补采完成：${job.label} ${job.date}`
        : `历史补采未完成：${job.label} ${job.date}，${result?.reason || "下载失败"}`);
      if (index < jobs.length - 1) await sleepBetweenDates((await activeTab())?.id, randomInt(3500, 6000));
    }
  } finally {
    scheduledRunActive = false;
  }
  const failed = results.filter((item) => !item.ok);
  const summary = {
    ok: failed.length === 0,
    partial: failed.length > 0 && failed.length < results.length,
    start,
    end,
    success: results.length - failed.length,
    failed: failed.length,
    results,
    reason: failed.length ? `${failed.map((item) => `${item.label} ${item.date}`).join("、")}未完成` : "",
  };
  await appendCollectorLog(summary.ok
    ? `历史补采完成：成功 ${summary.success} 项`
    : `历史补采结束：成功 ${summary.success} 项，失败 ${summary.failed} 项`);
  return summary;
}

async function runMissingContentBackfillAfterUpdate() {
  return { ok: true, skipped: true };
}

async function runScheduledCollection(source = "定时", phase = "all") {
  if (scheduledRunActive) {
    return { ok: false, reason: "定时采集正在运行，请勿重复启动" };
  }
  if (await isPaused()) {
    await appendCollectorLog(`${source}采集已跳过：插件当前处于暂停状态`);
    return { ok: false, reason: "插件当前处于暂停状态" };
  }

  await configuredCollectorShopForScheduledRun();
  const configuredSchedule = await getCollectionSchedule();
  const schedule = scheduleForPhase(configuredSchedule, phase);
  const date = yesterdayLocalDate();
  scheduledRunActive = true;
  try {
    await appendCollectorLog(`${source}采集已启动`);
    const selectedCount = [
      schedule.includeStoreReport,
      schedule.includeProductReport,
      schedule.includeSceneReport,
      schedule.includeItemReport,
      schedule.includeContentReport,
      schedule.includeTaokeReport,
    ].filter(Boolean).length;
    if (!selectedCount) {
      const reason = "请至少勾选一项采集任务后再开始";
      await appendCollectorLog(`${source}采集未启动：${reason}`);
      return { ok: false, date, schedule, reason };
    }
    let product = null;
    if (schedule.includeProductReport) {
      await appendCollectorLog(`${source}采集开始：下载 ${date} 的商品官方报表`);
      product = await runMonitoredCollectorAction(
        "sycm_product_download",
        { start: date, end: date },
        () => runScheduledProductDownload(date),
        { useConfiguredShop: true },
      );
      if (!product?.ok) {
        const reason = product?.reason || "商品报表下载失败";
        await appendCollectorLog(`${source}采集未完成：${reason}`);
        return { ok: false, date, product, schedule, reason };
      }
      await appendCollectorLog(`${source}采集完成：商品报表 ${date}`);
    } else {
      await appendCollectorLog(`${source}采集：商品数据下载未启用`);
    }

    let store = null;
    if (schedule.includeStoreReport) {
      if (product) {
        const waitMs = randomInt(6000, 10000);
        await setPageStatus((await activeTab())?.id, `${source}采集：商品报表结束，静待 ${Math.round(waitMs / 1000)} 秒后下载店铺日报`);
        await sleepBetweenDates((await activeTab())?.id, waitMs);
        await waitWhilePaused((await activeTab())?.id);
      }
      chrome.alarms.create(STORE_REFRESH_ALARM, { when: Date.now() + 7 * 60 * 60 * 1000 });
      await appendCollectorLog(`${source}采集继续：店铺经营核心日报 ${date}`);
      store = await runMonitoredCollectorAction(
        "sycm_store_download",
        { start: date, end: date },
        () => runScheduledStoreDownload(date),
        { useConfiguredShop: true },
      ).catch((error) => ({ ok: false, reason: error.message }));
      if (store?.ok) {
        await appendCollectorLog(`${source}采集完成：店铺经营核心日报 ${date}${store.skipped ? "（已核验，跳过重复下载）" : ""}`);
      } else {
        await appendCollectorLog(`${source}采集未完成：店铺经营核心日报 ${date}，${store?.reason || "下载失败"}`);
      }
    } else {
      await appendCollectorLog(`${source}采集：店铺经营核心日报下载未启用`);
    }

    const paid = [];
    const scheduledReports = [
      schedule.includeSceneReport && {
        flow: "alimama_paid_download",
        label: "营销场景报表",
        urlTemplate: ALIMAMA_ACCOUNT_URL,
      },
      schedule.includeItemReport && {
        flow: "alimama_item_download",
        label: "商品推广报表",
        urlTemplate: ALIMAMA_ITEM_PROMOTION_URL,
      },
      schedule.includeContentReport && {
        flow: "alimama_content_download",
        label: "内容推广明细",
        urlTemplate: ALIMAMA_CONTENT_PROMOTION_URL,
      },
      schedule.includeTaokeReport && {
        flow: "taoke_overview_download",
        label: "淘宝联盟推广概览",
      },
    ].filter(Boolean);

    if (!scheduledReports.length) {
      await appendCollectorLog(`${source}采集：推广报表下载未启用`);
    }

    for (let index = 0; index < scheduledReports.length; index += 1) {
      const report = scheduledReports[index];
      await waitWhilePaused((await activeTab())?.id);
      await appendCollectorLog(`${source}采集继续：${report.label} ${date}`);
      const result = await runMonitoredCollectorAction(
        report.flow,
        { start: date, end: date },
        () => runFlow({
          flow: report.flow,
          urlTemplate: report.urlTemplate,
          range: { start: date, end: date },
        }),
        { useConfiguredShop: true },
      ).catch((error) => ({ ok: false, reason: error.message }));
      paid.push({ label: report.label, flow: report.flow, ...result });

      if (result?.ok) {
        await appendCollectorLog(`${source}采集完成：${report.label} ${date}`);
      } else {
        await appendCollectorLog(`${source}采集未完成：${report.label} ${date}，${result?.reason || "下载失败"}`);
      }

      if (index < scheduledReports.length - 1) {
        const waitMs = randomInt(6000, 10000);
        await setPageStatus((await activeTab())?.id, `${source}采集：${report.label}结束，静待 ${Math.round(waitMs / 1000)} 秒后继续`);
        await sleepBetweenDates((await activeTab())?.id, waitMs);
      }
    }

    const reportResults = [
      ...(product ? [{ label: "商品数据", ...product }] : []),
      ...(store ? [{ label: "店铺经营核心日报", ...store }] : []),
      ...paid,
    ];
    const reportFailures = reportResults.filter((item) => !item.ok);
    const failedStore = store && !store.ok;
    if (failedStore && schedule.includeStoreReport) {
      chrome.alarms.create(STORE_RETRY_ALARM, { when: Date.now() + 4 * 60 * 60 * 1000 });
      await appendCollectorLog(`${source}采集：店铺日报未完成，已安排稍后自动重试`);
    }
    const reason = reportFailures.length
      ? `${reportFailures.map((item) => item.label).join("、")}下载未完成`
      : "";
    const outcome = {
      ok: reportFailures.length === 0,
      partial: reportFailures.length > 0 && reportFailures.length < reportResults.length,
      date,
      product,
      store,
      paid,
      schedule,
      reason,
    };
    const awaitingAfternoon = phase === "morning" && hasAfternoonReports(configuredSchedule);
    await appendCollectorLog(outcome.ok
      ? (awaitingAfternoon ? `${source}采集已完成，等待下午推广报表` : `${source}采集已完成`)
      : `${source}采集未完成：${reason}`);
    if (outcome.ok && source !== "手动定时任务") {
      const successKey = phase === "morning" ? MORNING_LAST_SUCCESS_DATE_KEY : AFTERNOON_LAST_SUCCESS_DATE_KEY;
      if (phase !== "all") await chrome.storage.local.set({ [successKey]: date });
    }
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendCollectorLog(`${source}采集异常：${reason}`);
    throw error;
  } finally {
    scheduledRunActive = false;
  }
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const context = activeDownloadContext;
  if (!context || context.expiresAt < Date.now()) {
    suggest();
    return;
  }
  if (context.table === "taoke_overview" && (!TaokeReport.isOfficialSource(downloadItem)
    || !TaokeReport.matchesOfficialFilename(downloadItem, context.date))) {
    suggest();
    return;
  }
  const original = String(downloadItem.filename || downloadItem.url || "report").split(/[\\/]/).pop();
  const safeOriginal = original.replace(/[<>:"/\\|?*]+/g, "_");
  const dateLabel = context.batchLabel || context.date || "undated";
  const storeSegment = safeShopSegment(shopIdentity);
  const reportDirectory = ["paid_scene", "paid_item", "paid_content"].includes(context.table)
    ? `paid_export/${context.table}`
    : context.table;
  const filename = `淘宝店铺数据采集/${storeSegment}/${reportDirectory}/${context.table}_${storeSegment}_${dateLabel}_${safeOriginal}`;
  if (isReportDownload(downloadItem) && isCollectorSource(downloadItem)) pluginDownloadIds.add(downloadItem.id);
  suggest({ filename, conflictAction: "uniquify" });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current !== "complete") return;
  if (!pluginDownloadIds.has(delta.id)) return;
  pluginDownloadIds.delete(delta.id);
  chrome.downloads.search({ id: delta.id }, (items) => {
    const item = items?.[0];
    if (!item) return;
    void rememberPluginDownload(item);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STORE_RETRY_ALARM || alarm.name === STORE_REFRESH_ALARM) {
    const date = yesterdayLocalDate();
    const force = alarm.name === STORE_REFRESH_ALARM;
    runScheduledStoreDownload(date, force)
      .then((result) => appendCollectorLog(`店铺日报${force ? "下午刷新" : "延迟重试"} ${date}：${result?.ok ? "下载完成" : result?.reason || "未完成"}`))
      .catch((error) => appendCollectorLog(`店铺日报延迟重试异常：${error.message}`));
    return;
  }
  if (alarm.name !== SCHEDULE_ALARM && alarm.name !== AFTERNOON_SCHEDULE_ALARM) return;
  const phase = alarm.name === SCHEDULE_ALARM ? "morning" : "afternoon";
  runScheduledCollection(phase === "morning" ? "上午定时" : "下午定时", phase)
    .catch((error) => appendCollectorLog(`定时采集异常：${error.message}`));
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(SHOP_IDENTITY_KEY).then((saved) => {
    const value = String(saved?.[SHOP_IDENTITY_KEY] || "").trim();
    if (value) shopIdentity = value;
  }).catch(() => {});
  configureCollectionSchedule().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    const schedule = await configureCollectionSchedule();
    const saved = await chrome.storage.local.get([MORNING_LAST_SUCCESS_DATE_KEY, AFTERNOON_LAST_SUCCESS_DATE_KEY]);
    const date = yesterdayLocalDate();
    if (schedule.enabled && hasMorningReports(schedule)
      && saved[MORNING_LAST_SUCCESS_DATE_KEY] !== date && isWithinScheduleCatchupWindow(schedule.time)) {
      await runScheduledCollection("上午补运行", "morning");
    }
    if (schedule.enabled && hasAfternoonReports(schedule)
      && saved[AFTERNOON_LAST_SUCCESS_DATE_KEY] !== date && isWithinScheduleCatchupWindow(schedule.afternoonTime)) {
      await runScheduledCollection("下午补运行", "afternoon");
    }
  })().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "INSPECT_ALIMAMA_DOWNLOAD_TARGET") {
    exportAlimamaDownloadInspection()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "GET_COLLECTION_SCHEDULE") {
    getCollectionSchedule()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "SET_COLLECTOR_PAUSED") {
    const paused = Boolean(message.paused);
    chrome.storage.local.set({ [PAUSE_KEY]: paused })
      .then(() => appendCollectorLog(paused ? "插件已暂停" : "插件已恢复"))
      .then(() => sendResponse({ ok: true, paused }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "SET_SHOP_IDENTITY") {
    const value = String(message.shopIdentity || "").trim();
    if (!value) {
      sendResponse({ ok: false, reason: "店铺标识不能为空" });
      return false;
    }
    shopIdentity = value;
    chrome.storage.local.set({ [SHOP_IDENTITY_KEY]: value })
      .then(() => appendCollectorLog(`当前采集店铺已设置为：${value}`))
      .then(() => sendResponse({ ok: true, shopIdentity: value }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "SET_COLLECTION_SCHEDULE") {
    configureCollectionSchedule(message.schedule || {})
      .then(async (schedule) => {
        const reports = scheduledReportLabels(schedule);
        await appendCollectorLog(`每日定时采集已${schedule.enabled ? "开启" : "关闭"}：生意参谋 ${schedule.time}，推广 ${schedule.afternoonTime}${reports.length ? `，下载${reports.join("、")}` : "，无报表"}`);
        sendResponse({ ok: true, ...schedule });
      })
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "RUN_SCHEDULED_COLLECTION") {
    runScheduledCollection("手动定时任务")
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "RUN_COLLECTION_BACKFILL") {
    runCollectionBackfill(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "OPEN_URL") {
    openNewUrl(message.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "OPEN_OR_REUSE_URL") {
    openOrReuseUrl(message.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "START_PRODUCT_DOWNLOAD_CURRENT_PAGE") {
    runMonitoredCollectorAction(
      "sycm_product_download",
      message.range,
      () => runProductDownloadRange(message.range),
    )
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "RESUME_QUEUED_ALIMAMA_DOWNLOADS") {
    runMonitoredCollectorAction(message.flow, message.range, () => resumeQueuedAlimamaDownloads(message))
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "RUN_FLOW") {
    runMonitoredCollectorAction(message.flow, message.range, () => runFlow(message))
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "GET_RECENT_DOWNLOADS") {
    downloadRecordQueue.then(() => sendResponse({ ok: true, downloads: recentDownloads.slice() }));
    return true;
  }

  return false;
});

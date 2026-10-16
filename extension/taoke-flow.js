// Loaded after background.js by importScripts. Functions execute only on explicit
// clicks or an opt-in schedule. Never create an export without checked dates.
async function taokeInspect(tabId, request = {}) {
  // executeScript(func) does not carry service-worker closures into the page.
  // Install the two DOM-only helpers in the isolated world before calling them.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["taoke-page.js"] });
  const results = await chrome.scripting.executeScript({ target: { tabId },
    func: (input) => inspectTaokeExport(input), args: [request] });
  return results?.[0]?.result || { ok: false, reason: "淘宝联盟页面检查没有返回结果" };
}

function taokeRangeMatches(state, range) {
  const normalize = (value) => {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(value));
    return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
  };
  return Boolean(state.modalRange && normalize(state.modalRange.start) === range.start && normalize(state.modalRange.end) === range.end);
}

async function taokeSelectDate(tabId, date, account) {
  for (let step = 0; step < 30; step += 1) {
    const state = await taokeInspect(tabId, { date });
    if (!state.ok || state.account !== account) throw new Error(state.reason || "账号页面发生变化，停止日期选择");
    if (!state.calendarOpen || !state.calendar) throw new Error("淘宝联盟日期面板没有打开");
    if (state.calendar.datePoint) {
      await trustedClick(tabId, state.calendar.datePoint);
      await sleep(350);
      return;
    }
    const month = date.slice(0, 7);
    const months = state.calendar.months;
    const target = months.length && month < months[0] ? state.calendar.previousPoint
      : months.length && month > months[months.length - 1] ? state.calendar.nextPoint : null;
    if (!target) throw new Error(`日期 ${date} 不可选或日历结构已变化，未提交下载`);
    await trustedClick(tabId, target);
    await sleep(250);
  }
  throw new Error("日期切换超过安全次数，未提交下载");
}

async function runTaokeOverviewDownload(message) {
  const range = TaokeReport.normalizeRange(message.range);
  if (await isPaused()) return { ok: false, reason: "插件当前处于暂停状态" };
  const reportUrl = "https://ad.alimama.com/portal/v2/report/promotionDataPage.htm";
  const found = await findReusableTab(reportUrl);
  const tabId = found.tab.id;
  if (found.reused && new URL(found.tab.url).pathname !== new URL(reportUrl).pathname) {
    await chrome.tabs.update(tabId, { url: reportUrl });
  }
  await waitForTabComplete(tabId);
  await sleep(1200);
  let state = await taokeInspect(tabId);
  if (!state.ok) return state;
  if (!state.overview && state.overviewHref) {
    await chrome.tabs.update(tabId, { url: state.overviewHref });
    await waitForTabComplete(tabId);
    await sleep(1000);
    state = await taokeInspect(tabId);
  } else if (!state.overview && state.overviewPoint) {
    await trustedClick(tabId, state.overviewPoint);
    await sleep(1000);
    state = await taokeInspect(tabId);
  }
  if (!state.ok) return state;
  if (!state.overview) return { ok: false, reason: "请先在淘宝联盟卖家账号中打开“店铺整体数据—推广概览”，再运行下载" };
  const account = state.account;
  if (!account) return { ok: false, reason: "未能核实商家账号栏，停止下载" };
  if (!state.dialogOpen) {
    if (!state.openPoint) return { ok: false, reason: "没有找到唯一可点击的推广概览下载入口" };
    await trustedClick(tabId, state.openPoint);
    await sleep(600);
    state = await taokeInspect(tabId);
  }
  if (!state.startPoint && state.formTabPoint) {
    await trustedClick(tabId, state.formTabPoint);
    await sleep(400);
    state = await taokeInspect(tabId);
  }
  if (!state.ok || !state.startPoint || state.account !== account) return { ok: false, reason: state.reason || "官方下载表单未就绪或账号已变化" };
  if (!taokeRangeMatches(state, range)) {
    await trustedClick(tabId, state.startPoint);
    await sleep(350);
    await taokeSelectDate(tabId, range.start, account);
    await taokeSelectDate(tabId, range.end, account);
    await sleep(400);
    state = await taokeInspect(tabId);
    if (!state.ok) return state;
    if (!taokeRangeMatches(state, range)) {
      return { ok: false, reason: `尚未核实页面统计区间为 ${range.start} 至 ${range.end}，未触发导出。请人工设置并确认日期后重试` };
    }
  }
  for (const [value, field] of [["1", "dayPoint"], ["105", "planPoint"]]) {
    if (!state.checkedRadios.includes(value)) {
      if (!state[field]) return { ok: false, reason: "无法核实分天/按计划选项，停止提交" };
      await trustedClick(tabId, state[field]);
      await sleep(250);
      state = await taokeInspect(tabId);
    }
  }
  await waitWhilePaused(tabId);
  // Re-check after any manual pause, to avoid exporting a different date/account.
  state = await taokeInspect(tabId);
  if (!state.ok || !taokeRangeMatches(state, range) || state.account !== account || state.calendarOpen
    || !state.checkedRadios.includes("1") || !state.checkedRadios.includes("105") || !state.confirmPoint) {
    return { ok: false, reason: state.reason || "下载前页面状态发生变化，请重新确认推广概览与日期" };
  }
  const startedAt = Date.now();
  activeDownloadContext = {
    table: "taoke_overview", date: `${range.start}_${range.end}`,
    expiresAt: startedAt + 180000,
  };
  const watcher = watchForCompletedReportDownload(startedAt, 180000,
    { table: "taoke_overview", date: `${range.start}_${range.end}` }, {
      classify: async (item) => {
        if (!item || item.exists === false) return { matched: false };
        if (TaokeReport.isExpectedDownload(item, range, startedAt)) return { matched: true };
        if (item.state !== "complete" || !TaokeReport.matchesOfficialFilename(item, `${range.start}_${range.end}`)
          || !Number.isFinite(Date.parse(item.startTime)) || Date.parse(item.startTime) < startedAt) return { matched: false };
        const page = await taokeInspect(tabId, { range });
        const taskVerified = page.ok && page.account === account && page.record?.completed === true;
        return {
          matched: TaokeReport.isExpectedDownload(item, range, startedAt, { taskVerified }),
          verifiedOfficialTask: taskVerified,
        };
      },
    });
  try {
    await trustedClick(tabId, state.confirmPoint);
    await appendCollectorLog(`淘宝联盟报表已提交：${range.start} 至 ${range.end}，分天/按计划，等待官方生成`);
    // Keep the official dialog open: the site downloads the completed task itself.
    // Do not resubmit if generation is slow or the result is uncertain.
    const result = await watcher.promise;
    if (!result.item || !TaokeReport.isExpectedDownload(result.item, range, startedAt, { taskVerified: result.verifiedOfficialTask })) {
      return { ok: false, reason: "本次任务未核实到下载完成，已结束并释放任务占用。文件若已下载，请保留文件并核对官方下载记录；不要立即重复提交。" + (result.reason ? `（${result.reason}）` : "") };
    }
    return { ok: true, filename: result.item.filename, start: range.start, end: range.end,
      summary: "淘宝联盟推广概览官方报表已下载" };
  } finally {
    watcher.cancel();
    activeDownloadContext = null;
  }
}

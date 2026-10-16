/* 淘宝联盟商家端适配。只使用可见页面及官方导出，不调用私有接口。 */
(function (root) {
  "use strict";

  function parseDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const result = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    return result.getFullYear() === Number(match[1])
      && result.getMonth() + 1 === Number(match[2])
      && result.getDate() === Number(match[3]) ? result : null;
  }

  function formatDay(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }

  function normalizeRange(input = {}, now = new Date()) {
    const start = parseDay(input.start);
    const end = parseDay(input.end || input.start);
    if (!start || !end || start > end) throw new Error("淘宝联盟报表日期无效");
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    if (end >= today) throw new Error("淘宝联盟历史报表请选择昨天或更早，不导出今日实时数据");
    const dates = [];
    for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      dates.push(formatDay(cursor));
      if (dates.length > 31) throw new Error("单次淘宝联盟下载最多31天");
    }
    // 截图中平台提示保留最近400天；不尝试扩大平台权限或绕过保留范围。
    const earliest = new Date(today);
    earliest.setDate(earliest.getDate() - 399);
    if (start < earliest) throw new Error("所选日期超出最近400天，请先确认平台可查询范围");
    return { start: formatDay(start), end: formatDay(end), dates };
  }

  function isOfficialSource(item = {}) {
    return [item.referrer, item.url, item.finalUrl].some((value) => {
      try {
        const url = new URL(String(value || "").replace(/^blob:/, ""));
        return url.protocol === "https:" && url.hostname === "ad.alimama.com";
      } catch { return false; }
    });
  }

  function isExpectedDownload(item, expected, startedAt, evidence = {}) {
    if (!item) return false;
    if (!/\.(xlsx?|csv|zip)(?:$|[?#\s])|excel|spreadsheet|csv|application\/zip/i.test(
      `${item.filename || ""} ${item.url || ""} ${item.mime || ""}`.trim())) return false;
    const started = Date.parse(item.startTime);
    if (!Number.isFinite(started) || started < startedAt) return false;
    const nativeMatch = matchesOfficialFilename(item, `${expected.start}_${expected.end}`);
    // A completed official task in the same checked account is an alternative
    // provenance proof if an official CDN/download does not include a referrer.
    if (!isOfficialSource(item) && !(nativeMatch && evidence.taskVerified === true)) return false;
    const name = String(item.filename || "").replace(/\\/g, "/");
    return nativeMatch || (name.includes("taoke_overview_") && name.includes(`${expected.start}_${expected.end}`));
  }

  function matchesOfficialFilename(item, rangeLabel) {
    const text = String(item.filename || "");
    const [start, end] = String(rangeLabel || "").split("_");
    const match = /(\d{4}-\d{2}-\d{2})[ T]00[:_]00[:_]00[~～](\d{4}-\d{2}-\d{2})[ T]23[:_]59[:_]59-分天数据-计划[\\/_]活动类型-推广概览-数据汇总/.exec(text);
    return Boolean(start && end && match && match[1] === start && match[2] === end);
  }

  const api = Object.freeze({ parseDay, formatDay, normalizeRange, isOfficialSource, isExpectedDownload, matchesOfficialFilename });
  root.TaokeReport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);

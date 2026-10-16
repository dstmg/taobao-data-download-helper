/* 此函数可序列化到页面；不读取Cookie、页面运行时变量或网络凭据。 */
function inspectTaokePage() {
  const compact = (text) => String(text || "").replace(/\s+/g, "").trim();
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const text = document.body?.innerText || "";
  if (location.protocol !== "https:" || location.hostname !== "ad.alimama.com") {
    return { ok: false, reason: "请在淘宝联盟商家中心操作，不支持生态伙伴端或其他站点" };
  }
  if (/验证码|安全验证|滑动验证|拖动滑块|访问过于频繁/.test(text)) {
    return { ok: false, reason: "平台要求验证或提示访问频繁，请人工处理后再运行", blocked: true };
  }
  if (/确认登录|请先登录|扫码登录|账号密码登录/.test(text)) {
    return { ok: false, reason: "请先手动登录淘宝联盟卖家账号", blocked: true };
  }
  const controls = [...document.querySelectorAll("button,a,[role=button],label,span,div")]
    .filter(visible);
  const exact = (label) => controls.filter((element) => compact(element.innerText) === label)
    .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
  const point = (element) => {
    if (!element) return null;
    const target = element.closest("button,a,[role=button]") || element;
    if (target.disabled || target.getAttribute("aria-disabled") === "true") return null;
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth) return null;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const overviewLink = [...document.querySelectorAll("a[href]")].find((element) =>
    visible(element) && compact(element.innerText) === "推广概览");
  let overviewHref = null;
  if (overviewLink) {
    const url = new URL(overviewLink.href, location.href);
    if (url.protocol === "https:" && url.hostname === "ad.alimama.com") overviewHref = url.href;
  }
  const inputs = [...document.querySelectorAll("input")].filter(visible)
    .filter((element) => /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(element.value || ""))
    .map((element) => ({ value: element.value, readOnly: element.readOnly }));
  const ranges = [...text.matchAll(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(?:至|~|～|—|到|\s-\s)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/g)]
    .map((match) => [match[1], match[2]]);
  return {
    ok: true,
    overview: /推广概览/.test(text) && /数据汇总/.test(text),
    overviewHref,
    overviewPoint: point(exact("推广概览")[0]),
    downloadPoint: point(exact("下载报表")[0]),
    downloadCount: new Set(exact("下载报表").map((element) => JSON.stringify(point(element))).filter(Boolean)).size,
    yesterdayPoint: point(exact("昨日")[0]),
    customPoint: point(exact("自定义")[0]),
    inputs,
    ranges,
    busy: [...document.querySelectorAll('[aria-busy="true"],.ant-spin-spinning,.next-loading')].some(visible),
  };
}

// Observed on 2026-10-16: readonly Mux RangePicker, real export dialog,
// radio values 1/0 (分天/汇总), 105/96 (计划/店铺). Never force readonly values.
function inspectTaokeExport(request = {}) {
  const visible = (element) => {
    if (!element) return false;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden"
      && style.display !== "none" && !element.closest('[aria-hidden="true"]');
  };
  const compact = (value) => String(value || "").replace(/[\s\uE000-\uF8FF]/g, "");
  const point = (element) => {
    if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") return null;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    return { x, y };
  };
  const exact = (scope, label, selector = 'button,a,[role="tab"],label') =>
    [...scope.querySelectorAll(selector)].find((element) => visible(element) && compact(element.innerText) === label);
  const base = inspectTaokePage();
  if (!base.ok) return base;
  // A banner snapshot is compared in-memory only; it is not an auth secret and
  // is not written to logs or included in a public package.
  const account = document.querySelector('header,[role="banner"],.mm-portal-layout-header')?.innerText?.replace(/\s+/g, " ") || "";
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const dialog = dialogs.find((element) => /下载报表/.test(element.innerText) && /下载记录/.test(element.innerText));
  const picker = [...document.querySelectorAll(".mux-picker-dropdown")].find(visible);
  const result = {
    ...base, account, dialogOpen: Boolean(dialog), calendarOpen: Boolean(picker),
    openPoint: !dialog ? point(exact(document, "下载报表")) : null,
    modalRange: dialog ? {
      start: dialog.querySelector('input[placeholder="开始日期"]')?.value || "",
      end: dialog.querySelector('input[placeholder="结束日期"]')?.value || "",
    } : null,
    startPoint: dialog ? point(dialog.querySelector('input[placeholder="开始日期"]')) : null,
    checkedRadios: dialog ? [...dialog.querySelectorAll('input[type="radio"]:checked')].map((element) => element.value) : [],
    dayPoint: dialog ? point(dialog.querySelector('input[type="radio"][value="1"]')?.closest("label")) : null,
    planPoint: dialog ? point(dialog.querySelector('input[type="radio"][value="105"]')?.closest("label")) : null,
    confirmPoint: dialog && !picker ? point(exact(dialog, "确定")) : null,
    formTabPoint: dialog ? point(exact(dialog, "下载报表")) : null,
    recordTabPoint: dialog ? point(exact(dialog, "下载记录")) : null,
    closePoint: dialog ? point(exact(dialog, "关闭")) : null,
  };
  if (picker && request.date) {
    const cells = [...picker.querySelectorAll("td[title]")].filter(visible);
    const cell = cells.find((element) => element.title === request.date
      && element.classList.contains("mux-picker-cell-in-view")
      && !element.classList.contains("mux-picker-cell-disabled"));
    const months = [...picker.querySelectorAll(".mux-picker-header-view")].filter(visible).map((element) => {
      const match = /(\d{4})年\s*(\d{1,2})月/.exec(element.innerText.replace(/\s+/g, ""));
      return match ? `${match[1]}-${match[2].padStart(2, "0")}` : "";
    }).filter(Boolean);
    result.calendar = {
      datePoint: point(cell?.querySelector(".mux-picker-cell-inner") || cell),
      months,
      previousPoint: point(picker.querySelector(".mux-picker-header-prev-btn")),
      nextPoint: point([...picker.querySelectorAll(".mux-picker-header-next-btn")].pop()),
    };
  }
  if (dialog && request.range) {
    const expected = `${request.range.start} 00:00:00~${request.range.end} 23:59:59-分天数据-计划/活动类型-推广概览-数据汇总`;
    const rows = [...dialog.querySelectorAll("tbody tr")].filter(visible);
    const row = rows.find((element) => element.innerText.includes(expected));
    result.record = row ? {
      completed: /已完成/.test(row.innerText), failed: /失败/.test(row.innerText),
      downloadPoint: point(exact(row, "下载")),
    } : null;
  }
  return result;
}

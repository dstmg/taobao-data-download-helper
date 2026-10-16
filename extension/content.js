(() => {
  if (window.__TAOBAO_SHOP_DATA_COLLECTOR_OFFICIAL_V6__) return;
  window.__TAOBAO_SHOP_DATA_COLLECTOR_OFFICIAL_V6__ = true;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function candidateElements() {
    const selector = [
      "button",
      "a",
      "input",
      "[role='button']",
      "[role='menuitem']",
      ".sycm-traced-download-text",
      ".sycm-cc-item-rank-download",
      "[class*='download']",
      "[class*='Download']",
      "[class*='export']",
      "[class*='Export']",
      "[class*='date']",
      "[class*='Date']"
    ].join(",");
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

  function getClickPoint(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1)),
      y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)),
    };
  }

  function isDisabled(element) {
    const classes = String(element?.className || "");
    return Boolean(element?.disabled) || element?.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/i.test(classes);
  }

  function clickableAncestor(element) {
    return element?.closest("button,a,[role='button'],[role='menuitem'],[tabindex],.ant-btn,.next-btn,.oui-button,.el-button,.semi-button") || element;
  }

  function compactButtonCandidates(root = document) {
    const selector = [
      "button",
      "a",
      "[role='button']",
      "[role='menuitem']",
      "[tabindex]",
      ".ant-btn",
      ".next-btn",
      ".oui-button",
      ".el-button",
      ".semi-button",
      "[class*='button']",
      "[class*='Button']",
      "[class*='btn']",
      "[class*='Btn']",
    ].join(",");
    const seen = new Set();
    return Array.from(root.querySelectorAll(selector))
      .map(clickableAncestor)
      .filter((element) => {
        if (!element || seen.has(element) || !isVisible(element) || isDisabled(element)) return false;
        seen.add(element);
        const rect = element.getBoundingClientRect();
        return rect.width >= 26 && rect.width <= 260 && rect.height >= 22 && rect.height <= 88;
      });
  }

  function directText(element) {
    return cleanText(element?.innerText || element?.textContent || element?.value || element?.getAttribute("title") || element?.getAttribute("aria-label") || "");
  }

  function findAlimamaDownloadButton() {
    const exactButtons = Array.from(document.querySelectorAll(
      "#universalBP_common_layout_main_content .mxgc-grid .ml20.fr.flex-column button[data-btn$='_btn']"
    ))
      .filter(isVisible)
      .filter((button) => !isDisabled(button))
      .filter((button) => directText(button) === "下载报表")
      .filter((button) => /营销场景数据明细/.test(cleanText(button.closest(".mxgc-grid")?.innerText || "")))
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    if (exactButtons[0]) return exactButtons[0];

    const reportSections = Array.from(document.querySelectorAll("#universalBP_common_layout_main_content .mxgc-grid, .mxgc-grid"))
      .filter(isVisible)
      .filter((section) => /营销场景数据明细/.test(cleanText(section.innerText || "")))
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.top - rectB.top || rectB.width - rectA.width;
      });

    for (const section of reportSections) {
      const sectionRect = section.getBoundingClientRect();
      const candidates = Array.from(section.querySelectorAll("button[data-btn$='_btn'], button"))
        .filter(isVisible)
        .filter((button) => !isDisabled(button))
        .filter((button) => directText(button) === "下载报表")
        .map((button) => {
          const actionHost = button.closest("[mx-click],[data-spm-click]");
          const action = `${actionHost?.getAttribute("mx-click") || ""} ${actionHost?.getAttribute("data-spm-click") || ""}`;
          const rect = button.getBoundingClientRect();
          const inSectionToolbar = rect.left >= sectionRect.left + sectionRect.width * 0.7 && rect.top >= sectionRect.top && rect.top <= sectionRect.top + 140;
          const isDownloadAction = /download|de7d70bee/i.test(action);
          return { button, action, inSectionToolbar, isDownloadAction, rect };
        })
        .filter((item) => item.inSectionToolbar && item.isDownloadAction)
        .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);
      if (candidates[0]?.button) return candidates[0].button;
    }
    return null;
  }

  function visibleDialog() {
    const selector = [
      "[role='dialog']",
      ".ant-modal",
      ".next-dialog",
      ".oui-dialog",
      ".el-dialog",
      ".semi-modal",
      "[class*='modal']",
      "[class*='Modal']",
      "[class*='dialog']",
      "[class*='Dialog']",
    ].join(",");
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .filter((element) => /下载|报表|导出/.test(elementText(element)))
      .sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0] || null;
  }

  function normalizeDateText(value) {
    const match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(value || ""));
    if (!match) return "";
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }

  function findAlimamaDownloadDialog() {
    return Array.from(document.querySelectorAll([
      "[role='dialog']",
      ".ant-modal",
      ".next-dialog",
      ".oui-dialog",
      ".el-dialog",
      ".semi-modal",
      "[class*='modal']",
      "[class*='Modal']",
      "[class*='dialog']",
      "[class*='Dialog']",
    ].join(",")))
      .filter(isVisible)
      .filter((element) => {
        const text = cleanText(element.innerText || "");
        return /下载报表/.test(text) && /日期范围/.test(text) && /时间粒度/.test(text) && /确定/.test(text);
      })
      .sort((a, b) => {
        const zIndex = (element) => Number(getComputedStyle(element).zIndex) || 0;
        return zIndex(b) - zIndex(a) || b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      })[0] || null;
  }

  function findAlimamaConfirmButton(dialog) {
    if (!dialog) return null;
    const dialogRect = dialog.getBoundingClientRect();
    return Array.from(dialog.querySelectorAll("button,[role='button']"))
      .filter(isVisible)
      .filter((element) => !isDisabled(element))
      .filter((element) => directText(element) === "确定")
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= dialogRect.top + dialogRect.height * 0.55 && rect.left >= dialogRect.left;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0] || null;
  }

  function isLikelyLoginPage() {
    const href = String(location.href || "").toLowerCase();
    const pageText = cleanText(document.body?.innerText || "");
    return href.includes("login") || href.includes("passport") || Boolean(document.querySelector("input[type='password']")) ||
      (/登录/.test(pageText) && /账号|密码|验证码|手机号/.test(pageText));
  }

  function currentAlimamaDate() {
    const hash = String(location.hash || "");
    const index = hash.indexOf("?");
    const params = new URLSearchParams(index >= 0 ? hash.slice(index + 1) : "");
    return {
      isReportPage: hash.includes("!/report/account"),
      start: params.get("startTime") || "",
      end: params.get("endTime") || "",
    };
  }

  function localDateOffset(days) {
    const value = new Date();
    value.setDate(value.getDate() + days);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function findExactAlimamaButton(text) {
    return compactButtonCandidates()
      .filter((element) => directText(element) === text)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.top <= 420;
      })[0] || null;
  }

  async function locateAlimamaOfficialDownload(date, skipDateShortcut = false) {
    if (isLikelyLoginPage()) return { ok: false, reason: "阿里妈妈未登录，请先在当前 Chrome 窗口登录" };
    const current = currentAlimamaDate();
    if (!current.isReportPage || current.start !== date || current.end !== date) {
      return { ok: false, reason: `阿里妈妈页面日期不是 ${date}` };
    }
    if (!skipDateShortcut && date === localDateOffset(-1)) {
      const shortcut = findExactAlimamaButton("昨日") || findExactAlimamaButton("昨天");
      if (shortcut) {
        return { ok: true, dateShortcutClickPoint: getClickPoint(shortcut), label: elementText(shortcut) };
      }
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const button = findAlimamaDownloadButton();
      if (button) {
        return {
          ok: true,
          clickPoint: getClickPoint(button),
          label: elementText(button) || "下载报表",
        };
      }
      await sleep(700);
    }
    return { ok: false, reason: "阿里妈妈页面加载 30 秒后仍未找到官方“下载报表”按钮" };
  }

  async function locateAlimamaDownloadConfirmation(date) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const dialog = findAlimamaDownloadDialog();
      if (dialog) {
        const dialogText = cleanText(dialog.innerText || "");
        const dialogDate = normalizeDateText(dialogText);
        if (dialogDate !== date) {
          return { ok: false, reason: `下载弹窗日期是 ${dialogDate || "未识别"}，不是目标日期 ${date}` };
        }
        const button = findAlimamaConfirmButton(dialog);
        if (!button) return { ok: false, reason: "下载弹窗中未找到“确定”按钮" };
        return { ok: true, clickPoint: getClickPoint(button), label: directText(button), dialogDate };
      }
      await sleep(350);
    }
    return { ok: false, reason: "点击下载报表后 7 秒内未出现对应的下载弹窗" };
  }

  function findByText(texts) {
    const wanted = texts.map(cleanText).filter(Boolean);
    const scored = candidateElements()
      .map((element) => {
        const text = elementText(element);
        let score = 0;
        for (const target of wanted) {
          if (text === target) score += 100;
          else if (text.includes(target)) score += 60;
        }
        const classes = String(element.className || "");
        if (/download|export|date|picker|导出|下载|日期/i.test(classes)) score += 10;
        return { element, text, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  function findBySelectors(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (isVisible(element)) return { element, text: elementText(element), score: 120 };
    }
    return null;
  }

  async function humanClick(element) {
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    await sleep(450);
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width - 1, Math.max(1, rect.width / 2));
    const y = rect.top + Math.min(rect.height - 1, Math.max(1, rect.height / 2));
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    element.dispatchEvent(new MouseEvent("mousemove", options));
    await sleep(120);
    element.dispatchEvent(new MouseEvent("mousedown", options));
    await sleep(160);
    element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options));
  }

  async function clickAny({ selectors = [], texts = [], waitMs = 12000, label = "按钮", required = true }) {
    const deadline = Date.now() + waitMs;
    let lastText = "";
    while (Date.now() < deadline) {
      const found = selectors.length ? findBySelectors(selectors) : null;
      const target = found || findByText(texts);
      if (target?.element) {
        await humanClick(target.element);
        return { ok: true, label, text: target.text || elementText(target.element) || label };
      }
      lastText = cleanText(document.body?.innerText || "").slice(0, 180);
      await sleep(700);
    }
    return { ok: !required, label, reason: `没有找到${label}`, sample: lastText };
  }

  function localYesterday() {
    const date = new Date(Date.now() - 24 * 60 * 60 * 1000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function dayNumber(date) {
    return String(Number(String(date || "").slice(-2)));
  }

  function slashDate(date) {
    return String(date || "").replace(/-/g, "/");
  }

  function yearOf(date) {
    return Number(String(date || "").slice(0, 4));
  }

  function monthOf(date) {
    return Number(String(date || "").slice(5, 7));
  }

  function visibleElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }

  function compactElementScore(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function findCompactTextElement(match, selectors = "button,a,span,div,label") {
    return visibleElements(selectors)
      .map((element) => ({ element, text: elementText(element), area: compactElementScore(element) }))
      .filter((item) => item.text && match(item.text, item.element))
      .filter((item) => item.area > 0 && item.area < 80000)
      .sort((a, b) => a.area - b.area)[0]?.element || null;
  }

  function visibleCalendarRoots() {
    const selectors = [
      ".oui-date-picker-menu-ebase-v2",
      ".oui-date-picker-period-panel",
      ".ant-picker-dropdown",
      ".next-overlay-wrapper",
      ".next-date-picker-panel",
      "[class*='date-picker'][class*='panel']",
      "[class*='calendar']"
    ].join(",");
    const roots = visibleElements(selectors);
    return roots.length ? roots : [document.body];
  }

  function calendarContainsTargetMonth(date) {
    const year = `${yearOf(date)}年`;
    const month = `${monthOf(date)}月`;
    return visibleCalendarRoots().some((root) => {
      const text = cleanText(root.innerText || "");
      return text.includes(year) && text.includes(month);
    });
  }

  async function clickCalendarMonthButton(direction) {
    const selectorMap = {
      prev: [
        ".oui-dt-calendar-prev-month-btn",
        ".ant-picker-header-prev-btn",
        ".next-icon-arrow-left",
        "[class*='prev']",
        "[aria-label*='Previous']"
      ],
      next: [
        ".oui-dt-calendar-next-month-btn",
        ".ant-picker-header-next-btn",
        ".next-icon-arrow-right",
        "[class*='next']",
        "[aria-label*='Next']"
      ],
    };
    for (const selector of selectorMap[direction] || []) {
      const found = visibleElements(selector)[0];
      if (found) {
        await humanClick(found);
        await sleep(700);
        return true;
      }
    }
    return false;
  }

  async function moveCalendarToMonth(date) {
    if (calendarContainsTargetMonth(date)) return true;
    const target = yearOf(date) * 12 + monthOf(date);
    for (let index = 0; index < 14; index += 1) {
      const rootsText = visibleCalendarRoots().map((root) => cleanText(root.innerText || "")).join(" ");
      const match = rootsText.match(/(\d{4})年\s*(\d{1,2})月/);
      if (!match) break;
      const current = Number(match[1]) * 12 + Number(match[2]);
      if (current === target) return true;
      const moved = await clickCalendarMonthButton(current < target ? "next" : "prev");
      if (!moved) break;
      if (calendarContainsTargetMonth(date)) return true;
    }
    return calendarContainsTargetMonth(date);
  }

  function findCalendarDayElement(date) {
    const day = dayNumber(date);
    const roots = visibleCalendarRoots();
    for (const root of roots) {
      const cells = Array.from(root.querySelectorAll("td,button,span,div,[role='gridcell']"))
        .filter(isVisible)
        .map((element) => ({ element, text: cleanText(element.innerText || element.textContent || ""), classes: String(element.className || "") }))
        .filter((item) => item.text === day)
        .filter((item) => !/disabled|unavailable|prev|next|other|outside/i.test(item.classes))
        .sort((a, b) => compactElementScore(a.element) - compactElementScore(b.element));
      if (cells[0]?.element) return cells[0].element;
    }
    return null;
  }

  async function openSycmDatePicker(date) {
    const dayMode = findCompactTextElement((text) => text === "日", "button,a,span,div");
    if (dayMode) {
      await humanClick(dayMode);
      await sleep(600);
    }

    const currentDateText = findCompactTextElement(
      (text) => /统计时间|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text),
      "button,a,span,div,label"
    );
    if (currentDateText) {
      await humanClick(currentDateText);
      await sleep(900);
      return true;
    }

    const opened = await clickAny({
      selectors: [
        ".oui-date-picker",
        ".oui-date-picker-trigger",
        ".ant-picker",
        ".next-date-picker",
        "[class*='date-picker']",
        "[class*='DatePicker']"
      ],
      texts: [slashDate(date), date, "统计时间", "日期", "时间"],
      label: "日期控件",
      waitMs: 2500,
      required: false,
    });
    return opened.ok;
  }

  async function chooseSycmProductDate(date) {
    const steps = [];
    const opened = await openSycmDatePicker(date);
    if (!opened) {
      steps.push({ ok: false, label: "日期控件", reason: "没有找到商品页日期控件" });
      return steps;
    }
    steps.push({ ok: true, label: "日期控件", text: "已打开日期控件" });
    await moveCalendarToMonth(date);
    const day = findCalendarDayElement(date);
    if (!day) {
      steps.push({ ok: false, label: "日期数字", reason: `没有找到 ${date} 对应的日期数字` });
      return steps;
    }
    await humanClick(day);
    steps.push({ ok: true, label: "日期数字", text: `已选择 ${date}` });
    await sleep(2800);
    return steps;
  }

  async function setNativeInputs(date) {
    const inputs = Array.from(document.querySelectorAll("input")).filter(isVisible);
    let changed = 0;
    for (const input of inputs) {
      const type = String(input.type || "").toLowerCase();
      const hint = elementText(input);
      if (type === "date" || /日期|时间|开始|结束|date|time/i.test(hint)) {
        input.focus();
        input.value = type === "date" ? date : slashDate(date);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        changed += 1;
      }
    }
    return changed;
  }

  async function clickDatePicker(date) {
    const steps = [];
    const yesterday = localYesterday();
    if (date === yesterday) {
      const quick = await clickAny({
        texts: ["昨日", "昨天"],
        label: "昨日按钮",
        waitMs: 1800,
        required: false,
      });
      if (quick.ok) {
        steps.push(quick);
        await sleep(1200);
        return steps;
      }
    }

    const opened = await clickAny({
      selectors: [
        ".oui-date-picker",
        ".oui-date-picker-trigger",
        ".ant-picker",
        ".next-date-picker",
        "[class*='date-picker']",
        "[class*='DatePicker']"
      ],
      texts: [slashDate(date), date, "日期", "时间", "日", "昨日"],
      label: "日期控件",
      waitMs: 2200,
      required: false,
    });
    if (opened.ok) {
      steps.push(opened);
      await sleep(1000);
      const day = await clickAny({
        texts: [dayNumber(date), slashDate(date), date],
        label: "日期数字",
        waitMs: 2600,
        required: false,
      });
      if (day.ok) steps.push(day);
      const confirm = await clickAny({
        texts: ["确定", "确认", "应用"],
        label: "日期确定按钮",
        waitMs: 1800,
        required: false,
      });
      if (confirm.ok) steps.push(confirm);
    }
    return steps;
  }

  async function applyDate(date) {
    const steps = [];
    const changedInputs = await setNativeInputs(date);
    if (changedInputs) {
      steps.push({ ok: true, label: "日期输入框", text: `已写入 ${changedInputs} 个日期输入框` });
      await sleep(1000);
    }
    const pickerSteps = await clickDatePicker(date);
    steps.push(...pickerSteps);
    return steps;
  }

  async function runSycmProductDownload(date) {
    const steps = await chooseSycmProductDate(date);
    steps.push(await clickAny({
      selectors: [
        "a.sycm-cc-item-rank-download",
        ".sycm-cc-item-rank-download",
        ".sycm-traced-download-text",
        "a[class*='download']",
        "button[class*='download']"
      ],
      texts: ["下载", "导出", "下载数据", "导出数据", "下载报表"],
      label: "生意参谋下载按钮",
      waitMs: 18000
    }));
    const failed = steps.find((step) => !step.ok);
    return {
      ok: !failed,
      summary: steps.filter((step) => step.ok).map((step) => `已点击/执行 ${step.text}`).join("，"),
      reason: failed?.reason,
      steps
    };
  }

  async function runSycmStoreDownload(date) {
    const steps = await applyDate(date);
    const result = await clickAny({
      selectors: [
        "a[class*='download']",
        "button[class*='download']",
        "a[class*='export']",
        "button[class*='export']"
      ],
      texts: ["下载", "导出", "下载数据", "导出数据", "下载报表", "导出报表"],
      label: "生意参谋店铺下载按钮",
      waitMs: 16000
    });
    steps.push(result);
    return {
      ok: result.ok,
      summary: result.ok ? steps.filter((step) => step.ok).map((step) => `已点击/执行 ${step.text}`).join("，") : "",
      reason: result.ok ? "" : "当前生意参谋页面未找到官方店铺下载入口，需要切到店铺日报/交易分析导出页后再点击。",
      steps
    };
  }

  async function runAlimamaDownload(date) {
    const steps = await applyDate(date);
    steps.push(await clickAny({
      texts: ["下载报表", "下载", "导出报表", "导出"],
      selectors: [
        "button[class*='download']",
        "a[class*='download']",
        "button[class*='export']",
        "a[class*='export']"
      ],
      label: "阿里妈妈下载报表按钮",
      waitMs: 22000
    }));
    await sleep(1200);
    const confirm = await clickAny({
      texts: ["确定", "确认", "立即下载", "下载"],
      label: "确认下载按钮",
      waitMs: 4500,
      required: false,
    });
    if (confirm.ok) steps.push(confirm);
    const failed = steps.find((step) => !step.ok);
    return {
      ok: !failed,
      summary: steps.filter((step) => step.ok).map((step) => `已点击/执行 ${step.text}`).join("，"),
      reason: failed?.reason,
      steps
    };
  }

  async function runFlow(flow, date) {
    if (flow === "sycm_product_download") return runSycmProductDownload(date);
    if (flow === "sycm_store_download") return runSycmStoreDownload(date);
    if (flow === "alimama_paid_download" || flow === "alimama_scene_download" || flow === "alimama_item_download") {
      return { ok: false, reason: "阿里妈妈推广下载由后台精确定位执行，不使用页面通用点击" };
    }
    return { ok: false, reason: `未知采集流程：${flow}` };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "TAOBAO_COLLECTOR_PING") {
      sendResponse({ ok: true, version: "official-download-v6" });
      return true;
    }
    if (message?.type === "TAOBAO_COLLECTOR_V5_LOCATE_PAID_DOWNLOAD") {
      locateAlimamaOfficialDownload(message.date, Boolean(message.skipDateShortcut))
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, reason: error.message }));
      return true;
    }
    if (message?.type === "TAOBAO_COLLECTOR_V5_LOCATE_PAID_CONFIRMATION") {
      locateAlimamaDownloadConfirmation(message.date)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, reason: error.message }));
      return true;
    }
    if (message?.type === "TAOBAO_COLLECTOR_RUN_FLOW") {
      runFlow(message.flow, message.date)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, reason: error.message }));
      return true;
    }
    if (message?.type === "TAOBAO_PRODUCT_CURRENT_PAGE_DOWNLOAD") {
      runSycmProductDownload(message.date)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, reason: error.message }));
      return true;
    }
    return false;
  });
})();

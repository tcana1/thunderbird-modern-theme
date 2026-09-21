"use strict";

/*
 * Small DOM touch-ups for the Day / Week calendar views that CSS alone can't
 * do. Each one only adds an attribute or a tiny element; all the styling stays
 * in userChrome.css, so if this extension stops working the theme still looks
 * fine.
 *
 *  1. data-same-start on events that start at the same time, so the CSS can
 *     lay them out side by side instead of in a cascade.
 *  2. A time label ("14:00 – 18:00") at the top of each event card.
 *  3. The "now" line, which Thunderbird draws only in today's column, is
 *     repeated across every column of the week.
 */

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const MAIN_WINDOW = "chrome://messenger/content/messenger.xhtml";
const XHTML = "http://www.w3.org/1999/xhtml";
const DEBOUNCE_MS = 30;

const SAME_START_ATTR = "data-same-start";
const SHORT_ATTR = "data-short";
const NOW_LINE_ATTR = "data-now-line";
const TIME_CLASS = "ui-fixes-time";
// Cards shorter than this (px) get the time on the same line as the title.
const SHORT_CARD_PX = 40;

const VERTICAL_GRID = ".multiday-grid:not(.multiday-grid-rotated)";

// window -> { observer, timer }
const windows = new Map();

function markSameStart(doc) {
  for (const list of doc.querySelectorAll("calendar-event-column .multiday-events-list")) {
    const items = Array.from(list.children);
    // Only the vertical (Day / Week) layout is handled; the rotated one has no cascade.
    const rotated = !!list.closest(".multiday-grid-rotated");

    const counts = new Map();
    for (const item of items) {
      const start = item.style.insetBlockStart;
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }

    for (const item of items) {
      const start = item.style.insetBlockStart;
      const shared = !rotated && start && counts.get(start) > 1;
      if (shared && !item.hasAttribute(SAME_START_ATTR)) {
        item.setAttribute(SAME_START_ATTR, "true");
      } else if (!shared && item.hasAttribute(SAME_START_ATTR)) {
        item.removeAttribute(SAME_START_ATTR);
      }
    }
  }
}

function timeText(box) {
  const item = box.occurrence;
  if (!item) {
    return "";
  }
  const tz = box.calendarView?.timezone ?? cal.dtz.defaultTimezone;
  // Tasks show up in the same boxes, with entry / due dates instead.
  const start = (item.startDate ?? item.entryDate)?.getInTimezone(tz);
  const end = (item.endDate ?? item.dueDate)?.getInTimezone(tz);
  return cal.dtz.formatter.formatTimeInterval(start, end);
}

function updateTimeLabels(doc) {
  for (const box of doc.querySelectorAll(
    "calendar-event-column .multiday-events-list > li > calendar-event-box"
  )) {
    const container = box.querySelector(".calendar-item-container");
    if (!container) {
      continue;
    }

    let label = container.querySelector(`:scope > .${TIME_CLASS}`);
    if (!label) {
      label = doc.createElementNS(XHTML, "div");
      label.className = TIME_CLASS;
      container.prepend(label);
    }

    const text = timeText(box);
    if (label.textContent !== text) {
      label.textContent = text;
    }

    const short = parseFloat(box.parentNode.style.height) < SHORT_CARD_PX;
    if (short !== container.hasAttribute(SHORT_ATTR)) {
      container.toggleAttribute(SHORT_ATTR, short);
    }
  }
}

function syncNowLine(doc) {
  for (const grid of doc.querySelectorAll(VERTICAL_GRID)) {
    const today = grid.querySelector(".day-column-today calendar-event-column .timeIndicator");
    const todayShown = !!today && !today.hasAttribute("hidden");

    for (const indicator of grid.querySelectorAll("calendar-event-column .timeIndicator")) {
      if (indicator === today) {
        continue;
      }
      if (todayShown) {
        // Thunderbird positions today's bar with a margin; copy it.
        if (indicator.style.marginBlockStart !== today.style.marginBlockStart) {
          indicator.style.marginBlockStart = today.style.marginBlockStart;
        }
        indicator.removeAttribute("hidden");
        indicator.setAttribute(NOW_LINE_ATTR, "true");
      } else if (indicator.hasAttribute(NOW_LINE_ATTR)) {
        hideNowLine(indicator);
      }
    }
  }
}

function hideNowLine(indicator) {
  indicator.style.marginBlockStart = "";
  indicator.setAttribute("hidden", "true");
  indicator.removeAttribute(NOW_LINE_ATTR);
}

function refresh(doc) {
  markSameStart(doc);
  updateTimeLabels(doc);
  syncNowLine(doc);
}

function attach(window) {
  const target = window.document.getElementById("calendarContent");
  if (!target || windows.has(window)) {
    return;
  }

  const entry = { observer: null, timer: null };
  const schedule = () => {
    if (entry.timer) {
      return;
    }
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      try {
        refresh(window.document);
      } catch (ex) {
        console.error("calendar-ui-fixes:", ex);
      }
    }, DEBOUNCE_MS);
  };

  // TB lays events out by setting an inline style on each item, and toggles
  // "hidden" on the now bars, so watch both, plus items coming and going.
  entry.observer = new window.MutationObserver(schedule);
  entry.observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "hidden"],
  });
  windows.set(window, entry);
  schedule();
}

function detach(window) {
  const entry = windows.get(window);
  if (!entry) {
    return;
  }
  entry.observer.disconnect();
  if (entry.timer) {
    window.clearTimeout(entry.timer);
  }
  windows.delete(window);

  const doc = window.document;
  for (const item of doc.querySelectorAll(`[${SAME_START_ATTR}]`)) {
    item.removeAttribute(SAME_START_ATTR);
  }
  for (const item of doc.querySelectorAll(`[${SHORT_ATTR}]`)) {
    item.removeAttribute(SHORT_ATTR);
  }
  for (const label of doc.querySelectorAll(`.${TIME_CLASS}`)) {
    label.remove();
  }
  for (const indicator of doc.querySelectorAll(`[${NOW_LINE_ATTR}]`)) {
    hideNowLine(indicator);
  }
}

var calendarUIFixes = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    ExtensionSupport.registerWindowListener(this.extension.id, {
      chromeURLs: [MAIN_WINDOW],
      onLoadWindow: attach,
      onUnloadWindow: detach,
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    ExtensionSupport.unregisterWindowListener(this.extension.id);
    for (const window of Array.from(windows.keys())) {
      detach(window);
    }
  }

  getAPI() {
    return { calendarUIFixes: {} };
  }
};

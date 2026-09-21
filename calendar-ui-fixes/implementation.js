"use strict";

/*
 * Small DOM touch-ups for the Day / Week calendar views that CSS alone can't
 * do. Each one only adds an attribute or a tiny element; all the styling stays
 * in userChrome.css, so if this extension stops working the theme still looks
 * fine.
 *
 *  1. data-same-start on events that start at (almost) the same time, meaning
 *     a later one would land on top of the earlier one's text, so the CSS can
 *     lay them out side by side instead of in a cascade.
 *  2. A time label ("14:00 – 18:00") at the top of each event card.
 *  3. The "now" line, which Thunderbird draws only in today's column, is
 *     repeated across every column of the week.
 *  4. Titles of cards that a later event starts on top of are clamped to the
 *     lines that fit above that event (data-clamp / --title-lines), so the
 *     texts don't run into each other.
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
const CLAMP_ATTR = "data-clamp";
const CLAMP_VAR = "--title-lines";
const TIME_CLASS = "ui-fixes-time";
// Cards shorter than this (px) get the time on the same line as the title.
const SHORT_CARD_PX = 40;

const VERTICAL_GRID = ".multiday-grid:not(.multiday-grid-rotated)";

// window -> { observer, timer }
const windows = new Map();

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

/**
 * Decide, for the cards of one column, which ones go side by side and how many
 * title lines the others can show. Pure, so it is easy to reason about.
 *
 * @param {{top: number, height: number, need: number}[]} cards - Position and
 *   height in px, and `need`, the px from the card's top that its time and one
 *   line of title take.
 * @returns {{sideBySide: boolean, room: number|null}[]} - `room` is the px
 *   above the first later card that overlaps this one (null if none).
 */
function planCards(cards) {
  return cards.map(card => {
    // A neighbour that starts before the earlier card's text is done would
    // cover it, so those two share the width instead.
    const sideBySide = cards.some(other => {
      if (other === card) {
        return false;
      }
      const [first, second] = card.top <= other.top ? [card, other] : [other, card];
      const gap = second.top - first.top;
      return gap === 0 || gap < first.need;
    });

    // Later cards that cascade over this one, past its text.
    const covers = cards
      .filter(o => o.top - card.top >= card.need && o.top < card.top + card.height)
      .map(o => o.top - card.top);
    return { sideBySide, room: covers.length ? Math.min(...covers) : null };
  });
}

function layoutCards(doc) {
  const view = doc.defaultView;

  for (const list of doc.querySelectorAll("calendar-event-column .multiday-events-list")) {
    const rotated = !!list.closest(".multiday-grid-rotated");
    // Nothing to measure while the calendar isn't on screen.
    if (!list.getBoundingClientRect().height) {
      continue;
    }

    const cards = Array.from(list.children, li => ({
      li,
      box: li.querySelector("calendar-event-box"),
      top: parseFloat(li.style.insetBlockStart),
      height: parseFloat(li.style.height),
    })).filter(c => c.box && Number.isFinite(c.top) && Number.isFinite(c.height));

    // Read phase: how much room each card's time and first title line take.
    for (const card of cards) {
      const label = card.box.querySelector(".event-name-label");
      if (!label || rotated) {
        card.need = 0;
        card.lineHeight = 0;
        card.labelTop = 0;
        continue;
      }
      const style = view.getComputedStyle(label);
      card.lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.25;
      card.labelTop = label.getBoundingClientRect().top - card.box.getBoundingClientRect().top;
      card.need = card.labelTop + card.lineHeight + 2;
    }

    const plan = rotated ? cards.map(() => ({ sideBySide: false, room: null })) : planCards(cards);

    // Write phase.
    cards.forEach((card, i) => {
      const { sideBySide, room } = plan[i];
      if (sideBySide !== card.li.hasAttribute(SAME_START_ATTR)) {
        card.li.toggleAttribute(SAME_START_ATTR, sideBySide);
      }

      const { box } = card;
      if (room === null) {
        if (box.hasAttribute(CLAMP_ATTR)) {
          box.removeAttribute(CLAMP_ATTR);
          box.style.removeProperty(CLAMP_VAR);
        }
        return;
      }
      const lines = Math.max(1, Math.floor((room - card.labelTop - 2) / card.lineHeight));
      if (box.style.getPropertyValue(CLAMP_VAR) !== String(lines)) {
        box.style.setProperty(CLAMP_VAR, String(lines));
      }
      if (!box.hasAttribute(CLAMP_ATTR)) {
        box.setAttribute(CLAMP_ATTR, "true");
      }
    });
  }
}

function refresh(doc) {
  updateTimeLabels(doc);
  syncNowLine(doc);
  layoutCards(doc);
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
  for (const box of doc.querySelectorAll(`[${CLAMP_ATTR}]`)) {
    box.removeAttribute(CLAMP_ATTR);
    box.style.removeProperty(CLAMP_VAR);
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

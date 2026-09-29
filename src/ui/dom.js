/**
 * ui/dom.js — DOM UI framework for HOLDOUT (no framework, no virtual DOM).
 *
 * Responsibility: the `h()` element builder, the `#ui` overlay root with its
 * stacked layers, and every reusable widget: buttons (with haptic tap + double-
 * fire protection), toasts, banner, screen flash, modals (stackable, Escape /
 * hardware-back aware), a single drag-to-dismiss bottom sheet, confirm(), and
 * data widgets (progress, pill, row, tabs, stat, icon). `ui.bind()` re-renders
 * an element on every bus 'state:changed', coalesced per frame and capped at 10 Hz.
 *
 * Public API:
 *   h(tag, attrs, ...children) → HTMLElement
 *   ui = { root, mount, unmount, layer, press, btn, icon, toast, banner, flash, modal,
 *          confirm, sheet, setScreen, closeAll, bind, progress, pill, row, tabs, stat }
 * While a banner is shown, #ui carries class `has-banner` and the custom property
 * `--banner-h` (its full height incl. safe-top, 0px otherwise) so HUD elements can pad.
 * Styling lives in theme.css (tokens) and components.css (widgets).
 * Integration notes: styles.css must set `html, body { position: fixed; inset: 0; overflow: hidden }`
 * so the document itself can never scroll (sheet/modal bodies guard the iOS < 16 scroll-through
 * themselves); the integrator toggles `body.low-fx` from stage.setQuality('medium'|'low') and
 * `body.reduced-motion` from G.settings.reducedMotion (both hooks live in theme.css).
 */

import { haptics } from '../core/haptics.js';
import { bus } from '../core/events.js';

/** Pointer travel (css px) after which a press is treated as a scroll/drag, not a tap. */
const PRESS_SLOP = 12;
/** Window after a pointer-driven activation during which its trailing (ghost) click is ignored. */
const CLICK_SUPPRESS_MS = 700;
/** Distance (css px) within which a trusted click after a press counts as its ghost click (iOS re-hit-tests). */
const CLICK_SUPPRESS_RADIUS = 24;
/** Minimum interval between bind() refreshes (contract §11: DOM refresh max 10 Hz). */
const BIND_MIN_INTERVAL = 100;
/** Must match --d-fast / --d-med / --d-sheet in theme.css (ms). */
const D_FAST = 140;
const D_MED = 220;
const D_SHEET = 260;
const TOAST_MAX = 3;
const TOAST_DUR = 2200;
const FLASH_MS = 200;
/** Fraction of sheet height dragged past which release dismisses it. */
const SHEET_DISMISS_FRAC = 0.3;
/** Downward velocity (px/ms) past which a fling dismisses the sheet regardless of distance. */
const SHEET_FLING_V = 0.55;
const SHEET_RUBBER_MAX = 36;

const loggedErrors = new Set();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Logs an error once per unique key so hot paths never spam the console. */
function warnOnce(key, err) {
  if (loggedErrors.has(key)) return;
  if (loggedErrors.size < 128) loggedErrors.add(key);
  if (typeof console !== 'undefined' && console.warn) console.warn('[ui] ' + key, err);
}

/** Runs `fn` guarded; UI callbacks must never break the caller. */
function safeCall(fn, key, ...args) {
  try {
    return fn(...args);
  } catch (err) {
    warnOnce(key + ': ' + (err && err.message ? err.message : String(err)), err);
    return undefined;
  }
}

/**
 * Fires haptics 'tap' without ever throwing (haptics may be absent in tests).
 * @returns {boolean} true when the pattern was dispatched
 */
function playTap() {
  try {
    if (haptics && typeof haptics.play === 'function') return haptics.play('tap') === true;
  } catch (err) {
    warnOnce('haptics.play failed', err);
  }
  return false;
}

/** requestAnimationFrame with a setTimeout fallback (jsdom / hidden tabs). */
function nextFrame(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 16);
}

/**
 * Commits a freshly inserted element's initial styles (one forced layout) and then runs `fn`,
 * so the transition class it adds animates from the resting state. Synchronous on purpose:
 * rAF can stall for whole seconds on a busy phone and overlays must never appear late.
 */
function afterInsert(el, fn) {
  void el.offsetWidth;
  fn();
}

// ---------------------------------------------------------------------------
// h()
// ---------------------------------------------------------------------------

const isNode = (v) => typeof Node !== 'undefined' && v instanceof Node;

/** Appends string | Node | array | null/false children to `el`. */
function appendChildren(el, children) {
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (isNode(c)) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Applies a style object ({ camelCase or 'kebab-case': value }) or string to an element. */
function applyStyle(el, style) {
  if (typeof style === 'string') {
    el.style.cssText = style;
    return;
  }
  for (const key in style) {
    const v = style[key];
    if (v === null || v === undefined) continue;
    if (key.indexOf('-') >= 0) el.style.setProperty(key, String(v));
    else el.style[key] = v;
  }
}

/** Applies the attrs map of h() to an element. */
function applyAttrs(el, attrs) {
  for (const key in attrs) {
    const v = attrs[key];
    if (v === null || v === undefined || v === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
    } else if (key === 'style') {
      applyStyle(el, v);
    } else if (key === 'dataset') {
      for (const d in v) if (v[d] !== null && v[d] !== undefined) el.dataset[d] = String(v[d]);
    } else if (key === 'html') {
      el.innerHTML = String(v);
    } else if (key === 'ref') {
      if (typeof v === 'function') v(el);
    } else if (key.length > 2 && key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      el[key] = v;
    } else if (v === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(v));
    }
  }
}

/**
 * Builds a DOM element.
 * @param {string} tag
 * @param {Object|null} [attrs] `class`/`className`, `style` (object|string), `on<Event>` handlers,
 *   `dataset` (object), `html` (trusted innerHTML), `ref(el)`, any other key as an attribute.
 * @param {...(string|Node|Array|null|boolean)} children nested arrays are flattened; null/false skipped
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag || 'div');
  if (attrs && typeof attrs === 'object' && !isNode(attrs) && !Array.isArray(attrs)) applyAttrs(el, attrs);
  else if (attrs !== null && attrs !== undefined) children.unshift(attrs);
  appendChildren(el, children);
  return el;
}

// ---------------------------------------------------------------------------
// Root + layers
// ---------------------------------------------------------------------------

let rootEl = null;
const layers = {};

/** Resolves (or creates) the #ui overlay element. */
function getRoot() {
  if (rootEl && rootEl.isConnected) return rootEl;
  rootEl = document.getElementById('ui');
  if (!rootEl) {
    rootEl = h('div', { id: 'ui', 'aria-live': 'polite' });
    (document.body || document.documentElement).appendChild(rootEl);
  }
  return rootEl;
}

/** Returns the named overlay layer (banner|sheet|modal|toast|flash), creating it on first use. */
function getLayer(name) {
  const root = getRoot();
  let layer = layers[name];
  if (!layer || layer.parentNode !== root) {
    layer = h('div', { class: 'ui-layer ui-layer--' + name, dataset: { layer: name } });
    root.appendChild(layer);
    layers[name] = layer;
  }
  return layer;
}

/** Removes an element from the DOM if attached. */
function detach(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// ---------------------------------------------------------------------------
// Press handling (tap without the 300 ms delay, no pointer+click double fire)
// ---------------------------------------------------------------------------

/** The last pointer-driven activation: { t, x, y, target } (null once a new pointer goes down). */
let lastActivation = null;
let clickGuardInstalled = false;

/** True when `click` is the trailing ghost of the recorded press (same element, or under the finger). */
function isGhostClick(e) {
  const a = lastActivation;
  if (!a || now() - a.t >= CLICK_SUPPRESS_MS) return false;
  const target = e.target;
  if (target === a.target || (a.target && a.target.contains && a.target.contains(target))) return true;
  return Math.abs(e.clientX - a.x) <= CLICK_SUPPRESS_RADIUS && Math.abs(e.clientY - a.y) <= CLICK_SUPPRESS_RADIUS;
}

/**
 * Installs one capture-phase click listener that swallows only the ghost click of a press:
 * a trusted, pointer-originated click (`detail !== 0`) arriving inside #ui within 700 ms of a
 * press-managed pointerup, on the pressed element or within 24 px of the release point (where
 * iOS Safari re-hit-tests the synthesized click after the DOM changed under the finger, e.g.
 * a fresh backdrop or a modal button). Any new pointerdown clears the record, so a second tap
 * on a plain `h('button', { onClick })` or a native checkbox fires normally. Untrusted clicks
 * (the haptics switch trick) and keyboard activations (`detail === 0`) always pass.
 */
function installClickGuard() {
  if (clickGuardInstalled || typeof document === 'undefined') return;
  clickGuardInstalled = true;
  document.addEventListener('pointerdown', () => { lastActivation = null; }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || e.detail === 0 || !lastActivation) return;
    if (!rootEl || !rootEl.contains(e.target)) return;
    if (!isGhostClick(e)) return;
    lastActivation = null;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/**
 * Makes `el` activate on pointer release (touch-friendly, cancels on scroll/slop); the
 * synthetic click that follows is swallowed by the document guard so handlers fire exactly
 * once. Keyboard activation still arrives through 'click' unless `clickFallback` is false.
 * The tap haptic plays on pointerdown (native feel); when that call could not run (throttled,
 * or the iOS switch trick needs a user activation the down event did not grant) it is retried
 * on release. A press cancelled by slop has therefore already buzzed, as native controls do.
 * @param {HTMLElement} el
 * @param {(e: Event) => void} onActivate
 * @param {{ pressedClass?: string|null, haptic?: boolean, clickFallback?: boolean }} [opts]
 */
function attachPress(el, onActivate, opts = {}) {
  const pressedClass = opts.pressedClass === undefined ? 'btn--pressed' : opts.pressedClass;
  const haptic = opts.haptic !== false;
  const clickFallback = opts.clickFallback !== false;
  let active = false;
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  /** Whether the pointerdown haptic was dispatched (else pointerup retries it). */
  let buzzed = false;
  installClickGuard();

  const disabled = () => el.disabled || el.getAttribute('aria-disabled') === 'true';

  function setPressed(on) {
    if (pressedClass) el.classList.toggle(pressedClass, on);
  }

  function cancel(e) {
    if (!active || (e && e.pointerId !== undefined && e.pointerId !== pointerId)) return;
    active = false;
    setPressed(false);
  }

  function fire(e) {
    if (disabled()) return;
    safeCall(onActivate, 'press handler', e);
  }

  el.addEventListener('pointerdown', (e) => {
    if (active || disabled() || (e.button && e.button !== 0)) return;
    active = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    setPressed(true);
    buzzed = haptic ? playTap() : true;
  });
  el.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== pointerId) return;
    if (Math.abs(e.clientX - startX) > PRESS_SLOP || Math.abs(e.clientY - startY) > PRESS_SLOP) cancel(e);
  });
  el.addEventListener('pointerup', (e) => {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    setPressed(false);
    lastActivation = { t: now(), x: e.clientX, y: e.clientY, target: el };
    if (!buzzed && !disabled()) playTap();
    fire(e);
  });
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  if (clickFallback) el.addEventListener('click', fire);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// Icons + buttons
// ---------------------------------------------------------------------------

/**
 * Wraps a data-URL (or an existing node) as an icon element.
 * @param {string|Node|null} src data URL, or a Node used as-is
 * @param {number} [size=16] css px
 * @returns {HTMLElement}
 */
function icon(src, size = 16) {
  let el;
  if (isNode(src)) {
    el = src;
    el.classList.add('icon');
  } else if (typeof src === 'string' && src) {
    el = h('img', { class: 'icon', src, alt: '', draggable: 'false', decoding: 'async' });
  } else {
    el = h('span', { class: 'icon icon--missing', 'aria-hidden': 'true' });
  }
  el.style.width = size + 'px';
  el.style.height = size + 'px';
  return el;
}

/**
 * Creates a game button. Plays haptics 'tap' on press and fires `onClick` once per tap.
 * @param {string|Node} label
 * @param {(e: Event) => void} [onClick]
 * @param {{ kind?: 'primary'|'secondary'|'danger'|'ghost'|'icon', icon?: string|Node, size?: 'sm'|'md'|'lg',
 *           disabled?: boolean, class?: string, block?: boolean, haptic?: boolean }} [opts]
 * @returns {HTMLButtonElement} with `.setDisabled(bool)` and `.setLabel(text)` helpers
 */
function btn(label, onClick, opts = {}) {
  const kind = opts.kind || 'secondary';
  const size = opts.size || 'md';
  const classes = ['btn', 'btn--' + kind];
  if (size !== 'md') classes.push('btn--' + size);
  if (opts.block) classes.push('btn--block');
  if (opts.disabled) classes.push('btn--disabled');
  if (opts.class) classes.push(opts.class);

  const el = h('button', { type: 'button', class: classes, 'aria-label': typeof label === 'string' ? label : undefined });
  if (opts.icon) {
    const ic = icon(opts.icon, size === 'lg' ? 22 : size === 'sm' ? 14 : 18);
    ic.classList.add('btn__icon');
    el.appendChild(ic);
  }
  let labelEl = null;
  if (label === null || label === undefined || label === '') {
    labelEl = null;
  } else if (kind !== 'icon') {
    labelEl = h('span', { class: 'btn__label' }, label);
    el.appendChild(labelEl);
  } else if (isNode(label)) {
    el.appendChild(label);
  } else {
    // A text glyph (e.g. '✕') on an icon button: rendered as the icon, not as an uppercase label.
    labelEl = h('span', { class: 'btn__glyph' }, label);
    el.appendChild(labelEl);
  }
  if (opts.disabled) el.disabled = true;

  attachPress(el, (e) => { if (typeof onClick === 'function') onClick(e); }, { haptic: opts.haptic });

  /** Toggles the disabled state (visual + interactive). */
  el.setDisabled = (on) => {
    el.disabled = !!on;
    el.classList.toggle('btn--disabled', !!on);
    return el;
  };
  /** Replaces the label text. */
  el.setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
    return el;
  };
  return el;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/** @type {Array<{el: HTMLElement, close: Function}>} currently visible toasts, oldest first */
const liveToasts = [];
let toastColumn = null;

function getToastColumn() {
  if (!toastColumn || !toastColumn.isConnected) {
    toastColumn = h('div', { class: 'toasts' });
    getLayer('toast').appendChild(toastColumn);
  }
  return toastColumn;
}

/** FLIP-animates siblings of `leaving` into their new positions after `mutate()` runs. */
function flipSiblings(container, leaving, mutate) {
  const items = [];
  for (let i = 0; i < container.children.length; i++) {
    const c = container.children[i];
    if (c !== leaving) items.push(c);
  }
  const before = items.map((c) => c.getBoundingClientRect().top);
  mutate();
  let moved = false;
  for (let i = 0; i < items.length; i++) {
    const d = before[i] - items[i].getBoundingClientRect().top;
    if (Math.abs(d) < 0.5) continue;
    items[i].style.transition = 'none';
    items[i].style.transform = 'translate3d(0,' + d + 'px,0)';
    moved = true;
  }
  if (!moved) return;
  void container.offsetHeight;
  for (let i = 0; i < items.length; i++) {
    items[i].style.transition = '';
    items[i].style.transform = '';
  }
}

/**
 * Shows a stacked toast under the safe area. Max 3 visible; the oldest is pushed out.
 * @param {string|Node} msg
 * @param {{ kind?: 'info'|'ok'|'warn'|'danger', icon?: string|Node, dur?: number }} [opts]
 * @returns {{ el: HTMLElement, close(): void }}
 */
function toast(msg, opts = {}) {
  const kind = opts.kind || 'info';
  const dur = opts.dur === undefined ? TOAST_DUR : opts.dur;
  const column = getToastColumn();
  const lead = opts.icon ? (() => { const ic = icon(opts.icon, 20); ic.classList.add('toast__icon'); return ic; })() : h('span', { class: 'toast__dot' });
  const el = h('div', { class: ['toast', 'toast--' + kind], role: 'status' }, lead, h('div', { class: 'toast__msg' }, msg));

  let closed = false;
  let timer = 0;
  const handle = {
    el,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const i = liveToasts.indexOf(handle);
      if (i >= 0) liveToasts.splice(i, 1);
      flipSiblings(column, el, () => {
        el.style.position = 'absolute';
        el.style.top = el.offsetTop + 'px';
        el.style.left = el.offsetLeft + 'px';
        el.style.width = el.offsetWidth + 'px';
        el.classList.remove('toast--in');
        el.classList.add('toast--out');
      });
      setTimeout(() => detach(el), D_FAST + 20);
    },
  };

  while (liveToasts.length >= TOAST_MAX) liveToasts[0].close();
  liveToasts.push(handle);
  column.appendChild(el);
  afterInsert(el, () => el.classList.add('toast--in'));
  if (dur > 0) timer = setTimeout(handle.close, dur);
  attachPress(el, handle.close, { pressedClass: null, haptic: false });
  return handle;
}

// ---------------------------------------------------------------------------
// Banner + flash
// ---------------------------------------------------------------------------

/** The visible banner element, or null. */
let bannerEl = null;
/** A banner sliding out: { el, timer }. Reused if a new banner is requested before it detaches. */
let bannerOut = null;

/** Publishes the banner height to CSS (`--banner-h`) and toggles `has-banner` on #ui. */
function setBannerHeight(px) {
  const root = getRoot();
  root.style.setProperty('--banner-h', px + 'px');
  root.classList.toggle('has-banner', px > 0);
}

/** Slides the current banner out and detaches it once the transition has finished. */
function hideBanner() {
  const old = bannerEl;
  bannerEl = null;
  old.classList.remove('banner--in');
  const timer = setTimeout(() => {
    detach(old);
    if (bannerOut && bannerOut.el === old) bannerOut = null;
  }, D_MED + 20);
  bannerOut = { el: old, timer };
}

/** Returns a banner element to fill: the outgoing one (slid back in) or a fresh one. */
function acquireBanner() {
  if (bannerOut && bannerOut.el.isConnected) {
    clearTimeout(bannerOut.timer);
    const el = bannerOut.el;
    bannerOut = null;
    el.classList.add('banner--in');
    return el;
  }
  const el = h('div', { class: 'banner', role: 'status' });
  getLayer('banner').appendChild(el);
  afterInsert(el, () => el.classList.add('banner--in'));
  return el;
}

/**
 * Shows a persistent top banner (or hides it when `text` is null/empty). Only one exists at a
 * time; #ui gets `--banner-h` / `has-banner` so toasts and HUD elements can sit below it.
 * @param {string|Node|null} text
 * @param {'info'|'ok'|'warn'|'danger'} [kind='info']
 * @returns {HTMLElement|null}
 */
function banner(text, kind = 'info') {
  if (text === null || text === undefined || text === '') {
    if (bannerEl) hideBanner();
    setBannerHeight(0);
    return null;
  }
  if (!bannerEl || !bannerEl.isConnected) bannerEl = acquireBanner();
  bannerEl.className = 'banner banner--' + kind + ' banner--in';
  bannerEl.textContent = '';
  appendChildren(bannerEl, [text]);
  setBannerHeight(bannerEl.offsetHeight);
  return bannerEl;
}

/**
 * Full-screen 200 ms flash overlay (hit / damage / photo pop).
 * @param {'danger'|'white'|'amber'} [kind='white']
 */
function flash(kind = 'white') {
  const el = h('div', { class: 'flash flash--' + kind, 'aria-hidden': 'true' });
  getLayer('flash').appendChild(el);
  setTimeout(() => detach(el), FLASH_MS + 40);
  return el;
}

// ---------------------------------------------------------------------------
// Hardware back-button support (Android / browser back closes the top overlay)
// ---------------------------------------------------------------------------

/** @type {Array<{ close: Function, dismissable: boolean }>} overlays in open order; the last one closes on back */
const backEntries = [];
/** Number of our marker states currently on the history stack. */
let pushedStates = 0;
/** popstate events to swallow because we caused them (history.go). */
let ignorePops = 0;
/** History states released in the current task, flushed as one history.go(-n) in a microtask. */
let pendingReleases = 0;
let releaseFlushQueued = false;
let popListenerInstalled = false;

const hasHistory = () => typeof history !== 'undefined' && typeof history.pushState === 'function';

/** Pushes one marker state so the next back press lands on us instead of leaving the app. */
function pushMarkerState() {
  try {
    history.pushState({ holdoutUi: true }, '');
    pushedStates++;
  } catch (err) {
    warnOnce('history.pushState unavailable', err);
  }
}

function installPopListener() {
  if (popListenerInstalled || typeof window === 'undefined') return;
  popListenerInstalled = true;
  window.addEventListener('popstate', () => {
    if (ignorePops > 0) {
      ignorePops--;
      return;
    }
    const top = backEntries[backEntries.length - 1];
    if (top && top.dismissable === false) {
      // Non-dismissable overlay: restore the marker the back press consumed and stay open.
      if (pushedStates > 0) pushedStates--;
      if (hasHistory()) pushMarkerState();
      return;
    }
    if (pushedStates > 0) pushedStates--;
    const entry = backEntries.pop();
    if (entry) safeCall(entry.close, 'back-close');
  });
}

/**
 * Registers an overlay so a hardware/browser back press closes it (or, when `dismissable`
 * is false, is swallowed). Returns the entry; `entry.close` may be reassigned.
 */
function pushBackEntry(close, dismissable = true) {
  installPopListener();
  const entry = { close, dismissable };
  if (hasHistory()) {
    // A release queued in this same task cancels out against this push: no traversal needed.
    if (pendingReleases > 0) {
      pendingReleases--;
      pushedStates++;
    } else {
      pushMarkerState();
    }
  }
  backEntries.push(entry);
  return entry;
}

/** Pops every marker state released since the last flush with a single traversal. */
function flushReleases() {
  releaseFlushQueued = false;
  const n = pendingReleases;
  pendingReleases = 0;
  if (n <= 0) return;
  ignorePops++;
  try {
    history.go(-n);
  } catch (err) {
    ignorePops--;
    warnOnce('history.go failed', err);
  }
}

/** Unregisters an overlay closed by the app itself and schedules its history state to pop. */
function releaseBackEntry(entry) {
  const i = backEntries.indexOf(entry);
  if (i < 0) return;
  backEntries.splice(i, 1);
  if (pushedStates <= 0) return;
  pushedStates--;
  pendingReleases++;
  if (releaseFlushQueued) return;
  releaseFlushQueued = true;
  queueMicrotask(flushReleases);
}

// ---------------------------------------------------------------------------
// Backdrop + modal
// ---------------------------------------------------------------------------

/** Creates a fading backdrop that calls `onTap` on a clean pointer tap (never via click). */
function makeBackdrop(onTap) {
  const el = h('div', { class: 'backdrop', 'aria-hidden': 'true' });
  attachPress(el, () => { if (onTap) onTap(); }, { pressedClass: null, haptic: false, clickFallback: false });
  return el;
}

/**
 * iOS Safari < 16 ignores `overscroll-behavior`, so a scroll region that reaches its end (or
 * cannot scroll at all) chains the gesture to the document and rubber-bands the whole page
 * behind the overlay. When the browser lacks `overscroll-behavior: contain` this keeps the
 * region one pixel away from its edges on touchstart and blocks touchmove while it has nothing
 * to scroll. A no-op everywhere else (the listeners are never registered).
 * @param {HTMLElement} el scroll container (sheet/modal body)
 */
function attachScrollGuard(el) {
  if (!needsScrollGuard()) return;
  el.addEventListener('touchstart', () => {
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    if (el.scrollTop <= 0) el.scrollTop = 1;
    else if (el.scrollTop >= max) el.scrollTop = max - 1;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (el.scrollHeight <= el.clientHeight && e.cancelable) e.preventDefault();
  }, { passive: false });
}

let scrollGuardNeeded = null;

/** Cached feature check: true when `overscroll-behavior: contain` is unsupported (iOS < 16). */
function needsScrollGuard() {
  if (scrollGuardNeeded === null) {
    try {
      scrollGuardNeeded = !(typeof CSS !== 'undefined' && CSS.supports && CSS.supports('overscroll-behavior', 'contain'));
    } catch (_) {
      scrollGuardNeeded = true;
    }
  }
  return scrollGuardNeeded;
}

/** Resolves a body spec (Node | string | fn) into a node list. */
function resolveBody(body, handle) {
  const v = typeof body === 'function' ? safeCall(body, 'body render', handle) : body;
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** @type {Array<Object>} open modals, bottom to top */
const modalStack = [];

/**
 * Opens a centered modal card over a backdrop. Several may be stacked.
 * @param {{ title?: string, body?: Node|string|Function, actions?: Array<{label: string, kind?: string, onClick?: Function, close?: boolean, icon?: any}>,
 *           dismissable?: boolean, wide?: boolean, class?: string, align?: 'center'|'left', onClose?: Function }} opts
 * @returns {{ el: HTMLElement, close(result?: any): void, closed: boolean, setBody(node: any): void }}
 */
function modal(opts = {}) {
  const dismissable = opts.dismissable !== false;
  const layer = getLayer('modal');
  const handle = { el: null, closed: false, close: null, setBody: null, dismissable };

  const backdrop = makeBackdrop(() => { if (dismissable) handle.close(); });
  const card = h('div', { class: ['modal', 'glass', opts.wide && 'modal--wide', opts.class], role: 'dialog', 'aria-modal': 'true' });
  handle.el = card;
  if (opts.title) card.appendChild(h('div', { class: 'modal__title' }, opts.title));
  const bodyEl = h('div', { class: ['modal__body', 'scroll', opts.align === 'left' && 'modal__body--left'] });
  attachScrollGuard(bodyEl);
  card.appendChild(bodyEl);

  handle.setBody = (node) => {
    bodyEl.textContent = '';
    appendChildren(bodyEl, resolveBody(node, handle));
  };
  handle.setBody(opts.body);

  const actions = Array.isArray(opts.actions) ? opts.actions : [];
  if (actions.length) {
    const bar = h('div', { class: ['modal__actions', actions.length > 2 && 'modal__actions--stack'] });
    actions.forEach((a) => {
      bar.appendChild(btn(a.label, () => {
        const keep = typeof a.onClick === 'function' ? safeCall(a.onClick, 'modal action', handle) : undefined;
        if (keep !== false && a.close !== false) handle.close(a.value !== undefined ? a.value : a.label);
      }, { kind: a.kind || 'secondary', icon: a.icon, disabled: a.disabled }));
    });
    card.appendChild(bar);
  }

  const wrap = h('div', { class: 'modal-wrap' }, card);
  layer.appendChild(backdrop);
  layer.appendChild(wrap);
  afterInsert(card, () => {
    backdrop.classList.add('backdrop--in');
    card.classList.add('modal--in');
  });

  const backEntry = pushBackEntry(() => handle.close(), dismissable);
  modalStack.push(handle);

  handle.close = (result) => {
    if (handle.closed) return;
    handle.closed = true;
    const i = modalStack.indexOf(handle);
    if (i >= 0) modalStack.splice(i, 1);
    releaseBackEntry(backEntry);
    backdrop.classList.remove('backdrop--in');
    card.classList.remove('modal--in');
    card.classList.add('modal--out');
    backdrop.style.pointerEvents = 'none';
    wrap.style.pointerEvents = 'none';
    setTimeout(() => { detach(backdrop); detach(wrap); }, D_MED + 20);
    if (typeof opts.onClose === 'function') safeCall(opts.onClose, 'modal onClose', result);
  };
  return handle;
}

/**
 * Yes/no dialog.
 * @param {string|Node} msg
 * @param {{ title?: string, okLabel?: string, cancelLabel?: string, danger?: boolean, dismissable?: boolean }} [opts]
 * @returns {Promise<boolean>} false when dismissed (backdrop / Escape / back)
 */
function confirm(msg, opts = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => { if (!answered) { answered = true; resolve(v); } };
    modal({
      title: opts.title,
      body: msg,
      actions: [
        { label: opts.cancelLabel || 'Cancel', kind: 'ghost', onClick: () => answer(false) },
        { label: opts.okLabel || 'Confirm', kind: opts.danger ? 'danger' : 'primary', onClick: () => answer(true) },
      ],
      dismissable: opts.dismissable !== false,
      onClose: () => answer(false),
    });
  });
}

// ---------------------------------------------------------------------------
// Bottom sheet (one at a time, drag to dismiss)
// ---------------------------------------------------------------------------

let currentSheet = null;

/** Wires drag-to-dismiss on the sheet's grab regions. */
function attachSheetDrag(handle, el, backdrop, grabRegions) {
  let dragging = false;
  let pointerId = -1;
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let offset = 0;
  /** Sheet height, read once per drag so pointermove never forces layout. */
  let height = 1;

  function setOffset(dy) {
    offset = dy;
    const shown = dy < 0 ? -Math.min(SHEET_RUBBER_MAX, Math.pow(-dy, 0.75)) : dy;
    el.style.transform = 'translate3d(0,' + shown + 'px,0)';
    backdrop.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / height));
  }

  function end(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    el.classList.remove('sheet--dragging');
    const shouldClose = offset > height * SHEET_DISMISS_FRAC || (velocity > SHEET_FLING_V && offset > 24);
    el.style.transform = '';
    backdrop.style.opacity = '';
    if (shouldClose) handle.close();
  }

  function onDown(e) {
    if (dragging || handle.closed || (e.button && e.button !== 0)) return;
    // Buttons inside the header (close ✕) keep their own tap handling.
    if (e.target && e.target.closest && e.target.closest('button')) return;
    dragging = true;
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = now();
    velocity = 0;
    offset = 0;
    height = el.offsetHeight || 1;
    el.classList.add('sheet--dragging');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* capture unsupported */ }
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    const t = now();
    const dt = Math.max(1, t - lastT);
    const instant = (e.clientY - lastY) / dt;
    velocity = velocity * 0.6 + instant * 0.4;
    lastY = e.clientY;
    lastT = t;
    setOffset(e.clientY - startY);
  }

  grabRegions.forEach((region) => {
    region.addEventListener('pointerdown', onDown);
    region.addEventListener('pointermove', onMove);
    region.addEventListener('pointerup', end);
    region.addEventListener('pointercancel', end);
  });
}

/**
 * Opens the bottom sheet (replacing any open one with a cross-fade).
 * @param {{ title?: string, body?: Node|string|Function, height?: 'half'|'full'|'auto', onClose?: Function, class?: string, closeButton?: boolean }} opts
 * @returns {{ el: HTMLElement, body: HTMLElement, close(): void, setBody(node: any): void, setTitle(text: string): void, closed: boolean }}
 */
function sheet(opts = {}) {
  const layer = getLayer('sheet');
  const height = opts.height || 'half';
  const prev = currentSheet;
  const handle = { el: null, body: null, closed: false, close: null, setBody: null, setTitle: null };

  // The backdrop outlives replaced sheets, so it resolves the current sheet at tap time.
  const backdrop = prev ? prev.backdrop : makeBackdrop(() => { if (currentSheet) currentSheet.close(); });
  handle.backdrop = backdrop;

  const grip = h('div', { class: 'sheet__handle', 'aria-hidden': 'true' }, h('div', { class: 'sheet__grip' }));
  const titleEl = h('div', { class: 'sheet__title' }, opts.title || '');
  const head = opts.title || opts.closeButton
    ? h('div', { class: 'sheet__head' }, titleEl, opts.closeButton !== false ? btn('✕', () => handle.close(), { kind: 'ghost', size: 'sm', class: 'sheet__close' }) : null)
    : null;
  const bodyEl = h('div', { class: 'sheet__body scroll' });
  attachScrollGuard(bodyEl);
  const el = h('div', { class: ['sheet', 'glass', 'sheet--' + height, opts.class], role: 'dialog', 'aria-modal': 'true' }, grip, head, bodyEl);
  handle.el = el;
  handle.body = bodyEl;

  handle.setBody = (node) => {
    bodyEl.textContent = '';
    appendChildren(bodyEl, resolveBody(node, handle));
    bodyEl.scrollTop = 0;
  };
  handle.setTitle = (text) => { titleEl.textContent = text || ''; };
  handle.setBody(opts.body);

  const wrap = h('div', { class: 'sheet-wrap' }, el);
  if (!prev) layer.appendChild(backdrop);
  layer.appendChild(wrap);

  let backEntry;
  if (prev) {
    // Cross-fade: the old sheet fades away in place, the new one slides up over it.
    prev.replaced = true;
    backEntry = prev.backEntry;
    backEntry.close = () => handle.close();
    prev.close();
    el.classList.add('sheet--fade');
    afterInsert(el, () => {
      el.classList.remove('sheet--fade');
      el.classList.add('sheet--in');
    });
  } else {
    backEntry = pushBackEntry(() => handle.close());
    afterInsert(el, () => {
      backdrop.classList.add('backdrop--in');
      el.classList.add('sheet--in');
    });
  }
  handle.backEntry = backEntry;
  currentSheet = handle;

  attachSheetDrag(handle, el, backdrop, head ? [grip, head] : [grip]);

  handle.close = () => {
    if (handle.closed) return;
    handle.closed = true;
    const wasCurrent = currentSheet === handle;
    if (wasCurrent) currentSheet = null;
    if (handle.replaced) {
      el.classList.add('sheet--fade');
      el.style.pointerEvents = 'none';
      setTimeout(() => detach(wrap), D_MED + 20);
    } else {
      releaseBackEntry(backEntry);
      el.classList.remove('sheet--in', 'sheet--dragging');
      el.classList.add('sheet--out');
      el.style.transform = '';
      el.style.pointerEvents = 'none';
      backdrop.classList.remove('backdrop--in');
      backdrop.style.opacity = '';
      backdrop.style.pointerEvents = 'none';
      setTimeout(() => { detach(wrap); detach(backdrop); }, D_SHEET + 20);
    }
    if (typeof opts.onClose === 'function') safeCall(opts.onClose, 'sheet onClose');
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Screen + closeAll + keyboard
// ---------------------------------------------------------------------------

/** Sets `body[data-screen]` for screen-scoped CSS (null clears it). */
function setScreen(name) {
  if (!document.body) return;
  if (name) document.body.dataset.screen = String(name);
  else delete document.body.dataset.screen;
}

/** Closes every sheet, modal and toast. */
function closeAll() {
  while (modalStack.length) modalStack[modalStack.length - 1].close();
  if (currentSheet) currentSheet.close();
  while (liveToasts.length) liveToasts[0].close();
}

/** Escape closes the topmost dismissable overlay. */
function onKeyDown(e) {
  if (e.key !== 'Escape') return;
  const top = modalStack[modalStack.length - 1];
  if (top) {
    if (top.dismissable) top.close();
    return;
  }
  if (currentSheet) currentSheet.close();
}

if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown);

// ---------------------------------------------------------------------------
// bind(): frame-coalesced re-render on 'state:changed'
// ---------------------------------------------------------------------------

/** @type {Set<{el: HTMLElement, fn: Function, misses: number}>} */
const bindings = new Set();
let refreshQueued = false;
let busSubscribed = false;
let lastRefreshAt = -Infinity;

function runRefresh() {
  refreshQueued = false;
  lastRefreshAt = now();
  bindings.forEach((b) => {
    if (!b.el.isConnected) {
      // Grace of one refresh so elements built right before mount are not dropped.
      if (++b.misses >= 2) bindings.delete(b);
      return;
    }
    b.misses = 0;
    safeCall(b.fn, 'bind render', b.el);
  });
}

/** Coalesces refreshes to one per frame and never more often than BIND_MIN_INTERVAL. */
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  const wait = BIND_MIN_INTERVAL - (now() - lastRefreshAt);
  if (wait > 0) setTimeout(() => nextFrame(runRefresh), wait);
  else nextFrame(runRefresh);
}

/**
 * Calls `renderFn(el)` now and after every bus 'state:changed' (once per animation frame, max 10 Hz).
 * Unbinds itself once `el` leaves the DOM.
 * @param {HTMLElement} el
 * @param {(el: HTMLElement) => void} renderFn
 * @returns {() => void} unbind
 */
function bind(el, renderFn) {
  if (!busSubscribed) {
    busSubscribed = true;
    try {
      if (bus && typeof bus.on === 'function') bus.on('state:changed', scheduleRefresh);
    } catch (err) {
      warnOnce('bus.on failed', err);
    }
  }
  const b = { el, fn: renderFn, misses: 0 };
  bindings.add(b);
  safeCall(renderFn, 'bind render', el);
  return () => bindings.delete(b);
}

// ---------------------------------------------------------------------------
// Data widgets
// ---------------------------------------------------------------------------

const clamp01 = (t) => (t !== t || t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Progress bar. `el.set(t, valueText)` updates it cheaply: it only writes the `--t` custom
 * property, which components.css turns into the fill width (so the rounded cap stays round
 * at low values and the CSS transition eases the change).
 * @param {number} t 0..1
 * @param {{ kind?: 'amber'|'info'|'ok'|'warn'|'danger', label?: string, value?: string, size?: 'thin'|'thick', ticks?: boolean }} [opts]
 * @returns {HTMLElement}
 */
function progress(t, opts = {}) {
  const fill = h('div', { class: 'progress__fill' });
  const valueEl = h('span', { class: 'progress__value' });
  const el = h('div', { class: ['progress', opts.kind && 'progress--' + opts.kind, opts.size && 'progress--' + opts.size], role: 'progressbar' },
    (opts.label || opts.value) && h('div', { class: 'progress__meta' }, h('span', { class: 'progress__label' }, opts.label || ''), valueEl),
    h('div', { class: 'progress__track' }, fill, opts.ticks && h('div', { class: 'progress__ticks' })));
  /** Updates the fill (0..1) and the optional right-hand value text. */
  el.set = (v, valueText) => {
    const c = clamp01(v);
    fill.style.setProperty('--t', c.toFixed(4));
    el.setAttribute('aria-valuenow', String(Math.round(c * 100)));
    if (valueText !== undefined) valueEl.textContent = valueText;
    return el;
  };
  el.setKind = (kind) => {
    el.className = el.className.replace(/\bprogress--(amber|info|ok|warn|danger)\b/g, '').trim() + (kind ? ' progress--' + kind : '');
    return el;
  };
  el.set(t, opts.value);
  return el;
}

/**
 * Resource pill: icon + value. `el.set(text)` updates the text.
 * @param {string|Node|null} iconSrc
 * @param {string|number} text
 * @param {{ kind?: 'info'|'ok'|'warn'|'danger'|'amber', size?: 'sm', onClick?: Function }} [opts]
 * @returns {HTMLElement}
 */
function pill(iconSrc, text, opts = {}) {
  const textEl = h('span', { class: 'pill__text' }, String(text));
  const el = h('div', { class: ['pill', opts.kind && 'pill--' + opts.kind, opts.size && 'pill--' + opts.size] },
    iconSrc ? (() => { const ic = icon(iconSrc, opts.size === 'sm' ? 12 : 16); ic.classList.add('pill__icon'); return ic; })() : null,
    textEl);
  el.set = (v) => { textEl.textContent = String(v); return el; };
  el.setKind = (kind) => {
    el.className = el.className.replace(/\bpill--(info|ok|warn|danger|amber)\b/g, '').trim() + (kind ? ' pill--' + kind : '');
    return el;
  };
  if (typeof opts.onClick === 'function') {
    el.setAttribute('data-interactive', '');
    attachPress(el, opts.onClick, { pressedClass: null });
  }
  return el;
}

/**
 * List row: [left icon] title / subtitle [right] (chevron when tappable).
 * @param {{ left?: string|Node, title?: string|Node, sub?: string|Node, right?: string|Node, onClick?: Function,
 *           selected?: boolean, danger?: boolean, dim?: boolean, class?: string, chevron?: boolean }} opts
 * @returns {HTMLElement}
 */
function row(opts = {}) {
  const tappable = typeof opts.onClick === 'function';
  const el = h('div', {
    class: ['row', !tappable && 'row--static', opts.selected && 'row--selected', opts.danger && 'row--danger', opts.dim && 'row--dim', opts.class],
    role: tappable ? 'button' : undefined,
  },
  opts.left ? h('div', { class: 'row__left' }, typeof opts.left === 'string' ? icon(opts.left, 28) : opts.left) : null,
  h('div', { class: 'row__mid' },
    opts.title !== undefined && h('div', { class: 'row__title' }, opts.title),
    opts.sub !== undefined && opts.sub !== null && h('div', { class: 'row__sub' }, opts.sub)),
  (opts.right !== undefined || tappable) && h('div', { class: 'row__right' }, opts.right, tappable && opts.chevron !== false && h('span', { class: 'row__chev' })));
  if (tappable) attachPress(el, opts.onClick, { pressedClass: 'row--pressed' });
  return el;
}

/**
 * Tab bar + panel. `el.select(i)` switches tabs; `el.active` is the current index.
 * @param {Array<{ label: string, render: () => (Node|string), badge?: string|number }>} items
 * @param {{ active?: number, onChange?: (i: number) => void, class?: string }} [opts]
 * @returns {HTMLElement}
 */
function tabs(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const panel = h('div', { class: 'tabs__panel' });
  const bar = h('div', { class: 'tabs__bar', role: 'tablist' });
  const el = h('div', { class: ['tabs', opts.class] }, bar, panel);
  const tabEls = list.map((item, i) => {
    const t = h('button', { type: 'button', class: 'tabs__tab', role: 'tab' }, h('span', { class: 'tabs__label' }, item.label),
      item.badge !== undefined && item.badge !== null && item.badge !== 0 ? h('span', { class: 'badge tabs__badge' }, String(item.badge)) : null);
    attachPress(t, () => el.select(i), { pressedClass: 'tabs__tab--pressed' });
    bar.appendChild(t);
    return t;
  });
  el.active = -1;
  el.select = (i) => {
    if (i < 0 || i >= list.length || i === el.active) return el;
    el.active = i;
    tabEls.forEach((t, j) => {
      t.classList.toggle('tabs__tab--active', j === i);
      t.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    panel.textContent = '';
    const content = typeof list[i].render === 'function' ? safeCall(list[i].render, 'tab render', panel) : null;
    appendChildren(panel, [content]);
    if (typeof opts.onChange === 'function') safeCall(opts.onChange, 'tabs onChange', i);
    return el;
  };
  el.select(Math.min(list.length - 1, Math.max(0, opts.active | 0)));
  return el;
}

/** Formats a delta number as '+3' / '-2' / '0'. */
function fmtDelta(d) {
  if (typeof d !== 'number') return String(d);
  return d > 0 ? '+' + d : String(d);
}

/**
 * Stat block: small label over a big number with an optional delta.
 * @param {string} label
 * @param {string|number} value
 * @param {{ delta?: number|string, kind?: 'amber'|'info'|'danger'|'ok', icon?: string|Node }} [opts]
 * @returns {HTMLElement}
 */
function stat(label, value, opts = {}) {
  const valueEl = h('span', { class: 'stat__num' }, String(value));
  const deltaEl = h('span', { class: 'stat__delta' });
  const el = h('div', { class: ['stat', opts.kind && 'stat--' + opts.kind] },
    h('div', { class: 'stat__label' }, opts.icon ? icon(opts.icon, 12) : null, opts.icon ? ' ' : null, label),
    h('div', { class: 'stat__value' }, valueEl, deltaEl));
  el.set = (v, delta) => {
    valueEl.textContent = String(v);
    if (delta === undefined || delta === null || delta === '') {
      deltaEl.textContent = '';
      deltaEl.className = 'stat__delta';
    } else {
      const n = typeof delta === 'number' ? delta : parseFloat(delta);
      deltaEl.textContent = fmtDelta(delta);
      deltaEl.className = 'stat__delta ' + (n > 0 ? 'stat__delta--up' : n < 0 ? 'stat__delta--down' : 'stat__delta--flat');
    }
    return el;
  };
  el.set(value, opts.delta);
  return el;
}

// ---------------------------------------------------------------------------
// Public object
// ---------------------------------------------------------------------------

/**
 * UI facade. See file header for the full API.
 * @type {{
 *   root: HTMLElement, mount(el: Node): Node, unmount(el: Node): void,
 *   btn: typeof btn, icon: typeof icon, toast: typeof toast, banner: typeof banner, flash: typeof flash,
 *   modal: typeof modal, confirm: typeof confirm, sheet: typeof sheet, setScreen: typeof setScreen,
 *   closeAll: typeof closeAll, bind: typeof bind, progress: typeof progress, pill: typeof pill,
 *   row: typeof row, tabs: typeof tabs, stat: typeof stat, layer(name: string): HTMLElement, press: typeof attachPress
 * }}
 */
export const ui = {
  /** The #ui overlay element (created if the page lacks one). */
  get root() {
    return getRoot();
  },
  /** Appends a panel/HUD element to #ui (below overlays). */
  mount(el) {
    getRoot().appendChild(el);
    return el;
  },
  /** Removes a mounted element. */
  unmount(el) {
    detach(el);
  },
  /** Returns a named overlay layer (for custom full-screen overlays). */
  layer: getLayer,
  /** Tap handling for custom interactive elements (haptic + double-fire guard). */
  press: attachPress,
  btn,
  icon,
  toast,
  banner,
  flash,
  modal,
  confirm,
  sheet,
  setScreen,
  closeAll,
  bind,
  progress,
  pill,
  row,
  tabs,
  stat,
};

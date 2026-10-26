"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../extension/page-hook.js"), "utf8");

function setup() {
  class PageTarget extends EventTarget {}
  for (const method of ["addEventListener", "removeEventListener"]) {
    Object.defineProperty(PageTarget.prototype, method, {
      value: EventTarget.prototype[method], writable: true, configurable: true
    });
  }
  class Element extends PageTarget {
    constructor(classes = []) {
      super();
      this.classList = new Set(classes);
      this.classList.contains = this.classList.has;
      this.attributes = new Map();
      this.parentElement = null;
      this.isConnected = true;
      this.hidden = false;
      this.innerText = "Skip";
      this.style = { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" };
      this.rect = { x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 60, width: 100, height: 40 };
      this.countdowns = [];
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    getBoundingClientRect() { return this.rect; }
    querySelectorAll() { return this.countdowns; }
    matches(selector) {
      if (selector === ":disabled") return this.hasAttribute("disabled");
      if (selector === "#movie_player.html5-video-player") return this.id === "movie_player" && this.classList.has("html5-video-player");
      if (selector === "a") return this.tagName === "A";
      return ["ytp-skip-ad-button", "ytp-ad-skip-button-modern", "ytp-ad-skip-button"]
        .some(name => selector.includes(`.${name}`) && this.classList.has(name));
    }
    closest(selector) {
      for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
      return null;
    }
    contains(other) {
      for (let el = other; el; el = el.parentElement) if (el === this) return true;
      return false;
    }
  }
  class HTMLButtonElement extends Element {}
  const player = new Element(["html5-video-player", "ad-showing"]);
  player.id = "movie_player";
  const button = new HTMLButtonElement(["ytp-ad-skip-button-modern"]);
  button.parentElement = player;
  button.setAttribute("data-yas-page-click", "1");
  const document = new PageTarget();
  document.visibilityState = "visible";
  document.querySelector = () => player;
  document.elementFromPoint = () => button;
  const window = new PageTarget();
  window.top = window;
  const location = new URL("https://www.youtube.com/watch?v=fixture");
  const context = vm.createContext({
    EventTarget: PageTarget, Element, HTMLElement: Element, HTMLButtonElement,
    document, window, location, URL, innerWidth: 1024, innerHeight: 768,
    getComputedStyle: el => el.style
  });
  vm.runInContext(source, context, { filename: "page-hook.js" });
  function event(target = button, type = "click") {
    const e = new Event(type, { bubbles: true, cancelable: true });
    // Node EventTarget has no DOM propagation; a read-only target supplies the
    // dispatch-time DOM target while native listener invocation/options remain.
    Object.defineProperty(e, "target", { value: target });
    return e;
  }
  return { PageTarget, Element, button, player, document, window, location, context, event };
}

test("intended skip callback receives compatible view; original remains synthetic", () => {
  const h = setup();
  const original = h.event();
  let seen;
  h.button.addEventListener("click", function(e) {
    seen = e;
    assert.equal(this, h.button);
    assert.equal(e.isTrusted, true);
    assert.equal(e.target, h.button);
    assert.equal(e.currentTarget, h.button);
    assert.ok(e instanceof Event);
    assert.equal(e.constructor, Event);
    assert.equal(e.preventDefault, e.preventDefault);
    e.preventDefault();
  });
  assert.equal(h.button.dispatchEvent(original), false);
  assert.notEqual(seen, original);
  assert.equal(original.isTrusted, false);
  assert.equal(original.defaultPrevented, true);
});

test("delegated document and window callbacks use the event target", () => {
  const h = setup();
  for (const receiver of [h.document, h.window]) {
    let seen;
    receiver.addEventListener("click", function(e) { seen = e.isTrusted; assert.equal(this, receiver); });
    receiver.dispatchEvent(h.event());
    assert.equal(seen, true);
  }
});

test("cached event view remains stable after first handler removes ad UI", () => {
  const h = setup();
  let first;
  let second;
  h.button.addEventListener("click", e => {
    first = e;
    h.player.classList.delete("ad-showing");
    h.button.isConnected = false;
    h.button.removeAttribute("data-yas-page-click");
  });
  h.button.addEventListener("click", e => { second = e; });
  h.button.dispatchEvent(h.event());
  assert.equal(first, second);
  assert.equal(second.isTrusted, true);
});

test("listener removal preserves function identity", () => {
  const h = setup();
  let calls = 0;
  const listener = () => ++calls;
  h.button.addEventListener("click", listener);
  h.button.removeEventListener("click", listener);
  h.button.dispatchEvent(h.event());
  assert.equal(calls, 0);
});

test("duplicate registration and once semantics are retained", () => {
  const h = setup();
  let calls = 0;
  const listener = () => ++calls;
  h.button.addEventListener("click", listener, { once: true });
  h.button.addEventListener("click", listener, { once: true });
  h.button.dispatchEvent(h.event());
  h.button.dispatchEvent(h.event());
  assert.equal(calls, 1);
  h.button.addEventListener("click", listener);
  h.button.dispatchEvent(h.event());
  assert.equal(calls, 2);
});

test("capture option remains a native registration key", () => {
  const h = setup();
  let calls = 0;
  const listener = () => ++calls;
  h.button.addEventListener("click", listener, false);
  h.button.addEventListener("click", listener, true);
  h.button.removeEventListener("click", listener, false);
  h.button.dispatchEvent(h.event());
  assert.equal(calls, 1);
  h.button.removeEventListener("click", listener, { capture: true });
  h.button.dispatchEvent(h.event());
  assert.equal(calls, 1);
});

test("AbortSignal registration still aborts", () => {
  const h = setup();
  const controller = new AbortController();
  let calls = 0;
  h.button.addEventListener("click", () => ++calls, { signal: controller.signal });
  controller.abort();
  h.button.dispatchEvent(h.event());
  assert.equal(calls, 0);
});

test("object listeners resolve current handleEvent with object receiver", () => {
  const h = setup();
  const values = [];
  const listener = { handleEvent(e) { values.push([this, e.isTrusted, "first"]); } };
  h.button.addEventListener("click", listener);
  h.button.dispatchEvent(h.event());
  listener.handleEvent = function(e) { values.push([this, e.isTrusted, "second"]); };
  h.button.dispatchEvent(h.event());
  h.button.removeEventListener("click", listener);
  h.button.dispatchEvent(h.event());
  assert.deepEqual(values, [[listener, true, "first"], [listener, true, "second"]]);
});

test("event writes and native methods use original receiver", () => {
  const h = setup();
  const original = h.event();
  h.button.addEventListener("click", e => { e.cancelBubble = true; e.returnValue = false; });
  h.button.dispatchEvent(original);
  assert.equal(original.cancelBubble, true);
  assert.equal(original.defaultPrevented, true);
});

for (const [name, alter] of [
  ["unmarked page script click", h => h.button.removeAttribute("data-yas-page-click")],
  ["ordinary non-skip button", h => h.button.classList.clear()],
  ["content playback", h => h.player.classList.delete("ad-showing")],
  ["hidden page", h => h.document.visibilityState = "hidden"],
  ["non-watch route", h => h.location.pathname = "/"],
  ["watch without video id", h => h.location.search = ""],
  ["disabled skip button", h => h.button.setAttribute("disabled", "")],
  ["aria disabled button", h => h.button.setAttribute("aria-disabled", "true")],
  ["hidden ancestor", h => h.player.hidden = true],
  ["occluded button", h => h.document.elementFromPoint = () => h.player],
  ["countdown text", h => h.button.innerText = "Skip video in 3 seconds"],
  ["visible countdown element", h => { const c = new h.Element(); c.parentElement = h.button; h.button.countdowns = [c]; }],
  ["offscreen button", h => h.button.rect = { left: -100, top: 0, right: 0, bottom: 40, width: 100, height: 40 }],
  ["advertiser link", h => h.player.tagName = "A"],
  ["not actually a button", h => { Object.setPrototypeOf(h.button, h.Element.prototype); }]
]) {
  test(`${name} retains original event and false isTrusted`, () => {
    const h = setup();
    alter(h);
    const original = h.event();
    let delivered;
    h.button.addEventListener("click", e => { delivered = e; });
    h.button.dispatchEvent(original);
    assert.equal(delivered, original);
    assert.equal(delivered.isTrusted, false);
  });
}

test("non-click event is never wrapped", () => {
  const h = setup();
  const original = h.event(h.button, "pointerdown");
  let delivered;
  h.button.addEventListener("pointerdown", e => { delivered = e; });
  h.button.dispatchEvent(original);
  assert.equal(delivered, original);
});

test("double installation does not stack wrappers", () => {
  const h = setup();
  const original = h.PageTarget.prototype.addEventListener;
  vm.runInContext(source, h.context);
  assert.equal(h.PageTarget.prototype.addEventListener, original);
});

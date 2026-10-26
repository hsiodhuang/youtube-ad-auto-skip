(() => {
  "use strict";

  // Compatibility reference idea: https://github.com/squgeim/yt-ad-autoskipper
  // This implementation is independent. It does not create a trusted browser
  // input event: only the intended page callbacks receive a compatible view.
  // The manifest confines this MAIN-world script to https://www.youtube.com/*.
  if (window.top !== window) return;

  const proto = EventTarget.prototype;
  const installation = Symbol.for("youtube-ad-auto-skip.page-hook.v1");
  if (Object.prototype.hasOwnProperty.call(proto, installation)) return;

  const originalAdd = proto.addEventListener;
  const originalRemove = proto.removeEventListener;
  const registrations = new WeakMap();
  const eventViews = new WeakMap();
  const skipSelector = ".ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button";

  function visible(element, player) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.right <= 0 || rect.bottom <= 0 ||
        rect.left >= innerWidth || rect.top >= innerHeight) return false;
    for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility !== "visible" ||
          Number(style.opacity) === 0) return false;
      if (node === player) return true;
    }
    return false;
  }

  function intendedSkip(event) {
    if (event.type !== "click" || event.isTrusted !== false ||
        document.visibilityState !== "visible" || location.pathname !== "/watch" ||
        !new URL(location.href).searchParams.get("v")) return false;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const button = target.closest(skipSelector);
    const player = document.querySelector("#movie_player.html5-video-player");
    if (!button || !player || button.getAttribute("data-yas-page-click") !== "1" ||
        button.closest("#movie_player.html5-video-player") !== player ||
        !(player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) ||
        !visible(button, player) || button.closest("a") ||
        (!(button instanceof HTMLButtonElement) && button.getAttribute("role") !== "button") ||
        button.matches(":disabled") || button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true" ||
        getComputedStyle(button).pointerEvents === "none") return false;

    const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`;
    if (/\b(?:skip|video)\b[^.\n]{0,50}\bin\s+\d|\b(?:available|skip).*?\b\d+\s*(?:seconds?|secs?)\b|\d+\s*秒后|あと\s*\d+\s*秒/i.test(label)) return false;
    for (const countdown of button.querySelectorAll(
      ".ytp-ad-preview-text, .ytp-ad-skip-button-countdown, .ytp-skip-ad-button__countdown"
    )) {
      if (visible(countdown, player)) return false;
    }
    const rect = button.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return Boolean(hit && (hit === button || button.contains(hit)));
  }

  function callbackEvent(event) {
    if (eventViews.has(event)) return eventViews.get(event) || event;
    if (!intendedSkip(event)) {
      eventViews.set(event, null);
      return event;
    }
    const boundMethods = new Map();
    // Event.isTrusted is non-configurable on the original native Event. A
    // separate shell avoids a Proxy invariant violation while preserving the
    // Event/MouseEvent prototype chain and native getter/method receivers.
    const view = new Proxy(Object.create(Object.getPrototypeOf(event)), {
      get(_shell, key) {
        if (key === "isTrusted") return true;
        const value = Reflect.get(event, key, event);
        if (typeof value !== "function" || key === "constructor") return value;
        if (!boundMethods.has(key)) boundMethods.set(key, value.bind(event));
        return boundMethods.get(key);
      },
      set(_shell, key, value) {
        return Reflect.set(event, key, value, event);
      },
      has(_shell, key) {
        return Reflect.has(event, key);
      }
    });
    eventViews.set(event, view);
    return view;
  }

  function listenerWrapper(target, listener, create) {
    let listeners = registrations.get(target);
    if (!listeners && create) {
      listeners = new WeakMap();
      registrations.set(target, listeners);
    }
    let wrapped = listeners?.get(listener);
    if (!wrapped && create) {
      wrapped = function (event) {
        const delivered = callbackEvent(event);
        if (typeof listener === "function") return Reflect.apply(listener, this, [delivered]);
        // Native object listeners resolve handleEvent at dispatch time, too.
        return Reflect.apply(listener.handleEvent, listener, [delivered]);
      };
      listeners.set(listener, wrapped);
    }
    return wrapped;
  }

  Object.defineProperty(proto, installation, { value: true });
  Object.defineProperty(proto, "addEventListener", {
    ...Object.getOwnPropertyDescriptor(proto, "addEventListener"),
    value: function addEventListener(type, listener, options) {
      const name = String(type);
      if (name !== "click" || listener === null ||
          (typeof listener !== "function" && typeof listener !== "object")) {
        return Reflect.apply(originalAdd, this, [name, listener, options]);
      }
      return Reflect.apply(originalAdd, this, [name, listenerWrapper(this, listener, true), options]);
    }
  });
  Object.defineProperty(proto, "removeEventListener", {
    ...Object.getOwnPropertyDescriptor(proto, "removeEventListener"),
    value: function removeEventListener(type, listener, options) {
      const name = String(type);
      if (name !== "click" || listener === null ||
          (typeof listener !== "function" && typeof listener !== "object")) {
        return Reflect.apply(originalRemove, this, [name, listener, options]);
      }
      return Reflect.apply(originalRemove, this, [name, listenerWrapper(this, listener, false) || listener, options]);
    }
  });
})();

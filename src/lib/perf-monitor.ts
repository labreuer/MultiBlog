"use client";

// Opt-in console logging for hot-path timings — see PERFORMANCE.md. Off by
// default (zero overhead: perfMeasure just calls fn() directly). Toggle from
// the browser console: multiblogPerf.enable() / multiblogPerf.disable().
// Persisted via localStorage so it survives reloads until disabled.

const STORAGE_KEY = "multiblog:perfLogging";

declare global {
  interface Window {
    multiblogPerf?: {
      enable: () => void;
      disable: () => void;
      isEnabled: () => boolean;
    };
  }
}

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = readEnabled();

function install(): void {
  if (typeof window === "undefined" || window.multiblogPerf) return;
  window.multiblogPerf = {
    enable() {
      enabled = true;
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        // ignore — logging just won't persist across reloads
      }
      console.log("[multiblog perf] logging enabled.");
    },
    disable() {
      enabled = false;
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      console.log("[multiblog perf] logging disabled.");
    },
    isEnabled: () => enabled,
  };
}

install();

export function perfMeasure<T>(label: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  const result = fn();
  console.log(`[multiblog perf] ${label}: ${(performance.now() - start).toFixed(2)}ms`);
  return result;
}

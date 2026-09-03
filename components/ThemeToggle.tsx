"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "agentready-theme";

/** How long the circle takes to cross the screen. Long enough to read as an
    eclipse, short enough that nobody waits for the page. */
const SWEEP_MS = 620;

type WithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

function apply(next: Theme) {
  document.documentElement.classList.toggle("dark", next === "dark");
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // A locked-down browser can refuse storage. The theme still switches; it
    // just will not be remembered, which is better than not switching.
  }
}

export function ThemeToggle() {
  // The real theme was decided by the inline script in the document head, before
  // React existed. Read it from the DOM rather than guessing, or the first paint
  // of this button disagrees with the page it sits on.
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  // Warm the other sky while the visitor reads, so the eclipse uncovers a
  // picture rather than an empty rectangle on the first toggle.
  useEffect(() => {
    const other = theme === "dark" ? "/landing-day.webp" : "/landing-night.webp";
    const warm = () => {
      const img = new Image();
      img.src = other;
    };
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      const handle = idle(warm, { timeout: 2500 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(warm, 1200);
    return () => window.clearTimeout(timer);
  }, [theme]);

  const flip = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      const doc = document as WithViewTransition;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // A hidden document gets no frames, and a view transition that cannot draw
      // a frame never runs its callback, so the theme would appear stuck until
      // the tab came back. Swap outright instead.
      const unseen = document.visibilityState !== "visible";

      if (still || unseen || typeof doc.startViewTransition !== "function") {
        apply(next);
        setTheme(next);
        return;
      }

      // The circle starts at the middle of the button and has to reach the
      // furthest corner, which is what the two maxima below measure.
      const box = event.currentTarget.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const reach = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );

      const transition = doc.startViewTransition(() => {
        apply(next);
        setTheme(next);
      });

      void transition.ready.then(() => {
        document.documentElement.animate(
          {
            clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${reach}px at ${x}px ${y}px)`],
          },
          {
            duration: SWEEP_MS,
            easing: "cubic-bezier(0.36, 0, 0.2, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      });
    },
    [theme],
  );

  const goingTo = theme === "dark" ? "day" : "night";

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={`Switch to ${goingTo}`}
      title={`Switch to ${goingTo}`}
      className="theme-switch"
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </button>
  );
}

function Sun() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="4.4" fill="currentColor" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <line
          key={deg}
          x1="12"
          y1="1.8"
          x2="12"
          y2="4.4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
    </svg>
  );
}

function Moon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden focusable="false">
      {/* A disc with a bite taken out of it, which is the eclipse this button
          performs, held still. */}
      <path
        d="M20.5 14.6A9 9 0 1 1 9.4 3.5a7.2 7.2 0 0 0 11.1 11.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

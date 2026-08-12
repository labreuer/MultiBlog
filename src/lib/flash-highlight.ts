"use client";

// Briefly tints an element a light version of a thread's own color so it's
// obvious which comment/annotation entry a jump-to-comment click landed on,
// then fades it back out. Shared by AnnotatableArticle (the quote-indicator
// badge click) and DocReadingBody (a click on an annotation-highlighted
// span) — same effect, same target shape (a comment/annotation entry's root
// div in the list below), different trigger.
export function flashHighlight(element: HTMLElement, color: string) {
  element.style.transition = "background-color 0.3s ease-in";
  element.style.backgroundColor = `color-mix(in srgb, ${color} var(--anchor-tint-active, 45%), transparent)`;
  window.setTimeout(() => {
    element.style.transition = "background-color 1.5s ease-out";
    element.style.backgroundColor = "";
  }, 1000);
}

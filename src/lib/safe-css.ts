// Sanitizes values interpolated into raw CSS text (an injected <style> tag,
// or a decoration's inline `style` attribute) before they reach the DOM.
// Originally lived only in AnnotationColorStyles.tsx; extracted so doc-link
// code (PLAN.md §14e) validates colors the same way instead of re-deriving
// its own regex.
export const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

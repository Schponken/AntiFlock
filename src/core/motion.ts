/**
 * Whether the viewer has asked the platform for reduced motion.
 *
 * Read live rather than cached: the preference can be changed while the page is
 * open, and there is no cost to asking. Guarded for headless runs, where there is
 * no `matchMedia` at all.
 */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

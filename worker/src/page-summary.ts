export type Heading = { level: number; text: string };
export type RawPage = { title: string; headings: Heading[]; text: string };
export type PageSummary = {
  url: string;
  title: string;
  /** The page's h1-h6 (and role="heading") elements in document order: its outline. */
  headings: Heading[];
  headingsTruncated: boolean;
  /** The page's visible text, as the browser renders it. */
  text: string;
  textTruncated: boolean;
};
export type PageLimits = { textChars: number; headings: number; headingChars: number };

/** Keeps a snapshot small enough for an LLM's context: a long article is cut, and says so. */
export const PAGE_LIMITS: PageLimits = { textChars: 20_000, headings: 100, headingChars: 200 };

/**
 * Runs inside the page via page.evaluate, so it must stay self-contained: no imports, and nothing
 * from this module's scope. It reads only what is rendered (innerText skips hidden content).
 */
export function collectPage(limit: { textChars: number }) {
  const squash = (value: string) => (value || '').replace(/\s+/g, ' ').trim();
  const headings: Array<{ level: number; text: string }> = [];
  for (const element of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) as HTMLElement[]) {
    const text = squash(element.innerText);
    if (!text) continue;
    const level = /^H[1-6]$/.test(element.tagName) ? Number(element.tagName[1]) : Number(element.getAttribute('aria-level')) || 2;
    headings.push({ level, text });
    if (headings.length >= 500) break;   // bound the work on pathological pages; summarizePage trims further
  }
  // One character past the limit is enough to tell summarizePage the text was cut.
  return { title: document.title, headings, text: document.body ? document.body.innerText.slice(0, limit.textChars + 1) : '' };
}

export function summarizePage(url: string, raw: RawPage, limits: PageLimits = PAGE_LIMITS): PageSummary {
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
  const usable = raw.headings.filter(heading => squash(heading.text));
  return {
    url,
    title: squash(raw.title),
    headings: usable.slice(0, limits.headings).map(heading => ({ level: Math.min(6, Math.max(1, Math.trunc(heading.level) || 2)), text: squash(heading.text).slice(0, limits.headingChars) })),
    headingsTruncated: usable.length > limits.headings,
    text: raw.text.slice(0, limits.textChars),
    textTruncated: raw.text.length > limits.textChars,
  };
}

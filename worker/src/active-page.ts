export interface TabPage {
  isClosed(): boolean;
  url(): string;
}

export interface CurrentTab {
  index: number;
  url: string;
}

const TAB_LINE = /^- (\d+): \(current\) \[.*\]\((.*?)\)(?: \[crashed\])?$/;

/**
 * Playwright MCP keeps its current tab private but prints it (`- 1: (current) [title](url)`) in the
 * "Open tabs" section of tool results, and in the result of browser_tabs. Only those sections are read,
 * so page content in a snapshot can't be mistaken for it.
 */
export function parseCurrentTab(text: string): CurrentTab | undefined {
  let inTabsSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) { inTabsSection = line === '### Open tabs' || line === '### Result'; continue; }
    if (!inTabsSection) continue;
    const match = TAB_LINE.exec(line);
    if (match) return { index: Number(match[1]), url: match[2] };
  }
  return undefined;
}

/** The tab the agent last reported as current, else the newest tab. */
export function activePage<P extends TabPage>(pages: readonly P[], hint: CurrentTab | undefined): P | undefined {
  const open = pages.filter(page => !page.isClosed());
  if (hint) {
    const atIndex = open[hint.index];
    if (atIndex?.url() === hint.url) return atIndex;
    const byUrl = open.filter(page => page.url() === hint.url);
    if (byUrl.length === 1) return byUrl[0];
    if (atIndex) return atIndex;
  }
  return open.at(-1);
}

import type { BrowserContext } from 'playwright';

type KeptContext = Pick<BrowserContext, 'on' | 'pages' | 'newPage'>;

/**
 * Chromium exits when its last tab closes (an agent's "close all tabs" would otherwise kill the profile's
 * browser for good). Keep one tab open, and call `onClosed` if the browser goes away regardless.
 * Playwright MCP also recreates a tab on its next call, so after `settleMs` surplus tabs are dropped, but
 * only when every open tab is blank.
 */
export function keepBrowserAlive(context: KeptContext, onClosed: () => void, settleMs = 1000) {
  const dropSurplusBlanks = () => {
    const pages = context.pages();
    if (pages.length > 1 && pages.every(page => page.url() === 'about:blank')) pages.slice(1).forEach(page => page.close().catch(() => {}));
  };
  const watch = (page: ReturnType<KeptContext['pages']>[number]) => page.on('close', () => {
    if (context.pages().length > 0) return;
    context.newPage().then(() => setTimeout(dropSurplusBlanks, settleMs).unref(), () => {});
  });
  context.pages().forEach(watch);
  context.on('page', watch);
  context.on('close', onClosed);
}

import { evaluate, getClient } from '../session/manager.js';

interface WatchlistSymbol {
  symbol: string;
  last: string | null;
  change: string | null;
  change_percent: string | null;
}

interface WatchlistResult {
  symbols: WatchlistSymbol[];
  source: string;
}

export async function get() {
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `) as WatchlistResult | null;

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function add({ symbol }: { symbol: string }) {
  const c = await getClient();

  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `) as { error?: string; opened?: boolean } | null;

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `) as { found?: boolean; selector?: string; method?: string } | null;

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

const API_BASE = 'http://localhost:3100';
const lastContextByTab = new Map();
const pollingTabs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PAGE_CONTEXT') {
    const context = withTab(sender, message.context);
    lastContextByTab.set(context.tabId, context);
    void postContext(context);
    ensureCommandPolling(context.tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'TEACH_CURRENT_PAGE') {
    const context = withTab(sender, message.context || lastContextByTab.get(sender.tab?.id));
    void teachCurrentPage(
      context,
      message.question || '',
      message.focus || '',
      message.mode || '',
      message.language || 'en',
      message.requestId || '',
    ).then(sendResponse);
    return true;
  }

  if (message?.type === 'SHOW_WIDGET_ON_ACTIVE_TAB') {
    void showWidgetOnActiveTab().then(sendResponse);
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  ensureCommandPolling(tabId);
});

function withTab(sender, context = {}) {
  return {
    ...context,
    tabId: sender.tab?.id,
    windowId: sender.tab?.windowId,
    capturedAt: new Date().toISOString(),
  };
}

async function postContext(context) {
  try {
    await fetch(`${API_BASE}/api/cobrowse/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(context),
    });
  } catch {
    // Local app is optional; keep the extension quiet when it is not running.
  }
}

async function teachCurrentPage(context, question, focus, mode, language, requestId) {
  const tabId = context.tabId;
  try {
    await postContext(context);
    const res = await fetch(`${API_BASE}/api/cobrowse/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, focus, mode, language }),
    });
    if (!res.ok || !res.body) {
      let message = 'Teacher is unavailable.';
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        /* non-JSON error body */
      }
      pushToTab(tabId, { type: 'TEACH_STATUS', text: message });
      return { ok: false, error: message };
    }

    // Read the SSE stream and forward each finished sentence to the page as it
    // arrives, so TTS can begin on sentence one instead of waiting for the rest.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let spoke = false;
    const sentences = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        let event;
        try {
          event = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === 'say' && event.text) {
          spoke = true;
          const sentence = {
            text: event.text,
            highlights: event.highlights || [],
            requestId,
          };
          sentences.push(sentence);
          pushToTab(tabId, { type: 'TEACH_SAY', ...sentence });
        } else if (event.type === 'error') {
          pushToTab(tabId, { type: 'TEACH_STATUS', text: event.message || 'Teacher error.' });
        }
      }
    }
    pushToTab(tabId, { type: 'TEACH_DONE', requestId });
    return { ok: true, streamed: spoke, sentences, requestId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Teacher is unavailable.';
    pushToTab(tabId, { type: 'TEACH_STATUS', text: message });
    return { ok: false, error: message };
  }
}

function pushToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

function ensureCommandPolling(tabId) {
  if (!tabId || pollingTabs.has(tabId)) return;
  pollingTabs.add(tabId);
  const poll = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/cobrowse/commands?tabId=${encodeURIComponent(tabId)}`);
      const data = await res.json();
      const commands = Array.isArray(data.commands) ? data.commands : [];
      for (const command of commands) {
        await chrome.tabs.sendMessage(tabId, { type: 'BROWSER_GUIDE_COMMAND', command }).catch(() => undefined);
      }
    } catch {
      // Local app may be down; try again later.
    } finally {
      setTimeout(poll, 900);
    }
  };
  void poll();
}

async function showWidgetOnActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) {
      return { ok: false, error: `Open a normal http(s) webpage first. Current URL: ${tab?.url || 'unknown'}` };
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    const response = await chrome.tabs
      .sendMessage(tab.id, { type: 'SHOW_LIVE_TEACHER_WIDGET' })
      .catch((err) => ({ ok: false, error: err?.message || String(err) }));
    const ping = await chrome.tabs
      .sendMessage(tab.id, { type: 'PING_LIVE_TEACHER_WIDGET' })
      .catch((err) => ({ ok: false, error: err?.message || String(err) }));
    ensureCommandPolling(tab.id);
    if (ping?.ok) {
      return {
        ok: true,
        url: tab.url,
        title: tab.title,
        hasWidget: Boolean(ping.hasWidget),
      };
    }
    return {
      ok: false,
      error: `Injected script, but it did not respond. ${response?.error || ping?.error || ''}`.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

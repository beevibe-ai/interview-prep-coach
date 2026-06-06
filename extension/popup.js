const statusEl = document.getElementById('status');

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:3100' });
});

document.getElementById('show').addEventListener('click', () => {
  statusEl.textContent = 'Showing widget...';
  chrome.runtime.sendMessage({ type: 'SHOW_WIDGET_ON_ACTIVE_TAB' }, (response) => {
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      statusEl.textContent = lastError.message || 'Could not show widget.';
      return;
    }
    statusEl.textContent = response?.ok
      ? response.hasWidget
        ? `Widget shown: ${response.title || response.url || 'active tab'}`
        : 'Content script responded, but widget host was not found.'
      : response?.error || 'Could not show widget on this tab.';
  });
});

fetch('http://localhost:3100/api/cobrowse/context')
  .then((res) => {
    statusEl.textContent = res.ok ? 'Local teacher is reachable.' : 'Local teacher returned an error.';
  })
  .catch(() => {
    statusEl.textContent = 'Start the local app on localhost:3100.';
  });

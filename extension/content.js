(function initLiveTeacherContent() {
  if (window.__liveTeacherContentLoaded) {
    window.dispatchEvent(new CustomEvent('live-teacher:show-widget'));
    return;
  }
  window.__liveTeacherContentLoaded = true;

  const CAPTURE_DEBOUNCE_MS = 700;
  const MAX_VISIBLE_CHARS = 8000;
  const FOLLOW_UP_MS = 1200; // gap after a block finishes before moving to the next
  const BLOCK_SELECTOR = 'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, dd, figcaption, td';
  const MIN_BLOCK_CHARS = 40;

  let captureTimer;
  let highlightBox;
  let inputEl;
  let captionEl;
  let captionWordEls = [];
  let savedBodyMarginBottom = null;

  // Language selection: 'en' (English) or 'zh' (Mandarin). Persists for the page session.
  let teachLanguage = 'en';

  // Co-browse is opt-in. While following, the teacher reads the page as an
  // ordered list of content blocks and walks them — scrolling to each block,
  // boxing it, and explaining that exact block, in document order.
  let following = false;
  let speaking = false;
  let accepting = true; // whether to play incoming sentences (false after Stop)
  let currentUtterance = null;
  let speakQueue = [];
  let sections = [];
  let sectionIndex = -1; // -1 = opening overview, then 0..n sections
  let lastWalkUrl = '';
  let followUpTimer;

  installCaptureListeners();
  installWidget();

  window.addEventListener('live-teacher:show-widget', () => {
    installWidget();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PING_LIVE_TEACHER_WIDGET') {
      sendResponse({ ok: true, loaded: true, hasWidget: Boolean(document.getElementById('live-teacher-widget-host')) });
      return false;
    }
    if (message?.type === 'SHOW_LIVE_TEACHER_WIDGET') {
      installWidget();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'TEACH_SAY') {
      enqueueSpeak({ text: message.text, highlights: message.highlights || [] });
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'TEACH_STATUS') {
      setWidgetStatus(message.text);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'TEACH_DONE') {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== 'BROWSER_GUIDE_COMMAND') return false;
    const command = message.command;
    if (command?.type === 'highlight') highlightText(command.text);
    if (command?.type === 'scrollToText') scrollToText(command.text);
    if (command?.type === 'navigate') navigateWithConfirm(command.url);
    sendResponse({ ok: true });
    return false;
  });

function installCaptureListeners() {
  ['scroll', 'resize', 'selectionchange', 'focusin', 'click', 'keyup'].forEach((eventName) => {
    document.addEventListener(eventName, scheduleCapture, { passive: true, capture: true });
  });
  const observer = new MutationObserver(scheduleCapture);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

function scheduleCapture() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(sendContext, CAPTURE_DEBOUNCE_MS);
}

// Streams the current tab to the local app (for the dashboard) and restarts the
// walk if the page navigated (SPA). Does NOT drive teaching — the block walk does.
function sendContext() {
  if (!following) return;
  const context = collectContext();
  chrome.runtime.sendMessage({ type: 'PAGE_CONTEXT', context }, () => undefined);
  if (context.url !== lastWalkUrl && !speaking) startWalk();
}

// ---- The page model: an ordered list of teachable content blocks ----

function collectBlocks() {
  const candidates = [];
  for (const el of document.querySelectorAll(BLOCK_SELECTOR)) {
    if (shouldSkipElement(el) || !isElementVisible(el)) continue;
    const text = normalize(el.innerText || el.textContent);
    if (!text) continue;
    const isHeading = /^H[1-6]$/.test(el.tagName);
    if (!isHeading && text.length < MIN_BLOCK_CHARS) continue;
    candidates.push({ el, text });
  }
  // Keep only leaf-ish blocks: drop any block that wraps another captured block
  // (e.g. an <li> that contains a <p>), so we don't teach the same text twice.
  const els = candidates.map((c) => c.el);
  return candidates.filter((c) => !els.some((other) => other !== c.el && c.el.contains(other)));
}

// Group the page into sections (a heading + the blocks beneath it) so the
// teacher can give a structured, source-level walkthrough — an overview, then
// the key idea of each section — instead of narrating every paragraph.
function collectSections() {
  const leaf = new Set(collectBlocks().map((b) => b.el));
  const ordered = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,' + BLOCK_SELECTOR)].filter(
    (el) => isElementVisible(el) && !shouldSkipElement(el),
  );
  const result = [];
  let current = null;
  for (const el of ordered) {
    if (/^H[1-6]$/.test(el.tagName)) {
      const heading = normalize(el.innerText || el.textContent);
      if (!heading) continue;
      if (current && current.parts.length) result.push(current);
      current = { anchorEl: el, heading, parts: [] };
    } else if (leaf.has(el)) {
      const text = normalize(el.innerText || el.textContent);
      if (!text) continue;
      if (!current) current = { anchorEl: el, heading: '', parts: [] };
      current.parts.push(text);
    }
  }
  if (current && current.parts.length) result.push(current);
  return result.map((s) => ({
    anchorEl: s.anchorEl,
    heading: s.heading,
    text: ((s.heading ? s.heading + '. ' : '') + s.parts.join(' ')).slice(0, 2500),
  }));
}

function startWalk() {
  sections = collectSections();
  lastWalkUrl = location.href;
  if (!sections.length) {
    setWidgetStatus('No readable sections found on this page.');
    return;
  }
  sectionIndex = -1;
  teachNext();
}

function teachNext() {
  if (sectionIndex < 0) return teachOverview();
  if (sectionIndex < sections.length) return teachSection(sectionIndex);
  clearHighlight();
  setWidgetStatus('That is the whole source. Ask me anything about it.');
}

// Opening: what the source is and how it's organized — high level, no details.
function teachOverview() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const outline = sections.filter((s) => s.heading).map((s) => s.heading).slice(0, 12);
  const opening = sections[0] ? sections[0].text.slice(0, 700) : '';
  const material = [
    `TITLE: ${document.title}`,
    outline.length ? `SECTIONS: ${outline.join(' | ')}` : '',
    `OPENING: ${opening}`,
  ]
    .filter(Boolean)
    .join('\n');
  if (sections[0]) setTimeout(() => { if (following) highlightElement(sections[0].anchorEl, true); }, 320);
  requestTeaching('', material, 'overview');
}

function teachSection(i) {
  const section = sections[i];
  if (!section) return;
  scrollSectionToTop(section.anchorEl);
  setTimeout(() => { if (following || speaking) highlightElement(section.anchorEl, true); }, 340);
  requestTeaching('', section.text, 'section');
}

function scrollSectionToTop(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - 90;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function currentSectionIndex() {
  let idx = 0;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].anchorEl.getBoundingClientRect().top <= window.innerHeight * 0.5) idx = i;
  }
  return idx;
}

// After a section's narration finishes, move to the next part of the walk.
function scheduleFollowUp() {
  if (!following) return;
  clearTimeout(followUpTimer);
  followUpTimer = setTimeout(() => {
    if (!following || speaking) return;
    sectionIndex += 1;
    teachNext();
  }, FOLLOW_UP_MS);
}

function collectContext() {
  return {
    url: location.href,
    title: document.title,
    selection: String(window.getSelection()?.toString() || '').trim().slice(0, 2000),
    visibleText: collectVisibleText(),
    focusedElement: describeElement(document.activeElement),
    scrollPercent: computeScrollPercent(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    capturedAt: new Date().toISOString(),
  };
}

function collectVisibleText() {
  if (!document.body) return '';
  const chunks = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = normalize(node.nodeValue);
      if (!text) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent) || !isElementVisible(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      return isTextNodeInViewport(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  while (walker.nextNode()) {
    const text = normalize(walker.currentNode.nodeValue);
    if (!text) continue;
    chunks.push(text);
    if (chunks.join(' ').length >= MAX_VISIBLE_CHARS) break;
  }
  return dedupeText(chunks.join(' ')).slice(0, MAX_VISIBLE_CHARS);
}

function installWidget() {
  if (document.getElementById('live-teacher-widget-host')) return;
  const host = document.createElement('div');
  host.id = 'live-teacher-widget-host';
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.right = '0';
  host.style.bottom = '0';
  host.style.zIndex = '2147483647';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .bar {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 12px;
        background: rgba(15, 23, 42, 0.97);
        color: #e2e8f0;
        border-top: 2px solid #38bdf8;
        box-shadow: 0 -10px 30px rgba(15, 23, 42, 0.3);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .follow {
        flex-shrink: 0; border: 0; border-radius: 8px; cursor: pointer; font: inherit;
        font-weight: 700; padding: 7px 12px; background: #334155; color: #e2e8f0;
      }
      .follow.on { background: #38bdf8; color: #04263a; }
      .stage { flex: 1; min-width: 0; display: flex; align-items: center; }
      .caption { width: 100%; max-height: 4.4em; overflow-y: auto; font-size: 15px; line-height: 1.45; }
      .caption:empty::before { content: attr(data-empty); color: #64748b; font-size: 13px; }
      .caption span { opacity: 0.4; transition: opacity 0.12s ease; }
      .caption span.said { opacity: 1; }
      .caption span.kw { font-weight: 800; color: #7dd3fc; }
      .ask-input {
        display: none; width: 100%; box-sizing: border-box; border: 1px solid #38bdf8;
        border-radius: 8px; padding: 7px 9px; font: inherit; background: #0b1220; color: #e2e8f0;
      }
      .bar.asking .caption { display: none; }
      .bar.asking .ask-input { display: block; }
      .controls { display: flex; gap: 4px; flex-shrink: 0; }
      .icon {
        border: 0; border-radius: 8px; background: rgba(255,255,255,0.1); color: #fff;
        cursor: pointer; width: 30px; height: 30px; font-size: 13px; line-height: 1;
      }
      .icon:hover { background: rgba(255,255,255,0.2); }
      .lang-toggle { display: flex; border-radius: 8px; overflow: hidden; flex-shrink: 0; border: 1px solid #334155; }
      .lang-btn { border: 0; background: #1e293b; color: #94a3b8; cursor: pointer; font: 700 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 5px 8px; }
      .lang-btn.active { background: #38bdf8; color: #04263a; }
      .bar.collapsed .stage,
      .bar.collapsed [data-teach],
      .bar.collapsed [data-ask],
      .bar.collapsed [data-stop],
      .bar.collapsed .lang-toggle { display: none; }
    </style>
    <div class="bar">
      <button class="follow" data-follow>Follow off</button>
      <div class="stage">
        <div class="caption" data-empty="Turn on Follow — I'll read through the page with you, block by block."></div>
        <input class="ask-input" placeholder="Ask about this page, then press Enter" />
      </div>
      <div class="lang-toggle">
        <button class="lang-btn active" data-lang="en">EN</button>
        <button class="lang-btn" data-lang="zh">中文</button>
      </div>
      <div class="controls">
        <button class="icon" data-teach title="Explain the section on screen">&#9654;</button>
        <button class="icon" data-ask title="Ask a question">?</button>
        <button class="icon" data-stop title="Stop talking">&#9632;</button>
        <button class="icon" data-min title="Minimize">&#8211;</button>
        <button class="icon" data-close title="Hide">&times;</button>
      </div>
    </div>
  `;

  captionEl = root.querySelector('.caption');
  inputEl = root.querySelector('.ask-input');
  const bar = root.querySelector('.bar');
  const followBtn = root.querySelector('[data-follow]');
  const langBtns = root.querySelectorAll('[data-lang]');

  langBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      teachLanguage = btn.dataset.lang;
      langBtns.forEach((b) => b.classList.toggle('active', b.dataset.lang === teachLanguage));
      inputEl.placeholder = teachLanguage === 'zh' ? '用中文提问，按 Enter 发送' : 'Ask about this page, then press Enter';
      stopSpeech();
    });
  });

  followBtn.addEventListener('click', () => {
    following = !following;
    followBtn.classList.toggle('on', following);
    followBtn.textContent = following ? 'Follow on' : 'Follow off';
    if (following) {
      accepting = true;
      setWidgetStatus('Reading the page...');
      startWalk();
    } else {
      setWidgetStatus('Paused. Click Follow to resume.');
      stopSpeech();
    }
  });

  root.querySelector('[data-teach]').addEventListener('click', () => {
    if (!sections.length) sections = collectSections();
    if (sections.length) teachSection(currentSectionIndex());
  });
  root.querySelector('[data-ask]').addEventListener('click', () => {
    bar.classList.add('asking');
    inputEl.value = '';
    inputEl.focus();
    reservePageSpace(host);
  });
  root.querySelector('[data-stop]').addEventListener('click', () => {
    accepting = false; // drop any sentences still streaming in from the current turn
    following = false; // halt the walk; Follow resumes it
    followBtn.classList.remove('on');
    followBtn.textContent = 'Follow off';
    stopSpeech();
    setWidgetStatus('Stopped. Click Follow to resume.');
  });
  root.querySelector('[data-min]').addEventListener('click', () => {
    bar.classList.toggle('collapsed');
    reservePageSpace(host);
  });
  root.querySelector('[data-close]').addEventListener('click', () => {
    host.remove();
    releasePageSpace();
  });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const question = inputEl.value;
      bar.classList.remove('asking');
      reservePageSpace(host);
      requestTeaching(question);
    } else if (event.key === 'Escape') {
      bar.classList.remove('asking');
      reservePageSpace(host);
    }
  });
  inputEl.addEventListener('blur', () => {
    bar.classList.remove('asking');
    reservePageSpace(host);
  });

  // Push the page up by the bar's height so the dock never hides content.
  requestAnimationFrame(() => reservePageSpace(host));
  window.addEventListener('resize', () => reservePageSpace(host), { passive: true });
}

function reservePageSpace(host) {
  if (!document.body) return;
  if (savedBodyMarginBottom === null) savedBodyMarginBottom = document.body.style.marginBottom || '';
  const height = host.getBoundingClientRect().height || 0;
  document.body.style.marginBottom = `${Math.ceil(height)}px`;
}

function releasePageSpace() {
  if (document.body && savedBodyMarginBottom !== null) {
    document.body.style.marginBottom = savedBodyMarginBottom;
    savedBodyMarginBottom = null;
  }
}

// `focus` is the exact block text to explain. Sentences stream back via TEACH_SAY.
function requestTeaching(question, focus, mode) {
  accepting = true; // a new teach turn wants to be heard
  stopSpeech();
  const context = collectContext();
  chrome.runtime.sendMessage({ type: 'TEACH_CURRENT_PAGE', context, question, focus, mode, language: teachLanguage }, (response) => {
    if (chrome.runtime.lastError) {
      setWidgetStatus('Local teacher is not reachable.');
      return;
    }
    if (!response?.ok) {
      setWidgetStatus(response?.error || 'Teacher is unavailable.');
      return;
    }
    if (!response.streamed) scheduleFollowUp(); // empty turn — keep the walk moving
  });
}

// Status messages live in the caption area (shown via its empty-state hint).
function setWidgetStatus(text) {
  if (!captionEl) return;
  captionEl.textContent = '';
  captionWordEls = [];
  captionEl.dataset.empty = text || '';
}

// Queue sentences so streamed lines play in order instead of cutting each other
// off. `speaking` stays true until the queue drains, which keeps the walk from
// advancing to the next block before the current one is finished.
function enqueueSpeak(item) {
  if (!accepting) return; // dropped after Stop, incl. sentences still streaming in
  const text = normalize(item && item.text);
  if (!text) return;
  speakQueue.push({ text, highlights: (item.highlights || []).filter(Boolean) });
  if (!speaking) drainSpeak();
}

function drainSpeak() {
  const item = speakQueue.shift();
  if (!item) {
    speaking = false;
    currentUtterance = null;
    scheduleFollowUp();
    return;
  }
  speaking = true;
  renderCaption(item);

  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = teachLanguage === 'zh' ? 'zh-CN' : 'en-US';
  utterance.rate = 1.02;
  // onboundary fires per spoken word, so the caption reveals at voice pace.
  utterance.onboundary = (event) => {
    if (typeof event.charIndex === 'number') revealCaption(event.charIndex);
  };
  utterance.onend = () => {
    currentUtterance = null;
    revealCaption(item.text.length);
    drainSpeak();
  };
  utterance.onerror = () => {
    currentUtterance = null;
    drainSpeak();
  };
  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
}

// Render the sentence as per-word spans (revealed in time with the voice) and
// bold the key phrase the teacher names.
function renderCaption(item) {
  if (!captionEl) return;
  captionEl.textContent = '';
  captionWordEls = [];
  const text = item.text;
  const ranges = (item.highlights || [])
    .map((phrase) => {
      const idx = text.toLowerCase().indexOf(String(phrase).toLowerCase());
      return idx < 0 ? null : [idx, idx + String(phrase).length];
    })
    .filter(Boolean);

  const wordRe = /\S+\s*/g;
  let match;
  while ((match = wordRe.exec(text))) {
    const span = document.createElement('span');
    span.textContent = match[0];
    const start = match.index;
    const end = start + match[0].trimEnd().length;
    span.dataset.start = String(start);
    if (ranges.some(([a, b]) => start < b && end > a)) span.classList.add('kw');
    captionEl.appendChild(span);
    captionWordEls.push(span);
  }
}

function revealCaption(charIndex) {
  let last = null;
  for (const span of captionWordEls) {
    if (Number(span.dataset.start) <= charIndex) {
      span.classList.add('said');
      last = span;
    }
  }
  // Keep the word being spoken in view so long captions scroll instead of clip.
  if (last && captionEl && captionEl.scrollHeight > captionEl.clientHeight) {
    const overshoot = last.offsetTop + last.offsetHeight - (captionEl.scrollTop + captionEl.clientHeight);
    if (overshoot > 0) captionEl.scrollTop += overshoot + 2;
  }
}

function stopSpeech() {
  speakQueue = [];
  speaking = false;
  clearTimeout(followUpTimer);
  // Detach handlers BEFORE cancel, so cancel()'s onend doesn't advance the walk.
  if (currentUtterance) {
    currentUtterance.onend = null;
    currentUtterance.onboundary = null;
    currentUtterance.onerror = null;
    currentUtterance = null;
  }
  speechSynthesis.cancel();
  clearHighlight();
}

// Box a specific element (the block being taught) — always accurate because we
// hold the element reference, no fuzzy text search.
function highlightElement(el, persist) {
  clearHighlight();
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  highlightBox = document.createElement('div');
  highlightBox.style.position = 'absolute';
  highlightBox.style.left = `${rect.left + window.scrollX - 6}px`;
  highlightBox.style.top = `${rect.top + window.scrollY - 4}px`;
  highlightBox.style.width = `${rect.width + 12}px`;
  highlightBox.style.height = `${rect.height + 8}px`;
  highlightBox.style.border = '3px solid #38bdf8';
  highlightBox.style.borderRadius = '8px';
  highlightBox.style.boxShadow = '0 0 0 9999px rgba(15, 23, 42, 0.10)';
  highlightBox.style.pointerEvents = 'none';
  highlightBox.style.zIndex = '2147483646';
  document.documentElement.appendChild(highlightBox);
  if (!persist) setTimeout(clearHighlight, 3500);
}

function clearHighlight() {
  highlightBox?.remove();
  highlightBox = undefined;
}

// ---- Used by the app dashboard's highlight/scroll commands (text-based) ----

function scrollToText(text) {
  const range = findTextRange(text);
  if (!range) return;
  const rect = range.getBoundingClientRect();
  window.scrollBy({ top: rect.top - window.innerHeight * 0.35, behavior: 'smooth' });
  setTimeout(() => highlightRange(range), 400);
}

function highlightText(text) {
  const range = findTextRange(text);
  if (!range) return;
  range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => highlightRange(range), 350);
}

function highlightRange(range) {
  clearHighlight();
  const rect = range.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  highlightBox = document.createElement('div');
  highlightBox.style.position = 'absolute';
  highlightBox.style.left = `${rect.left + window.scrollX - 6}px`;
  highlightBox.style.top = `${rect.top + window.scrollY - 5}px`;
  highlightBox.style.width = `${rect.width + 12}px`;
  highlightBox.style.height = `${rect.height + 10}px`;
  highlightBox.style.border = '3px solid #38bdf8';
  highlightBox.style.borderRadius = '8px';
  highlightBox.style.boxShadow = '0 0 0 9999px rgba(15, 23, 42, 0.08)';
  highlightBox.style.pointerEvents = 'none';
  highlightBox.style.zIndex = '2147483646';
  document.documentElement.appendChild(highlightBox);
  setTimeout(clearHighlight, 3500);
}

function navigateWithConfirm(url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.confirm(`Open ${url}?`)) location.href = url;
}

function findTextRange(text) {
  const needle = normalize(text).slice(0, 160).toLowerCase();
  if (!needle) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const haystack = normalize(node.nodeValue).toLowerCase();
    const index = haystack.indexOf(needle);
    if (index === -1) continue;
    const raw = node.nodeValue || '';
    const rawIndex = raw.toLowerCase().indexOf(needle);
    if (rawIndex === -1) continue;
    const range = document.createRange();
    range.setStart(node, rawIndex);
    range.setEnd(node, Math.min(raw.length, rawIndex + needle.length));
    return range;
  }
  return null;
}

function isTextNodeInViewport(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects());
  return rects.some((rect) => rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth);
}

function isElementVisible(element) {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
}

function shouldSkipElement(element) {
  return Boolean(element.closest('script, style, noscript, svg, canvas, video, audio, nav, header, footer, aside, [aria-hidden="true"], #live-teacher-widget-host'));
}

function describeElement(element) {
  if (!element || element === document.body || element === document.documentElement) return '';
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent;
  return normalize([role || tag, label].filter(Boolean).join(': ')).slice(0, 240);
}

function computeScrollPercent() {
  const doc = document.documentElement;
  const max = Math.max(1, doc.scrollHeight - window.innerHeight);
  return Math.max(0, Math.min(100, (window.scrollY / max) * 100));
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dedupeText(text) {
  return text.replace(/\b(.{20,180}?)\s+\1\b/g, '$1');
}
})();

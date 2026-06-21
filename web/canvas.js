/* ClaudeClaw Canvas - Telegram Mini App
 * Matches OpenClaw tg-canvas behavior:
 * - Single-state canvas (new push replaces previous content)
 * - HTML rendered directly with script re-execution
 * - WebSocket-style real-time via SSE
 * - Chart.js support for data visualization
 */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var statusEl = document.getElementById('status');
  var contentEl = document.getElementById('content');
  var lastUpdatedEl = document.getElementById('last-updated');

  // ── Init Telegram WebApp ─────────────────────────────────────────────
  if (tg) {
    tg.ready();
    tg.expand();
  }

  // ── Parse URL params ─────────────────────────────────────────────────
  var params = new URLSearchParams(window.location.search);
  var chatId = params.get('chatId') || '';
  var token = params.get('token') || '';
  var initData = tg ? tg.initData : '';

  // ── Render content to canvas ────────────────────────────────────────
  // Replaces entire canvas content (single-state, like OpenClaw)
  function renderContent(payload) {
    if (payload.type === 'clear') {
      contentEl.innerHTML = '<div class="empty-state">Canvas cleared.</div>';
      updateTimestamp();
      return;
    }

    // Clear previous content
    contentEl.innerHTML = '';

    var wrapper = document.createElement('div');
    wrapper.className = 'canvas-content';

    switch (payload.type) {
      case 'html':
        wrapper.innerHTML = payload.content;
        // Re-execute inline scripts (Telegram WebView blocks innerHTML scripts)
        var scripts = wrapper.querySelectorAll('script');
        scripts.forEach(function (oldScript) {
          var newScript = document.createElement('script');
          if (oldScript.src) {
            newScript.src = oldScript.src;
          } else {
            newScript.textContent = oldScript.textContent;
          }
          oldScript.parentNode.replaceChild(newScript, oldScript);
        });
        break;

      case 'markdown':
        wrapper.innerHTML = renderMarkdown(payload.content);
        break;

      case 'table':
        try {
          var data = JSON.parse(payload.content);
          wrapper.innerHTML = buildTable(data);
        } catch (e) {
          wrapper.innerHTML = '<p class="error">Invalid table data</p>';
        }
        break;

      case 'chart':
        var chartEl = renderChart(payload.content);
        wrapper.appendChild(chartEl);
        break;
    }

    contentEl.appendChild(wrapper);
    updateTimestamp();
  }

  function updateTimestamp() {
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = 'Updated just now';
      lastUpdatedEl.dataset.time = Date.now();
    }
  }

  // Refresh relative timestamps
  setInterval(function () {
    if (!lastUpdatedEl || !lastUpdatedEl.dataset.time) return;
    var elapsed = Date.now() - parseInt(lastUpdatedEl.dataset.time);
    if (elapsed < 60000) lastUpdatedEl.textContent = 'Updated just now';
    else if (elapsed < 3600000) lastUpdatedEl.textContent = 'Updated ' + Math.floor(elapsed / 60000) + 'm ago';
    else lastUpdatedEl.textContent = 'Updated ' + Math.floor(elapsed / 3600000) + 'h ago';
  }, 30000);

  // ── Markdown renderer ───────────────────────────────────────────────
  function renderMarkdown(md) {
    var html = md
      .replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
        return '<pre class="code-block">' + (lang ? '<div class="code-lang">' + escapeHtml(lang) + '</div>' : '') +
          '<code>' + escapeHtml(code) + '</code></pre>';
      })
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    return '<p>' + html + '</p>';
  }

  // ── Table builder ───────────────────────────────────────────────────
  function buildTable(data) {
    var headers, rows;
    if (Array.isArray(data) && data.length > 0) {
      headers = Object.keys(data[0]);
      rows = data.map(function (row) { return headers.map(function (h) { return row[h]; }); });
    } else if (data.headers && data.rows) {
      headers = data.headers;
      rows = data.rows;
    } else {
      return '<p class="error">Unrecognized table format</p>';
    }
    var ths = headers.map(function (h) { return '<th>' + escapeHtml(String(h)) + '</th>'; }).join('');
    var trs = rows.map(function (row) {
      return '<tr>' + row.map(function (c) { return '<td>' + escapeHtml(String(c == null ? '' : c)) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="table-wrapper"><table><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table></div>';
  }

  // ── Chart renderer ──────────────────────────────────────────────────
  var chartInstance = null;

  function renderChart(configJson) {
    var config;
    try { config = JSON.parse(configJson); }
    catch (e) { var p = document.createElement('p'); p.className = 'error'; p.textContent = 'Invalid chart config'; return p; }

    var wrapper = document.createElement('div');
    wrapper.className = 'chart-wrapper';
    var canvas = document.createElement('canvas');
    wrapper.appendChild(canvas);

    setTimeout(function () {
      if (window.Chart) {
        if (chartInstance) chartInstance.destroy();
        chartInstance = new window.Chart(canvas.getContext('2d'), config);
      }
    }, 50);

    return wrapper;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── SSE Connection ──────────────────────────────────────────────────
  var eventSource = null;

  function connect() {
    var streamParams = new URLSearchParams();
    if (chatId) streamParams.set('chatId', chatId);
    if (initData) streamParams.set('initData', initData);
    if (token) streamParams.set('token', token);

    var streamUrl = getBaseUrl() + '/stream?' + streamParams.toString();
    statusEl.textContent = 'Connecting...';
    statusEl.className = '';

    eventSource = new EventSource(streamUrl);

    eventSource.onopen = function () {
      statusEl.textContent = 'Connected';
      statusEl.className = 'connected';
    };

    eventSource.addEventListener('canvas_push', function (e) {
      try {
        var payload = JSON.parse(e.data);
        renderContent(payload);
      } catch (err) {
        console.error('Failed to render:', err);
      }
    });

    // Initial state: render the most recent push
    eventSource.addEventListener('state', function (e) {
      try {
        var payloads = JSON.parse(e.data);
        if (payloads.length > 0) {
          // Show only the latest (single-state canvas)
          renderContent(payloads[payloads.length - 1]);
        } else {
          contentEl.innerHTML = '<div class="empty-state">Waiting for content...</div>';
        }
      } catch (err) {
        console.error('Failed to parse state:', err);
      }
    });

    eventSource.addEventListener('ping', function () {});

    eventSource.onerror = function () {
      statusEl.textContent = 'Reconnecting...';
      statusEl.className = 'error';
      eventSource.close();
      setTimeout(connect, 3000);
    };
  }

  function getBaseUrl() {
    return window.location.origin;
  }

  connect();
})();

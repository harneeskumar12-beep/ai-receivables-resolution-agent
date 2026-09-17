/**
 * The Invoice Detail page: one self-contained HTML string, matching the
 * visual language already established in web-ui.ts. All data comes from the
 * JSON API in server.ts; this file has no analysis or classification logic
 * of its own, and never fabricates a result when analysis is unavailable.
 */

export const INVOICE_DETAIL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice Detail</title>
<style>
  :root {
    --ink: #1a2233;
    --muted: #5b6472;
    --line: #d8dee6;
    --bg: #f5f7fa;
    --card: #ffffff;
    --accent: #2452a8;
    --accent-ink: #ffffff;
    --warn-bg: #fff6e5;
    --warn-line: #e3a63b;
    --danger-bg: #fdecec;
    --danger-line: #c0392b;
    --ok-bg: #eaf7ef;
    --ok-line: #2c9a5f;
    --crit: #b02a2a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header { background: var(--card); border-bottom: 1px solid var(--line); padding: 20px 24px; display: flex; justify-content: space-between; align-items: baseline; }
  header h1 { margin: 0; font-size: 20px; }
  header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  main { max-width: 900px; margin: 24px auto; padding: 0 16px 48px; display: grid; gap: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
  .card h2 { margin: 0 0 14px; font-size: 15px; }
  .hint { color: var(--muted); margin: 0 0 10px; font-size: 13px; }
  .grid-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  .grid-row.two { grid-template-columns: repeat(2, 1fr); }
  .field label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 2px; }
  .field .val { font-size: 14px; }
  .field ul { margin: 4px 0 0; padding-left: 18px; }
  textarea { width: 100%; min-height: 110px; font: 13px/1.4 ui-monospace, "SFMono-Regular", Menlo, monospace; padding: 10px; border: 1px solid var(--line); border-radius: 6px; }
  textarea.draft { min-height: 140px; font: 13px/1.5 -apple-system, sans-serif; }
  button { background: var(--accent); color: var(--accent-ink); border: none; border-radius: 6px; padding: 9px 16px; font-size: 13px; cursor: pointer; margin-right: 8px; }
  button.secondary { background: var(--card); color: var(--accent); border: 1px solid var(--accent); }
  button.danger { background: var(--card); color: var(--danger-line); border: 1px solid var(--danger-line); }
  button.ok { background: var(--ok-line); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .pill.not_reviewed { background: var(--warn-bg); color: var(--warn-line); }
  .pill.approved { background: var(--ok-bg); color: var(--ok-line); }
  .pill.rejected { background: var(--danger-bg); color: var(--danger-line); }
  .violation { padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; font-size: 13px; background: var(--warn-bg); border: 1px solid var(--warn-line); }
  .violation.critical { background: var(--danger-bg); border-color: var(--danger-line); color: var(--crit); }
  .unavailable { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 6px; padding: 12px; }
  .ready-banner { margin-top: 12px; padding: 12px; border-radius: 6px; background: var(--ok-bg); color: var(--ok-line); font-weight: 600; }
  .msg { font-size: 13px; margin-top: 8px; }
  .msg.error { color: var(--danger-line); }
  .msg.ok { color: var(--ok-line); }
  .hidden { display: none; }
  code.small { font-size: 12px; color: var(--muted); }
  hr { border: none; border-top: 1px solid var(--line); margin: 16px 0; }
</style>
</head>
<body>
<header>
  <h1 id="invHeading">Invoice</h1>
  <a href="/">&larr; Back to Work Queue</a>
</header>
<main>
  <section class="card">
    <h2>Invoice details</h2>
    <div class="grid-row">
      <div class="field"><label>Customer</label><div class="val" id="fCustomer"></div></div>
      <div class="field"><label>Email</label><div class="val" id="fEmail"></div></div>
      <div class="field"><label>Invoice ID</label><div class="val" id="fId"></div></div>
      <div class="field"><label>Amount</label><div class="val" id="fAmount"></div></div>
    </div>
    <div class="grid-row">
      <div class="field"><label>Currency</label><div class="val" id="fCurrency"></div></div>
      <div class="field"><label>Due date</label><div class="val" id="fDue"></div></div>
      <div class="field"><label>Days overdue</label><div class="val" id="fOverdue"></div></div>
      <div class="field"><label>Invoice status</label><div class="val" id="fStatus"></div></div>
    </div>
  </section>

  <section class="card">
    <h2>Customer conversation</h2>
    <p class="hint">Format: one message per line - <code class="small">[YYYY-MM-DD] customer|collections_agent|system: message text</code></p>
    <textarea id="conversation" placeholder="[2026-09-03] collections_agent: Friendly reminder that this invoice is past due.
[2026-09-05] customer: We are still reviewing this."></textarea>
    <div style="margin-top:10px;">
      <button id="saveConvBtn" class="secondary">Save conversation</button>
      <button id="analyzeBtn">Analyze</button>
    </div>
    <div id="convMsg" class="msg"></div>
  </section>

  <section class="card hidden" id="resultCard">
    <h2>Analysis result</h2>
    <div id="resultBody"></div>
  </section>

  <section class="card hidden" id="reviewCard">
    <h2>Human review</h2>
    <p>Review status: <span class="pill" id="reviewPill"></span></p>
    <label style="display:block; font-size:11px; color:var(--muted); text-transform:uppercase; margin-bottom:4px;">Draft response</label>
    <textarea id="draft" class="draft"></textarea>
    <div style="margin-top:10px;">
      <button id="approveBtn" class="ok">Approve</button>
      <button id="saveDraftBtn" class="secondary">Save edit</button>
      <button id="rejectBtn" class="danger">Reject</button>
    </div>
    <div id="reviewMsg" class="msg"></div>
    <div id="readyBanner" class="ready-banner hidden">APPROVED - READY TO SEND</div>
  </section>
</main>
<script>
  var params = new URLSearchParams(window.location.search);
  var invoiceId = params.get('id');
  var REVIEW_LABEL = { not_reviewed: 'Not reviewed', approved: 'Approved - ready to send', rejected: 'Rejected' };
  var current = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function load() {
    if (!invoiceId) {
      document.getElementById('invHeading').textContent = 'No invoice selected';
      return;
    }
    fetch('/api/invoices/' + encodeURIComponent(invoiceId)).then(function (res) { return res.json(); }).then(function (data) {
      if (!data.ok) {
        document.getElementById('invHeading').textContent = 'Invoice not found';
        return;
      }
      current = data.invoice;
      render();
    });
  }

  function render() {
    var inv = current;
    document.getElementById('invHeading').textContent = inv.customer + ' - ' + inv.invoice_id;
    document.getElementById('fCustomer').textContent = inv.customer;
    document.getElementById('fEmail').textContent = inv.customer_email;
    document.getElementById('fId').textContent = inv.invoice_id;
    document.getElementById('fAmount').textContent = inv.currency + ' ' + Number(inv.amount).toLocaleString();
    document.getElementById('fCurrency').textContent = inv.currency;
    document.getElementById('fDue').textContent = inv.due_date;
    document.getElementById('fOverdue').textContent = inv.days_overdue;
    document.getElementById('fStatus').textContent = inv.status;
    document.getElementById('conversation').value = inv.conversation || '';

    var resultCard = document.getElementById('resultCard');
    var resultBody = document.getElementById('resultBody');
    var reviewCard = document.getElementById('reviewCard');

    if (inv.analysis_unavailable_reason) {
      resultCard.classList.remove('hidden');
      resultBody.innerHTML = '<div class="unavailable">' + escapeHtml(inv.analysis_unavailable_reason) + '</div>';
      reviewCard.classList.add('hidden');
    } else if (inv.analysis) {
      resultCard.classList.remove('hidden');
      var a = inv.analysis;
      var violationsHtml = a.violations.length
        ? a.violations.map(function (v) {
            return '<div class="violation ' + (v.severity === 'critical' ? 'critical' : '') + '">' +
              escapeHtml(v.code) + ' (' + escapeHtml(v.severity) + '): ' + escapeHtml(v.message) + '</div>';
          }).join('')
        : '<div style="color:var(--muted);">None</div>';
      var evidenceHtml = a.final.evidence.length
        ? '<ul>' + a.final.evidence.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') + '</ul>'
        : '<span style="color:var(--muted);">None</span>';

      resultBody.innerHTML =
        '<div class="grid-row two">' +
        '<div class="field"><label>Situation</label><div class="val">' + escapeHtml(a.final.situation) + '</div></div>' +
        '<div class="field"><label>Classification</label><div class="val">' + escapeHtml(a.final.classification) + '</div></div>' +
        '<div class="field"><label>Confidence</label><div class="val">' + a.final.confidence + '</div></div>' +
        '<div class="field"><label>Human approval required</label><div class="val">' + (a.final.human_approval_required ? 'Yes' : 'No') + '</div></div>' +
        '</div>' +
        '<div class="field" style="margin-bottom:12px;"><label>Evidence</label><div class="val">' + evidenceHtml + '</div></div>' +
        '<div class="field" style="margin-bottom:12px;"><label>Recommended action</label><div class="val">' + escapeHtml(a.final.recommended_action) + '</div></div>' +
        '<div class="field" style="margin-bottom:12px;"><label>Reason for handoff</label><div class="val">' +
        (a.final.reason_for_handoff ? escapeHtml(a.final.reason_for_handoff) : '<span style="color:var(--muted);">None</span>') + '</div></div>' +
        '<hr>' +
        '<div class="field" style="margin-bottom:12px;"><label>Safety override applied</label><div class="val">' + (a.overridden ? 'Yes' : 'No') + '</div></div>' +
        '<div class="field" style="margin-bottom:12px;"><label>Safety violations</label>' + violationsHtml + '</div>' +
        '<div class="grid-row two">' +
        '<div class="field"><label>Original (raw) decision</label><div class="val">' + escapeHtml(a.raw.classification) +
        (a.raw.human_approval_required ? ' (approval required)' : '') + '</div></div>' +
        '<div class="field"><label>Final (safety-checked) decision</label><div class="val">' + escapeHtml(a.final.classification) +
        (a.final.human_approval_required ? ' (approval required)' : '') + '</div></div>' +
        '</div>';

      reviewCard.classList.remove('hidden');
      document.getElementById('reviewPill').textContent = REVIEW_LABEL[inv.review_status];
      document.getElementById('reviewPill').className = 'pill ' + inv.review_status;
      document.getElementById('draft').value = inv.draft_response || '';
      document.getElementById('readyBanner').classList.toggle('hidden', inv.review_status !== 'approved');
    } else {
      resultCard.classList.add('hidden');
      reviewCard.classList.add('hidden');
    }
  }

  document.getElementById('saveConvBtn').addEventListener('click', function () {
    var convMsg = document.getElementById('convMsg');
    convMsg.textContent = '';
    fetch('/api/invoices/' + encodeURIComponent(invoiceId) + '/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: document.getElementById('conversation').value }),
    }).then(function (res) { return res.json(); }).then(function (data) {
      convMsg.className = data.ok ? 'msg ok' : 'msg error';
      convMsg.textContent = data.ok ? 'Conversation saved.' : data.errors.join(' ');
    });
  });

  document.getElementById('analyzeBtn').addEventListener('click', function () {
    var convMsg = document.getElementById('convMsg');
    convMsg.textContent = 'Analyzing...';
    convMsg.className = 'msg';
    fetch('/api/invoices/' + encodeURIComponent(invoiceId) + '/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: document.getElementById('conversation').value }),
    }).then(function () {
      return fetch('/api/invoices/' + encodeURIComponent(invoiceId) + '/analyze', { method: 'POST' });
    }).then(function (res) { return res.json(); }).then(function (data) {
      convMsg.textContent = data.ok ? '' : (data.errors ? data.errors.join(' ') : '');
      convMsg.className = data.ok ? 'msg' : 'msg error';
      load();
    });
  });

  document.getElementById('approveBtn').addEventListener('click', function () {
    var reviewMsg = document.getElementById('reviewMsg');
    fetch('/api/invoices/' + encodeURIComponent(invoiceId) + '/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_response: document.getElementById('draft').value }),
    }).then(function (res) { return res.json(); }).then(function (data) {
      reviewMsg.className = data.ok ? 'msg ok' : 'msg error';
      reviewMsg.textContent = data.ok ? 'Approved.' : data.errors.join(' ');
      load();
    });
  });

  document.getElementById('saveDraftBtn').addEventListener('click', function () {
    var reviewMsg = document.getElementById('reviewMsg');
    fetch('/api/invoices/' + encodeURIComponent(invoiceId) + '/draft', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_response: document.getElementById('draft').value }),
    }).then(function (res) { return res.json(); }).then(function (data) {
      reviewMsg.className = data.ok ? 'msg ok' : 'msg error';
      reviewMsg.textContent = data.ok ? 'Draft saved.' : data.errors.join(' ');
      load();
    });
  });

  document.getElementById('rejectBtn').addEventListener('click', function () {
    var reviewMsg = document.getElementById('reviewMsg');
    fetch('/api/invoices/' + encodeURIComponent(invoiceId) + '/reject', { method: 'POST' })
      .then(function (res) { return res.json(); }).then(function (data) {
        reviewMsg.className = data.ok ? 'msg ok' : 'msg error';
        reviewMsg.textContent = data.ok ? 'Rejected.' : data.errors.join(' ');
        load();
      });
  });

  load();
</script>
</body>
</html>`;

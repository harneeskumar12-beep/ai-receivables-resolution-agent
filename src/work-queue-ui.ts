/**
 * The Work Queue page: one self-contained HTML string (inline CSS/JS, no
 * external CDN, no framework), matching the visual language already
 * established in web-ui.ts. All data comes from the JSON API in server.ts;
 * this file has no analysis or classification logic of its own.
 */

export const WORK_QUEUE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Receivables Work Queue</title>
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
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header { background: var(--card); border-bottom: 1px solid var(--line); padding: 20px 24px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  main { max-width: 1100px; margin: 24px auto; padding: 0 16px 48px; display: grid; gap: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
  .card h2 { margin: 0 0 14px; font-size: 15px; }
  .hint { color: var(--muted); margin: 0 0 10px; font-size: 13px; }
  textarea { width: 100%; min-height: 110px; font: 13px/1.4 ui-monospace, "SFMono-Regular", Menlo, monospace; padding: 10px; border: 1px solid var(--line); border-radius: 6px; }
  button { background: var(--accent); color: var(--accent-ink); border: none; border-radius: 6px; padding: 9px 16px; font-size: 13px; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .03em; }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #f9fafc; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .badge.not_reviewed { background: var(--warn-bg); color: var(--warn-line); }
  .badge.approved { background: var(--ok-bg); color: var(--ok-line); }
  .badge.rejected { background: var(--danger-bg); color: var(--danger-line); }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .msg { font-size: 13px; margin-top: 8px; }
  .msg.error { color: var(--danger-line); }
  .msg.ok { color: var(--ok-line); }
</style>
</head>
<body>
<header>
  <h1>Receivables Work Queue</h1>
  <p>AI Receivables Resolution Agent - internal operations prototype</p>
</header>
<main>
  <section class="card">
    <h2>Import invoices (CSV)</h2>
    <p class="hint">Required columns: invoice_id, customer, customer_email, amount, due_date, status. Importing replaces the current list.</p>
    <textarea id="csvInput" placeholder="invoice_id,customer,customer_email,amount,due_date,status
INV-1001,Acme Co,ap@acme.com,4200,2026-08-29,unpaid"></textarea>
    <div style="margin-top:10px;">
      <button id="importBtn">Import CSV</button>
    </div>
    <div id="importMsg" class="msg"></div>
  </section>

  <section class="card">
    <h2>Work Queue</h2>
    <div id="queueWrap"><div class="empty">No invoices imported yet.</div></div>
  </section>
</main>
<script>
  var queueWrap = document.getElementById('queueWrap');
  var importBtn = document.getElementById('importBtn');
  var importMsg = document.getElementById('importMsg');
  var csvInput = document.getElementById('csvInput');

  var REVIEW_LABEL = { not_reviewed: 'Not reviewed', approved: 'Approved - ready to send', rejected: 'Rejected' };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadQueue() {
    fetch('/api/invoices').then(function (res) { return res.json(); }).then(function (data) {
      if (!data.ok || data.invoices.length === 0) {
        queueWrap.innerHTML = '<div class="empty">No invoices imported yet.</div>';
        return;
      }
      var rows = data.invoices.map(function (inv) {
        var situation = inv.analysis
          ? inv.analysis.final.situation
          : (inv.analysis_unavailable_reason ? inv.analysis_unavailable_reason : 'Not analyzed');
        var action = inv.analysis ? inv.analysis.final.recommended_action : '—';
        var badge = '<span class="badge ' + inv.review_status + '">' + REVIEW_LABEL[inv.review_status] + '</span>';
        return '<tr class="row" data-id="' + escapeHtml(inv.invoice_id) + '">' +
          '<td>' + escapeHtml(inv.customer) + '</td>' +
          '<td>' + escapeHtml(inv.invoice_id) + '</td>' +
          '<td>' + escapeHtml(inv.currency) + ' ' + Number(inv.amount).toLocaleString() + '</td>' +
          '<td>' + escapeHtml(inv.due_date) + '</td>' +
          '<td>' + inv.days_overdue + '</td>' +
          '<td>' + escapeHtml(situation) + '</td>' +
          '<td>' + escapeHtml(action) + '</td>' +
          '<td>' + badge + '</td>' +
          '</tr>';
      }).join('');
      queueWrap.innerHTML =
        '<table><thead><tr><th>Customer</th><th>Invoice</th><th>Amount</th><th>Due date</th>' +
        '<th>Days overdue</th><th>Situation</th><th>Recommended action</th><th>Review</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
      Array.prototype.forEach.call(queueWrap.querySelectorAll('tr.row'), function (tr) {
        tr.addEventListener('click', function () {
          window.location.href = '/invoice.html?id=' + encodeURIComponent(tr.getAttribute('data-id'));
        });
      });
    });
  }

  importBtn.addEventListener('click', function () {
    importMsg.textContent = '';
    importMsg.className = 'msg';
    fetch('/api/import-csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv: csvInput.value }),
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (!data.ok) {
        importMsg.textContent = data.errors.join(' ');
        importMsg.className = 'msg error';
        return;
      }
      importMsg.textContent = 'Imported ' + data.count + ' invoice(s).';
      importMsg.className = 'msg ok';
      csvInput.value = '';
      loadQueue();
    });
  });

  loadQueue();
</script>
</body>
</html>`;

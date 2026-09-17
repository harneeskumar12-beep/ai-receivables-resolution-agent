/**
 * The single-page V0 UI, as one self-contained HTML string (inline CSS/JS, no
 * external CDN, no framework - kept as small and dependency-free as the rest
 * of V0). Served by src/server.ts. All analysis happens server-side, via the
 * existing, unmodified core (src/ui-handler.ts -> agent.ts -> safety.ts).
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Receivables Resolution Agent</title>
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
    --ok-line: #2c9a5f;
    --crit: #b02a2a;
    --high: #b5730a;
    --med: #8a7a12;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header {
    background: var(--card);
    border-bottom: 1px solid var(--line);
    padding: 20px 24px;
  }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  main {
    max-width: 960px;
    margin: 24px auto;
    padding: 0 16px 48px;
    display: grid;
    gap: 20px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 20px;
  }
  .card h2 { margin: 0 0 14px; font-size: 15px; }
  .grid-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  @media (max-width: 640px) { .grid-row { grid-template-columns: 1fr 1fr; } }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input, textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    font: inherit;
    color: var(--ink);
    background: #fff;
  }
  textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .field { margin-bottom: 14px; }
  .hint { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button {
    font: inherit;
    border-radius: 6px;
    padding: 10px 16px;
    cursor: pointer;
    border: 1px solid var(--line);
    background: #fff;
    color: var(--ink);
  }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: default; }
  #sample-note { font-size: 12.5px; color: var(--muted); }
  #status { display: none; padding: 12px 14px; border-radius: 6px; margin-bottom: 4px; font-size: 13px; }
  #status.error { display: block; background: var(--danger-bg); border: 1px solid var(--danger-line); color: var(--danger-line); }
  #status.unavailable { display: block; background: var(--warn-bg); border: 1px solid var(--warn-line); color: #7a5300; }
  #result { display: none; }
  .decision-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .decision-grid { grid-template-columns: 1fr; } }
  .decision-panel { border-radius: 8px; padding: 16px; border: 1px solid var(--line); }
  .decision-panel.raw { border-left: 4px solid var(--muted); }
  .decision-panel.final { border-left: 4px solid var(--ok-line); }
  .decision-panel.final.overridden { border-left: 4px solid var(--warn-line); background: var(--warn-bg); }
  .decision-panel h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  .decision-panel dt { font-size: 11px; color: var(--muted); margin-top: 10px; }
  .decision-panel dt:first-child { margin-top: 0; }
  .decision-panel dd { margin: 2px 0 0; white-space: pre-wrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.approve-true { background: #fdecec; color: var(--crit); }
  .badge.approve-false { background: #e8f5ee; color: var(--ok-line); }
  .badge.overridden-tag { background: var(--warn-line); color: #fff; margin-left: 8px; }
  #violations { margin-top: 18px; }
  .violation { border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; font-size: 13px; border: 1px solid var(--line); }
  .violation.critical { background: var(--danger-bg); border-color: var(--crit); }
  .violation.high { background: var(--warn-bg); border-color: var(--high); }
  .violation.medium { background: #fbf8e6; border-color: var(--med); }
  .violation .sev { font-weight: 700; text-transform: uppercase; font-size: 10.5px; margin-right: 8px; }
  .none-note { color: var(--muted); font-size: 13px; }
  ul.evidence { margin: 2px 0 0; padding-left: 18px; }
  footer { max-width: 960px; margin: 0 auto 32px; padding: 0 16px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>AI Receivables Resolution Agent</h1>
  <p>V0 - assists collections staff. It never sends anything automatically; anything it flags requires human approval.</p>
</header>

<main>
  <section class="card" id="form-card">
    <h2>Case details</h2>
    <div class="grid-row">
      <div class="field"><label for="invoice_id">Invoice ID</label><input id="invoice_id" placeholder="INV-1001" /></div>
      <div class="field"><label for="customer">Customer</label><input id="customer" placeholder="Acme Corp" /></div>
      <div class="field"><label for="amount">Amount</label><input id="amount" type="number" min="0" step="0.01" placeholder="4200" /></div>
      <div class="field">
        <label for="currency">Currency</label>
        <input id="currency" value="USD" />
      </div>
    </div>
    <div class="field" style="max-width: 220px;">
      <label for="days_overdue">Days overdue</label>
      <input id="days_overdue" type="number" min="0" step="1" placeholder="12" />
    </div>

    <div class="field">
      <label for="invoice_facts">Invoice facts (one fact per line)</label>
      <textarea id="invoice_facts" placeholder="Invoice INV-1001 issued 2026-08-05, net-30, due 2026-08-29.&#10;No payment received as of 2026-09-10."></textarea>
      <p class="hint">Only what you type here is used - the system never invents additional facts.</p>
    </div>

    <div class="field">
      <label for="conversation">Customer conversation (one message per line)</label>
      <textarea id="conversation" placeholder="[2026-09-03] collections_agent: Reminder that invoice INV-1001 is past due.&#10;[2026-09-05] customer: We dispute this invoice, the work was never delivered."></textarea>
      <p class="hint">Format per line: <code>[YYYY-MM-DD] customer|collections_agent|system: message</code>. Leave blank if there has been no contact yet.</p>
    </div>

    <div class="actions">
      <button id="load-sample" type="button">Load sample case</button>
      <button id="analyze" type="button" class="primary">Analyze case</button>
      <span id="sample-note"></span>
    </div>
  </section>

  <section class="card" id="result-card">
    <h2>Result</h2>
    <div id="status"></div>
    <div id="result">
      <div class="decision-grid">
        <div class="decision-panel raw" id="raw-panel">
          <h3>Raw model decision</h3>
          <dl id="raw-fields"></dl>
        </div>
        <div class="decision-panel final" id="final-panel">
          <h3>Safety-adjusted final decision <span id="overridden-tag"></span></h3>
          <dl id="final-fields"></dl>
        </div>
      </div>
      <div id="violations"></div>
    </div>
  </section>
</main>

<footer>
  This tool assists a human collections team; it does not send messages, negotiate payment plans, or take
  action on its own. "Load sample case" fills the form with one of this project's existing benchmark
  fixtures for demonstration only - it is not a real customer.
</footer>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function setStatus(kind, text) {
    var el = $("status");
    el.className = kind || "";
    el.textContent = text || "";
    el.style.display = kind ? "block" : "none";
  }

  function fieldRow(dl, label, value) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function approvalBadge(required) {
    var span = document.createElement("span");
    span.className = "badge " + (required ? "approve-true" : "approve-false");
    span.textContent = required ? "Human approval required" : "No approval required";
    return span;
  }

  function renderDecision(dl, decision) {
    dl.innerHTML = "";
    fieldRow(dl, "Situation", decision.situation);
    fieldRow(dl, "Classification", decision.classification);
    fieldRow(dl, "Confidence", String(decision.confidence));
    var evDt = document.createElement("dt");
    evDt.textContent = "Evidence";
    var evDd = document.createElement("dd");
    var ul = document.createElement("ul");
    ul.className = "evidence";
    (decision.evidence || []).forEach(function (e) {
      var li = document.createElement("li");
      li.textContent = e;
      ul.appendChild(li);
    });
    evDd.appendChild(ul);
    dl.appendChild(evDt);
    dl.appendChild(evDd);
    fieldRow(dl, "Recommended action", decision.recommended_action);
    fieldRow(dl, "Draft response", decision.draft_response);
    var apDt = document.createElement("dt");
    apDt.textContent = "Human approval";
    var apDd = document.createElement("dd");
    apDd.appendChild(approvalBadge(decision.human_approval_required));
    dl.appendChild(apDt);
    dl.appendChild(apDd);
    fieldRow(dl, "Reason for handoff", decision.reason_for_handoff || "(none)");
  }

  function renderViolations(list) {
    var box = $("violations");
    box.innerHTML = "";
    var h = document.createElement("h3");
    h.textContent = "Safety warnings";
    h.style.fontSize = "13px";
    box.appendChild(h);
    if (!list || list.length === 0) {
      var p = document.createElement("p");
      p.className = "none-note";
      p.textContent = "No safety overrides were needed for this decision.";
      box.appendChild(p);
      return;
    }
    list.forEach(function (v) {
      var d = document.createElement("div");
      d.className = "violation " + v.severity;
      var sev = document.createElement("span");
      sev.className = "sev";
      sev.textContent = v.severity;
      d.appendChild(sev);
      d.appendChild(document.createTextNode(v.message));
      box.appendChild(d);
    });
  }

  function renderResult(data) {
    $("result").style.display = "block";
    renderDecision($("raw-fields"), data.raw);
    renderDecision($("final-fields"), data.final);
    var finalPanel = $("final-panel");
    var tag = $("overridden-tag");
    if (data.overridden) {
      finalPanel.classList.add("overridden");
      tag.innerHTML = '<span class="badge overridden-tag">Overridden by safety layer</span>';
    } else {
      finalPanel.classList.remove("overridden");
      tag.innerHTML = "";
    }
    renderViolations(data.violations);
  }

  function factsToText(facts) {
    return (facts || []).join("\\n");
  }
  function conversationToText(history) {
    return (history || []).map(function (m) { return "[" + m.date + "] " + m.from + ": " + m.body; }).join("\\n");
  }

  $("load-sample").addEventListener("click", function () {
    fetch("/api/sample")
      .then(function (r) { return r.json(); })
      .then(function (c) {
        $("invoice_id").value = c.invoice_id;
        $("customer").value = c.customer;
        $("amount").value = c.amount;
        $("currency").value = c.currency;
        $("days_overdue").value = c.days_overdue;
        $("invoice_facts").value = factsToText(c.invoice_facts);
        $("conversation").value = conversationToText(c.conversation_history);
        $("sample-note").textContent = "Sample loaded: " + c.invoice_id + " (demo fixture, not a real customer).";
        $("result").style.display = "none";
        setStatus(null, "");
      })
      .catch(function (err) {
        setStatus("error", "Could not load the sample case: " + err.message);
      });
  });

  $("analyze").addEventListener("click", function () {
    var btn = $("analyze");
    btn.disabled = true;
    setStatus(null, "");
    $("result").style.display = "none";

    var body = {
      invoice_id: $("invoice_id").value,
      customer: $("customer").value,
      amount: $("amount").value,
      currency: $("currency").value,
      days_overdue: $("days_overdue").value,
      invoice_facts: $("invoice_facts").value,
      conversation: $("conversation").value,
    };

    fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (data) { return { httpStatus: r.status, data: data }; }); })
      .then(function (res) {
        if (!res.data.ok) {
          var kind = res.httpStatus === 503 ? "unavailable" : "error";
          setStatus(kind, (res.data.errors || ["Analysis failed."]).join(" "));
          return;
        }
        renderResult(res.data);
      })
      .catch(function (err) {
        setStatus("error", "Request failed: " + err.message);
      })
      .then(function () {
        btn.disabled = false;
      });
  });
})();
</script>
</body>
</html>
`;

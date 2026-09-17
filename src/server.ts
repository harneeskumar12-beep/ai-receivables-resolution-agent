/**
 * HTTP server for the V1 receivables work-queue prototype. No framework, no
 * new dependencies - Node's built-in http module only.
 *
 * All classification/safety logic lives in the existing, unmodified core
 * (agent.ts, safety.ts, deterministic-classifier.ts, provider.ts) via
 * invoice-analysis.ts, which only maps a PrototypeInvoice into the existing
 * ReceivablesCase shape and calls ReceivablesAgent.resolve() +
 * validateDecision() - nothing is duplicated here. Conversation parsing
 * reuses parseConversationLines() from ui-handler.ts as-is.
 *
 * State is a single module-level InvoiceStore instance - in-memory only, no
 * database; it resets when the server restarts, which is intentional for
 * this prototype.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config as loadEnvFile } from "dotenv";
// Loads OPENROUTER_API_KEY / GEMINI_API_KEY from .env - same mechanism as
// run-evaluation.ts. Never logs a key's value.
loadEnvFile({ quiet: true });

import { resolveProvider } from "./resolve-provider.ts";
import type { AIProvider } from "./provider.ts";
import { parseInvoiceCsv } from "./csv-parser.ts";
import { InvoiceStore, daysOverdue } from "./invoice-store.ts";
import type { PrototypeInvoice } from "./invoice-store.ts";
import { analyzeInvoice } from "./invoice-analysis.ts";
import { WORK_QUEUE_HTML } from "./work-queue-ui.ts";
import { INVOICE_DETAIL_HTML } from "./invoice-detail-ui.ts";

const PORT = Number(process.env["PORT"] ?? 4000);
const MAX_BODY_BYTES = 200_000;

/** Single module-level in-memory store - resets on restart, by design. */
const store = new InvoiceStore();

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (raw.length === 0) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, error: "Request body is not valid JSON." };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/** JSON-serializable view of a stored invoice, with days_overdue computed against the given reference date. */
function serializeInvoice(inv: PrototypeInvoice, referenceDate: Date): Record<string, unknown> {
  return {
    invoice_id: inv.invoice_id,
    customer: inv.customer,
    customer_email: inv.customer_email,
    amount: inv.amount,
    currency: inv.currency,
    due_date: inv.due_date,
    status: inv.status,
    days_overdue: daysOverdue(inv.due_date, referenceDate),
    conversation: inv.conversation,
    analysis: inv.analysis,
    analysis_unavailable_reason: inv.analysis_unavailable_reason,
    draft_response: inv.draft_response,
    review_status: inv.review_status,
  };
}

const ID_ROUTE = /^\/api\/invoices\/([^/]+)(?:\/(conversation|analyze|draft|approve|reject))?$/;

function createApp(provider: AIProvider | null) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/") {
        sendHtml(res, WORK_QUEUE_HTML);
        return;
      }
      if (req.method === "GET" && pathname === "/invoice.html") {
        sendHtml(res, INVOICE_DETAIL_HTML);
        return;
      }

      if (req.method === "GET" && pathname === "/api/invoices") {
        const referenceDate = new Date();
        sendJson(res, 200, { ok: true, invoices: store.list().map((inv) => serializeInvoice(inv, referenceDate)) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/import-csv") {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, errors: [parsed.error] });
          return;
        }
        const body = parsed.body as Record<string, unknown>;
        const csv = typeof body["csv"] === "string" ? body["csv"] : "";
        const result = parseInvoiceCsv(csv);
        if (!result.ok) {
          sendJson(res, 400, { ok: false, errors: result.errors });
          return;
        }
        store.importFromRows(result.rows);
        sendJson(res, 200, { ok: true, count: result.rows.length });
        return;
      }

      const idMatch = ID_ROUTE.exec(pathname);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1] ?? "");
        const action = idMatch[2];
        const referenceDate = new Date();

        if (req.method === "GET" && action === undefined) {
          const inv = store.get(id);
          if (!inv) {
            sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
            return;
          }
          sendJson(res, 200, { ok: true, invoice: serializeInvoice(inv, referenceDate) });
          return;
        }

        if (req.method === "PATCH" && action === "conversation") {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, errors: [parsed.error] });
            return;
          }
          const body = parsed.body as Record<string, unknown>;
          const conversation = typeof body["conversation"] === "string" ? body["conversation"] : null;
          if (conversation === null) {
            sendJson(res, 400, { ok: false, errors: ["conversation must be a string."] });
            return;
          }
          if (!store.setConversation(id, conversation)) {
            sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && action === "analyze") {
          const inv = store.get(id);
          if (!inv) {
            sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
            return;
          }
          const result = await analyzeInvoice(inv, referenceDate, provider);
          if (!result.ok) {
            store.setAnalysisUnavailable(id, result.reason);
            sendJson(res, 200, { ok: false, errors: [result.reason] });
            return;
          }
          store.setAnalysisResult(id, result.result);
          sendJson(res, 200, { ok: true, invoice: serializeInvoice(inv, referenceDate) });
          return;
        }

        if (req.method === "PATCH" && action === "draft") {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, errors: [parsed.error] });
            return;
          }
          const body = parsed.body as Record<string, unknown>;
          const draft = typeof body["draft_response"] === "string" ? body["draft_response"] : null;
          if (draft === null) {
            sendJson(res, 400, { ok: false, errors: ["draft_response must be a string."] });
            return;
          }
          if (!store.setDraftResponse(id, draft)) {
            sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && action === "approve") {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, errors: [parsed.error] });
            return;
          }
          const body = parsed.body as Record<string, unknown>;
          const existing = store.get(id);
          const draft =
            typeof body["draft_response"] === "string" ? body["draft_response"] : (existing?.draft_response ?? "");
          if (!store.approve(id, draft)) {
            sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && action === "reject") {
          if (!store.reject(id)) {
            sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      sendJson(res, 404, { ok: false, errors: ["Not found."] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, errors: [`Unexpected server error: ${message}`] });
    }
  };
}

function main(): void {
  const resolved = resolveProvider();
  const provider = resolved?.provider ?? null;
  const server = createServer(createApp(provider));

  const HOST = "0.0.0.0";
  server.listen(PORT, HOST, () => {
    console.log(`AI Receivables Resolution Agent - work queue prototype listening on http://${HOST}:${PORT} (open http://localhost:${PORT} locally)`);
    console.log(
      resolved === null
        ? "No provider configured (OPENROUTER_API_KEY / GEMINI_API_KEY) - Analyze will report analysis as unavailable."
        : `Provider configured: ${resolved.kind}. Analyze will call it when clicked.`,
    );
  });
}

main();

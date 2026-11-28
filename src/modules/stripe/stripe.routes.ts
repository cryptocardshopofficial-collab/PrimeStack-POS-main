import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../../config/index.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";
import { ForbiddenError, ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { StripeService } from "./stripe.service.js";
import { createSepaIntentSchema } from "./stripe.types.js";

/**
 * Stripe SEPA Routes
 *
 * Public:
 *   GET  /stripe/sepa                    — collection page (HTML)
 *   POST /stripe/sepa/create-intent      — create PaymentIntent
 *   POST /stripe/webhook                 — Stripe event delivery
 *
 * Admin:
 *   GET  /admin/stripe/payments          — recent payments list
 *   GET  /admin/stripe/config            — Stripe configuration status
 */
export function registerStripeRoutes(
  app: FastifyInstance,
  service: StripeService,
): void {

  // ── SEPA Collection Page (public HTML) ──────────────────────
  app.get("/stripe/sepa", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store");
    return reply.send(sepaCollectionPage());
  });

  // ── Create PaymentIntent ─────────────────────────────────────
  // Public endpoint — called by the browser after sender fills form.
  // No HMAC required (this is a public payment page).
  app.post("/stripe/sepa/create-intent", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSepaIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid SEPA payment data", { errors: parsed.error.errors });
    }

    const result = await service.createSepaIntent(parsed.data);
    return sendCreated(reply, result);
  });

  // ── Stripe Webhook ───────────────────────────────────────────
  // Stripe signs the raw body — must use buffer parser.
  app.register(async (stripeScope) => {
    stripeScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => {
        try { done(null, JSON.parse((body as Buffer).toString("utf8"))); }
        catch (err) { done(err as Error, undefined); }
        ((_req as FastifyRequest & { rawBody?: Buffer }).rawBody) = body as Buffer;
      },
    );

    stripeScope.post(
      "/stripe/webhook",
      { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const rawBody   = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
        const signature = req.headers["stripe-signature"] as string | undefined;

        if (!rawBody) throw new ValidationError("Missing request body");
        if (!signature) throw new ValidationError("Missing Stripe-Signature header");

        const result = await service.handleWebhook(rawBody, signature);

        logger.info(
          { eventType: result.eventType, handled: result.handled, amount: result.amount },
          "Stripe webhook processed",
        );

        return reply.status(200).send({
          received:        true,
          handled:         result.handled,
          eventType:       result.eventType,
          journalEntryRef: result.journalEntryRef ?? null,
          message:         result.message,
        });
      },
    );
  });

  // ── Admin routes ─────────────────────────────────────────────
  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", async (request, reply) => {
      await adminApp.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      if (!role || !["SUPER_ADMIN", "ADMIN", "OPERATOR", "REVIEWER", "READONLY"].includes(role)) {
        throw new ForbiddenError("Your admin role cannot access Stripe management");
      }
    });

    adminApp.get("/admin/stripe/config", async (_req, reply) => {
      return sendSuccess(reply, {
        configured:          Boolean(config.stripe.secretKey),
        publishableKey:      config.stripe.publishableKey ? `${config.stripe.publishableKey.slice(0, 12)}...` : null,
        webhookConfigured:   Boolean(config.stripe.webhookSecret),
        currency:            config.stripe.currency,
        statementDescriptor: config.stripe.statementDescriptor,
        destinationAccount:  config.stripe.destinationAccount,
        receivingAccount: {
          name: config.stripe.receivingName,
          iban: "DE96 2022 0800 0029 3844 95",
          bic:  config.stripe.receivingBic,
          bank: config.stripe.receivingBank,
        },
        collectionUrl: "/stripe/sepa",
      });
    });

    adminApp.get("/admin/stripe/payments", async (req, reply) => {
      const query = req.query as { limit?: string };
      const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
      const payments = await service.listRecentPayments(limit);
      return sendSuccess(reply, { payments, count: payments.length });
    });
  }, { prefix: "" });
}

// ── SEPA Collection Page HTML ─────────────────────────────────

function sepaCollectionPage(): string {
  const pubKey = config.stripe.publishableKey || "";
  const receivingIban = "DE96 2022 0800 0029 3844 95";
  const receivingBic  = config.stripe.receivingBic;
  const receivingName = config.stripe.receivingName;
  const receivingBank = config.stripe.receivingBank;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEPA Payment — PrimeStack</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f7fb;color:#1a1a2e;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:520px;box-shadow:0 4px 32px rgba(0,0,0,.08)}
.logo{font-size:1.4rem;font-weight:800;color:#1a1a2e;margin-bottom:6px}
.logo span{color:#3578f6}
.subtitle{font-size:.85rem;color:#687183;margin-bottom:28px}
.receiving-box{background:#f0f7ff;border:1px solid #bdd6f7;border-radius:10px;padding:16px;margin-bottom:24px;font-size:.82rem}
.receiving-box .label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#3578f6;margin-bottom:10px}
.receiving-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #ddeeff}
.receiving-row:last-child{border:none}
.receiving-row .key{color:#687183}
.receiving-row .val{font-weight:600;font-family:monospace;font-size:.8rem}
.form-group{margin-bottom:16px}
label{display:block;font-size:.78rem;font-weight:600;color:#40516a;margin-bottom:6px}
input{width:100%;padding:11px 14px;border:1.5px solid #dfe7f1;border-radius:8px;font-size:.9rem;outline:none;transition:.2s}
input:focus{border-color:#3578f6;box-shadow:0 0 0 3px rgba(53,120,246,.1)}
.amount-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end}
.currency-badge{padding:11px 16px;background:#f4f7fb;border:1.5px solid #dfe7f1;border-radius:8px;font-weight:700;font-size:.9rem;color:#3578f6}
#stripe-iban-element{padding:11px 14px;border:1.5px solid #dfe7f1;border-radius:8px;background:#fff;min-height:44px;transition:.2s}
#stripe-iban-element.StripeElement--focus{border-color:#3578f6;box-shadow:0 0 0 3px rgba(53,120,246,.1)}
#stripe-iban-element.StripeElement--invalid{border-color:#e53e3e}
.mandate-box{background:#fffdf0;border:1px solid #fde68a;border-radius:8px;padding:14px;margin:16px 0;font-size:.75rem;line-height:1.6;color:#78350f}
.mandate-box strong{color:#92400e}
.btn{width:100%;padding:14px;background:#3578f6;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;transition:.2s;margin-top:4px}
.btn:hover{background:#2563eb;transform:translateY(-1px);box-shadow:0 6px 20px rgba(53,120,246,.3)}
.btn:disabled{background:#93a8c4;cursor:not-allowed;transform:none;box-shadow:none}
.error{color:#e53e3e;font-size:.8rem;margin-top:8px;padding:10px 12px;background:#fff5f5;border:1px solid #fed7d7;border-radius:7px;display:none}
.success{background:#f0fff4;border:1px solid #9ae6b4;border-radius:12px;padding:28px;text-align:center;display:none}
.success h2{color:#276749;font-size:1.3rem;margin-bottom:8px}
.success p{color:#48816e;font-size:.85rem}
.success .ref{font-family:monospace;background:#e6fffa;padding:4px 10px;border-radius:5px;color:#234e52;font-size:.8rem;margin-top:12px;display:inline-block}
.spinner{display:none;width:18px;height:18px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto}
@keyframes spin{to{transform:rotate(360deg)}}
.powered{text-align:center;margin-top:20px;font-size:.72rem;color:#9aabc0}
.powered a{color:#3578f6}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Prime<span>Stack</span></div>
  <div class="subtitle">Secure SEPA Direct Debit Collection · Powered by Stripe</div>

  <div class="receiving-box">
    <div class="label">Funds received by</div>
    <div class="receiving-row"><span class="key">Account</span><span class="val">${receivingName}</span></div>
    <div class="receiving-row"><span class="key">IBAN</span><span class="val">${receivingIban}</span></div>
    <div class="receiving-row"><span class="key">BIC</span><span class="val">${receivingBic}</span></div>
    <div class="receiving-row"><span class="key">Bank</span><span class="val">${receivingBank}</span></div>
  </div>

  <div id="payment-form">
    <div class="form-group">
      <label>Your Full Name *</label>
      <input id="sender-name" type="text" placeholder="John Smith" required>
    </div>

    <div class="form-group">
      <label>Your Email *</label>
      <input id="sender-email" type="email" placeholder="john@example.com" required>
    </div>

    <div class="form-group">
      <label>Amount (EUR) *</label>
      <div class="amount-row">
        <input id="amount" type="number" placeholder="500.00" min="1" step="0.01" required>
        <div class="currency-badge">EUR</div>
      </div>
    </div>

    <div class="form-group">
      <label>Your IBAN *</label>
      <div id="stripe-iban-element"></div>
    </div>

    <div class="form-group">
      <label>Payment Reference</label>
      <input id="reference" type="text" placeholder="Invoice number, purpose...">
    </div>

    <div class="mandate-box">
      <strong>SEPA Direct Debit Mandate:</strong> By providing your IBAN and confirming this payment, you authorise
      <strong>LOUIS CALTEN INTERNATIONAL LLP</strong> and Stripe, our payment service provider, to send instructions
      to your bank to debit your account. You are entitled to a refund from your bank under the terms and conditions
      of your agreement with your bank. A refund must be claimed within 8 weeks starting from the date on which
      your account was debited.
    </div>

    <div id="error-msg" class="error"></div>

    <button class="btn" id="pay-btn" onclick="submitPayment()">
      <span id="btn-text">Pay via SEPA Direct Debit</span>
      <div class="spinner" id="btn-spinner"></div>
    </button>
  </div>

  <div class="success" id="success-box">
    <h2>✓ Payment authorised</h2>
    <p>Your SEPA Direct Debit has been authorised. Funds will be collected within 1–3 business days and credited to the platform.</p>
    <div class="ref" id="success-ref"></div>
  </div>

  <div class="powered">Secured by <a href="https://stripe.com" target="_blank">Stripe</a> · SEPA Direct Debit</div>
</div>

<script>
${pubKey ? `
const stripe = Stripe('${pubKey}');
const elements = stripe.elements();
const ibanElement = elements.create('iban', {
  supportedCountries: ['SEPA'],
  placeholderCountry: 'DE',
  style: {
    base: { fontSize: '15px', color: '#1a1a2e', '::placeholder': { color: '#9aabc0' } },
    invalid: { color: '#e53e3e' },
  },
});
ibanElement.mount('#stripe-iban-element');

async function submitPayment() {
  const name      = document.getElementById('sender-name').value.trim();
  const email     = document.getElementById('sender-email').value.trim();
  const amountRaw = parseFloat(document.getElementById('amount').value);
  const reference = document.getElementById('reference').value.trim();
  const errEl     = document.getElementById('error-msg');

  errEl.style.display = 'none';

  if (!name)              { showError('Full name is required'); return; }
  if (!email)             { showError('Email is required'); return; }
  if (!amountRaw || amountRaw < 1) { showError('Amount must be at least €1.00'); return; }

  const amountCents = Math.round(amountRaw * 100);
  setBusy(true);

  try {
    // 1. Create PaymentIntent on server
    const intentRes = await fetch('/stripe/sepa/create-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountCents, senderName: name, senderEmail: email, reference }),
    });
    const intentData = await intentRes.json();
    if (!intentRes.ok || !intentData.data?.clientSecret) {
      showError(intentData.message || intentData.data?.error?.message || 'Failed to create payment. Please try again.');
      setBusy(false);
      return;
    }

    // 2. Confirm with Stripe.js (sender authorises mandate)
    const { error, paymentIntent } = await stripe.confirmSepaDebitPayment(
      intentData.data.clientSecret,
      {
        payment_method: {
          sepa_debit: ibanElement,
          billing_details: { name, email },
        },
      }
    );

    if (error) {
      showError(error.message || 'Payment failed. Please check your IBAN and try again.');
      setBusy(false);
      return;
    }

    // Success
    document.getElementById('payment-form').style.display = 'none';
    document.getElementById('success-box').style.display = 'block';
    document.getElementById('success-ref').textContent = 'Reference: ' + (paymentIntent.id || 'confirmed');

  } catch (err) {
    showError('Network error. Please try again.');
    setBusy(false);
  }
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
}

function setBusy(busy) {
  document.getElementById('pay-btn').disabled = busy;
  document.getElementById('btn-text').style.display = busy ? 'none' : 'inline';
  document.getElementById('btn-spinner').style.display = busy ? 'block' : 'none';
}
` : `
// Stripe not configured — show placeholder
document.getElementById('stripe-iban-element').innerHTML =
  '<div style="padding:12px;color:#e53e3e;font-size:.8rem">Stripe is not configured. Add STRIPE_PUBLISHABLE_KEY to environment variables.</div>';
document.getElementById('pay-btn').disabled = true;
document.getElementById('btn-text').textContent = 'Stripe not configured';
`}
</script>
</body>
</html>`;
}

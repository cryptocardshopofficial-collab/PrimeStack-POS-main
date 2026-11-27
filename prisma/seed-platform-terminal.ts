/**
 * PrimeStack Switch — Platform Terminal Seed
 *
 * Provisions the platform's own built-in receiving terminal:
 *   TID:      EP022162
 *   MSN:      PSM-4AA182A2
 *   Merchant: M/S.UNITED SOLAR AND WIND POWER TECHNOLOGIES
 *
 * This terminal is the rail entry point for real T2T inbound funds.
 * Every T2T transfer that targets EP022162 credits the double-entry
 * ledger account TERMINAL-EP022162-<CURRENCY>.
 *
 * Bank settlement details are stored in terminal.config so the
 * platform operator can display them to counterparties.
 *
 * Currencies provisioned: USD, EUR, GBP, AED, INR
 *
 * Run with:
 *   npx tsx prisma/seed-platform-terminal.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Constants ────────────────────────────────────────────────────

const PLATFORM_TID        = "EP022162";
const PLATFORM_MSN        = "PSM-4AA182A2";
const PLATFORM_SERIAL     = "PSN-EP022162-001";
const PLATFORM_MERCHANT_CODE = "PSM-4AA182A2"; // production merchant

const SETTLEMENT_CURRENCIES = ["USD", "EUR", "GBP", "AED", "INR"] as const;

/**
 * Real-world bank settlement details for this terminal.
 * These are displayed to T2T counterparties as the receiving bank.
 */
const BANK_SETTLEMENT_DETAILS = {
  bankName:        "ICICI Bank",
  bankAddress:     "148/751, 26th Main Road, Jaya Nagar 9th Block, Bengaluru, Karnataka 560069, India",
  accountName:     "M/S.UNITED SOLAR AND WIND POWER TECHNOLOGIES",
  accountNumber:   "029905003783",
  swiftCode:       "ICICINBBXXX",
  swiftNri:        "ICICINBBNRI",    // NRI / international remittance BIC
  ifscCode:        "ICIC0000299",    // domestic India transfers
  micrCode:        "560229022",
  vpa:             "MSUNITEDSOLARANDWINDPOWERTECHNOLOGIES.eazypay1@icici",
  merchantId:      "100000000036000",
  msn:             PLATFORM_MSN,
  serverIp1:       "74.220.49.0/24",
  serverPort1:     443,
  serverIp2:       "74.220.57.0/24",
  serverPort2:     443,
};

// ── Helpers ──────────────────────────────────────────────────────

function terminalAccountCode(tid: string, currency: string): string {
  return `TERMINAL-${tid}-${currency.toUpperCase()}`;
}

async function ensureTerminalAccount(
  tid: string,
  currency: string,
): Promise<string> {
  const code = terminalAccountCode(tid, currency);
  await prisma.account.upsert({
    where:  { code },
    update: {},
    create: {
      code,
      name:     `Platform Terminal: ${tid} (${currency})`,
      type:     "LIABILITY",
      subtype:  "TERMINAL",
      currency: currency.toUpperCase(),
      balance:  0,
    },
  });
  return code;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("Provisioning platform terminal EP022162...\n");

  // ── 1. Resolve platform merchant ───────────────
  const merchant = await prisma.merchant.findFirst({
    where: { code: PLATFORM_MERCHANT_CODE },
    select: { id: true, code: true, legalName: true },
  });

  if (!merchant) {
    throw new Error(
      `Merchant ${PLATFORM_MERCHANT_CODE} not found. ` +
      "Run the main seed first: npx tsx prisma/seed.ts",
    );
  }
  console.log(`✓ Merchant: ${merchant.code} (${merchant.legalName})`);

  // ── 2. Create / update terminal ─────────────────
  const existing = await prisma.terminal.findUnique({
    where: { tid: PLATFORM_TID },
  });

  let terminal;
  if (existing) {
    terminal = await prisma.terminal.update({
      where: { id: existing.id },
      data: {
        serialNumber:    PLATFORM_SERIAL,
        model:           "PrimeStack Platform Terminal v1",
        osVersion:       "PSN-OS-1.0",
        firmwareVersion: "FW-EP022162-1.0.0",
        location:        "PrimeStack Global Server Network",
        city:            "Bengaluru",
        country:         "IN",
        timezone:        "Asia/Kolkata",
        status:          "ACTIVE",
        config: {
          currencies:    [...SETTLEMENT_CURRENCIES],
          bankSettlement: BANK_SETTLEMENT_DETAILS,
          terminalType:  "PLATFORM_RAIL",
          description:   "Built-in platform receiving terminal for T2T inbound funds",
          msn:           PLATFORM_MSN,
        },
      },
    });
    console.log(`✓ Terminal EP022162 updated → ACTIVE`);
  } else {
    terminal = await prisma.terminal.create({
      data: {
        tid:             PLATFORM_TID,
        mid:             BANK_SETTLEMENT_DETAILS.merchantId,
        serialNumber:    PLATFORM_SERIAL,
        merchantId:      merchant.id,
        model:           "PrimeStack Platform Terminal v1",
        osVersion:       "PSN-OS-1.0",
        firmwareVersion: "FW-EP022162-1.0.0",
        location:        "PrimeStack Global Server Network",
        city:            "Bengaluru",
        country:         "IN",
        timezone:        "Asia/Kolkata",
        status:          "ACTIVE",
        config: {
          currencies:    [...SETTLEMENT_CURRENCIES],
          bankSettlement: BANK_SETTLEMENT_DETAILS,
          terminalType:  "PLATFORM_RAIL",
          description:   "Built-in platform receiving terminal for T2T inbound funds",
          msn:           PLATFORM_MSN,
        },
      },
    });
    console.log(`✓ Terminal EP022162 created → ACTIVE`);
  }

  // ── 3. Health record ────────────────────────────
  await prisma.terminalHealth.upsert({
    where:  { terminalId: terminal.id },
    update: { status: "ONLINE", heartbeatAt: new Date(), lastCheckedAt: new Date() },
    create: {
      terminalId: terminal.id,
      status:     "ONLINE",
      heartbeatAt: new Date(),
      lastCheckedAt: new Date(),
    },
  });
  console.log("✓ Terminal health → ONLINE");

  // ── 4. Ledger accounts for every currency ───────
  console.log("\nProvisioning receiving accounts:");
  for (const currency of SETTLEMENT_CURRENCIES) {
    const code = await ensureTerminalAccount(PLATFORM_TID, currency);
    console.log(`  ✓ ${code}`);
  }

  // ── 5. T2T IP whitelist entries ─────────────────
  // Both Render outbound CIDR ranges whitelisted so the platform
  // can send and receive T2T transfers to/from itself.
  const whitelistEntries = [
    { ip: "74.220.49.1",  note: "Render outbound range 1 (74.220.49.0/24)" },
    { ip: "74.220.57.1",  note: "Render outbound range 2 (74.220.57.0/24)" },
  ];

  console.log("\nWhitelisting platform server IPs for T2T:");
  for (const entry of whitelistEntries) {
    await prisma.$executeRaw`
      INSERT INTO "T2tIpWhitelist" (id, ip, note, callback_url, merchant_id)
      VALUES (
        gen_random_uuid(),
        ${entry.ip},
        ${entry.note},
        NULL,
        NULL
      )
      ON CONFLICT (ip, merchant_id) DO UPDATE
        SET note = EXCLUDED.note
    `;
    console.log(`  ✓ ${entry.ip}`);
  }

  // ── 6. Summary ──────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  PLATFORM TERMINAL READY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  TID:            ${PLATFORM_TID}`);
  console.log(`  MSN:            ${PLATFORM_MSN}`);
  console.log(`  Status:         ACTIVE / ONLINE`);
  console.log(`  Merchant:       ${merchant.code}`);
  console.log(`  Currencies:     ${SETTLEMENT_CURRENCIES.join(", ")}`);
  console.log(`  Bank:           ICICI Bank — ICICINBBXXX`);
  console.log(`  Account:        029905003783`);
  console.log(`  Account Name:   M/S.UNITED SOLAR AND WIND POWER TECHNOLOGIES`);
  console.log("");
  console.log("  LEDGER ACCOUNTS:");
  for (const currency of SETTLEMENT_CURRENCIES) {
    console.log(`    TERMINAL-${PLATFORM_TID}-${currency}`);
  }
  console.log("");
  console.log("  T2T RECEIVE ENDPOINT:");
  console.log("    POST /t2t/transfer");
  console.log(`    { destId: "${PLATFORM_TID}", sourceId: "<sender TID>", amount, currency }`);
  console.log("");
  console.log("  REAL FUNDS PATH:");
  console.log("    Counterparty wires to ICICI 029905003783");
  console.log("    → Wire confirmed on bank statement");
  console.log("    → POST /t2t/inbound { tid: 'EP022162', amount, currency, reference }");
  console.log("    → Ledger credited automatically");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main()
  .catch((err) => {
    console.error("Terminal seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

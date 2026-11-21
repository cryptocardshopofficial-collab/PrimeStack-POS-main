/**
 * Read-only inbound reconciliation.
 *
 * Answers one question: for every ledger account, how much of its balance is
 * backed by a recorded external-funds inbound (JournalEntry.source = "INBOUND",
 * posted by the inbound webhook path in src/modules/t2t/t2t.routes.ts) versus
 * money that only moved between accounts inside this ledger (internal
 * transfers, payouts, adjustments)?
 *
 * It writes nothing and moves no money.
 *
 * IMPORTANT: this can confirm internal consistency, it cannot prove the funds
 * are real. "INBOUND" only means *this system recorded an external credit*.
 * Proving the money exists requires the provider's own statement (e.g. a Wise
 * settlement report) reconciled against the SYSTEM-FUNDING-* accounts below.
 *
 * Usage:  npx tsx scripts/reconcile-inbound.ts [--currency USD]
 */
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

loadEnv();

const prisma = new PrismaClient();
const FUNDING_PREFIX =
  process.env.INBOUND_FUNDING_ACCOUNT_PREFIX?.trim() || "SYSTEM-FUNDING";

type Row = {
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  currency: string;
  balance: string;
  external_credits: string;
  external_debits: string;
  internal_credits: string;
  internal_debits: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function money(value: Decimal): string {
  return value.toFixed(4);
}

async function main(): Promise<void> {
  const currencyFilter = arg("--currency")?.toUpperCase();

  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT
      a.code,
      a.name,
      a.type::text AS type,
      a.subtype,
      a.currency,
      a.balance::text AS balance,
      COALESCE(SUM(CASE WHEN je.status = 'POSTED' AND je.source = 'INBOUND' THEN jl.credit ELSE 0 END), 0)::text AS external_credits,
      COALESCE(SUM(CASE WHEN je.status = 'POSTED' AND je.source = 'INBOUND' THEN jl.debit  ELSE 0 END), 0)::text AS external_debits,
      COALESCE(SUM(CASE WHEN je.status = 'POSTED' AND (je.source IS DISTINCT FROM 'INBOUND') THEN jl.credit ELSE 0 END), 0)::text AS internal_credits,
      COALESCE(SUM(CASE WHEN je.status = 'POSTED' AND (je.source IS DISTINCT FROM 'INBOUND') THEN jl.debit  ELSE 0 END), 0)::text AS internal_debits
    FROM "Account" a
    LEFT JOIN "JournalLine" jl ON jl."accountId" = a.id
    LEFT JOIN "JournalEntry" je ON je.id = jl."entryId"
    GROUP BY a.id, a.code, a.name, a.type, a.subtype, a.currency, a.balance
    ORDER BY a.code
  `);

  const accounts = rows
    .map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      currency: r.currency,
      balance: new Decimal(r.balance),
      externalCredits: new Decimal(r.external_credits),
      externalDebits: new Decimal(r.external_debits),
      internalCredits: new Decimal(r.internal_credits),
      internalDebits: new Decimal(r.internal_debits),
    }))
    .filter((a) => !currencyFilter || a.currency === currencyFilter);

  console.log("\nPrimeStack inbound reconciliation (read-only)");
  console.log(`Generated: ${new Date().toISOString()}`);
  if (currencyFilter) console.log(`Currency filter: ${currencyFilter}`);

  if (accounts.length === 0) {
    console.log("\nNo accounts found.\n");
    return;
  }

  const isFunding = (a: { code: string; subtype: string | null }) =>
    a.subtype === "FUNDING" || a.code.startsWith(`${FUNDING_PREFIX}-`);

  const fundingAccounts = accounts.filter(isFunding);
  const valueAccounts = accounts.filter((a) => !isFunding(a));

  // Every external inbound credits exactly one target account and debits the
  // funding counter-account, so the sum of recorded external credits is the
  // total amount of externally-declared money in this ledger.
  let totalExternalDeclared = new Decimal(0);
  for (const a of accounts) {
    totalExternalDeclared = totalExternalDeclared.plus(a.externalCredits);
  }

  // ── Funding counter-accounts ───────────────────────────────────────────
  console.log("\nFunding counter-accounts (debited on every external inbound):");
  if (fundingAccounts.length === 0) {
    console.log("  (none) — no external funds have ever been credited here.");
  }
  for (const a of fundingAccounts) {
    console.log(
      `  ${a.code.padEnd(28)} balance=${money(a.balance).padStart(16)}  ` +
        `external_debits=${money(a.externalDebits).padStart(16)}  external_credits=${money(a.externalCredits).padStart(16)}`,
    );
  }

  // ── Per-account backing ────────────────────────────────────────────────
  console.log(
    "\nAccounts (external = backed by recorded external inbound; internal = moved inside this ledger):",
  );
  const codeW = Math.max(6, ...accounts.map((a) => a.code.length));
  const header =
    "  " +
    "code".padEnd(codeW) +
    "type".padEnd(12) +
    "balance".padStart(18) +
    "ext_in".padStart(18) +
    "int_in".padStart(18) +
    "int_out".padStart(18) +
    "  verdict";
  console.log(header);
  console.log("  " + "-".repeat(header.length - 2));

  const unbacked: { code: string; excess: Decimal }[] = [];
  let totalValueBalance = new Decimal(0);

  for (const a of valueAccounts.sort((x, y) => x.code.localeCompare(y.code))) {
    totalValueBalance = totalValueBalance.plus(a.balance);

    let verdict: string;
    if (a.balance.lte(0)) {
      verdict = "empty/non-positive";
    } else if (a.externalCredits.isZero() && a.internalCredits.isZero()) {
      verdict = "UNBACKED — no funding recorded at all";
      unbacked.push({ code: a.code, excess: a.balance });
    } else if (a.balance.lte(a.externalCredits)) {
      verdict = "backed (external)";
    } else {
      const excess = a.balance.minus(a.externalCredits);
      verdict = `PARTIAL — ${money(excess)} not backed by any external inbound`;
      unbacked.push({ code: a.code, excess });
    }

    console.log(
      "  " +
        a.code.padEnd(codeW) +
        a.type.padEnd(12) +
        money(a.balance).padStart(18) +
        money(a.externalCredits).padStart(18) +
        money(a.internalCredits).padStart(18) +
        money(a.internalDebits).padStart(18) +
        "  " +
        verdict,
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\nSummary");
  console.log(`  external declared inbound (recorded external credits) : ${money(totalExternalDeclared)}`);
  console.log(`  total balance on value accounts                    : ${money(totalValueBalance)}`);
  console.log(`  accounts holding balances not backed externally   : ${unbacked.length}`);
  for (const u of unbacked) {
    console.log(`    - ${u.code.padEnd(30)} excess over external funding = ${money(u.excess)}`);
  }

  console.log(
    "\nNote: a positive result here means the ledger is internally consistent — every" +
      "\nreviewed balance is explained by a recorded inbound. It does NOT prove the money" +
      "\nexists at the provider. To close that gap, take the SYSTEM-FUNDING-* totals above" +
      "\nand match them against the provider's settlement statement; any amount with no" +
      "\nprovider-side settlement behind it is unfunded.",
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error("Reconciliation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

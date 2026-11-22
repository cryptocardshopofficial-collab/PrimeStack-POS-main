/**
 * Remove SUPE settlement postings that inflated the platform reserve.
 *
 * Why this exists
 * ---------------
 * Every SUPE settlement credits PLATFORM:RESERVE:{CUR}. Before the ingest path
 * was fixed, a camt.054 status leg posted a *second* credit for the same
 * settlement, so one $50,000 upload could move $100,000. Repeated test uploads
 * accumulate a reserve far larger than the money that actually settled.
 *
 * What it does
 * ------------
 * Finds every JournalEntry whose source matches (default "SUPE"), reverses each
 * line's balance impact on its account, then deletes the entry (its lines
 * cascade). Nothing else is touched — non-SUPE entries are never read or
 * written.
 *
 * Safe by default: with no flags it is a DRY RUN that only prints what it would
 * reverse. Pass --confirm to actually write.
 *
 * Usage
 * -----
 *   npx tsx scripts/purge-supe-entries.ts                 # dry run (report only)
 *   npx tsx scripts/purge-supe-entries.ts --confirm       # apply
 *   npx tsx scripts/purge-supe-entries.ts --source SUPE --confirm
 *   npx tsx scripts/purge-supe-entries.ts --currency USD --confirm
 *
 * IMPORTANT: run this against the database you mean to change. On Render, open
 * the service Shell and run it there so DATABASE_URL points at production.
 */
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

loadEnv();

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CONFIRM = process.argv.includes("--confirm");
const SOURCE = arg("--source")?.trim() || "SUPE";
const CURRENCY = arg("--currency")?.toUpperCase();

/** Mirrors ledger.service.ts computeBalanceChange — the exact rule the ledger used. */
function balanceChange(accountType: string, debit: Decimal, credit: Decimal): Decimal {
  const isDebitNormal = accountType === "ASSET" || accountType === "EXPENSE";
  return isDebitNormal ? debit.minus(credit) : credit.minus(debit);
}

function money(value: Decimal): string {
  return value.toFixed(4);
}

async function main(): Promise<void> {
  const entries = await prisma.journalEntry.findMany({
    where: {
      source: SOURCE,
      ...(CURRENCY ? { lines: { some: { currency: CURRENCY } } } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: {
      lines: {
        include: { account: { select: { id: true, code: true, type: true } } },
      },
    },
  });

  console.log("\nPrimeStack SUPE posting purge");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Mode:      ${CONFIRM ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`Source:    ${SOURCE}`);
  if (CURRENCY) console.log(`Currency:  ${CURRENCY}`);
  console.log(`Entries:   ${entries.length}`);

  if (entries.length === 0) {
    console.log("\nNothing to do — no matching entries.\n");
    return;
  }

  // Account code -> net balance change caused by these entries.
  const reversals = new Map<string, { accountId: string; delta: Decimal }>();
  let totalCreditAmount = new Decimal(0);

  for (const entry of entries) {
    for (const line of entry.lines) {
      const debit = new Decimal(line.debit.toString());
      const credit = new Decimal(line.credit.toString());
      totalCreditAmount = totalCreditAmount.plus(credit);
      const change = balanceChange(line.account.type, debit, credit);
      const prev = reversals.get(line.account.code);
      reversals.set(line.account.code, {
        accountId: line.account.id,
        delta: (prev?.delta ?? new Decimal(0)).plus(change),
      });
    }
  }

  console.log("\nBalance reversal (submitted back out of each account):");
  for (const [code, r] of [...reversals.entries()].sort()) {
    console.log(`  ${code.padEnd(32)} ${money(r.delta.neg()).padStart(18)}`);
  }

  const accounts = await prisma.account.findMany({
    where: { id: { in: [...reversals.values()].map((r) => r.accountId) } },
    select: { id: true, code: true, balance: true },
  });
  console.log("\nAccount balances before -> after:");
  for (const a of accounts.sort((x, y) => x.code.localeCompare(y.code))) {
    const delta = reversals.get(a.code)?.delta ?? new Decimal(0);
    const before = new Decimal(a.balance.toString());
    console.log(
      `  ${a.code.padEnd(32)} ${money(before).padStart(16)} -> ${money(before.minus(delta)).padStart(16)}`,
    );
  }

  console.log(`\nTotal credit removed: ${money(totalCreditAmount)}`);

  if (!CONFIRM) {
    console.log("\nDry run complete. Re-run with --confirm to apply.\n");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const r of reversals.values()) {
      await tx.account.update({
        where: { id: r.accountId },
        data: { balance: { decrement: r.delta.toNumber() } },
      });
    }
    await tx.journalEntry.deleteMany({
      where: { id: { in: entries.map((e) => e.id) } },
    });
  });

  console.log(`\nApplied. Reversed balances and deleted ${entries.length} entries.\n`);
}

main()
  .catch((error) => {
    console.error("Purge failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

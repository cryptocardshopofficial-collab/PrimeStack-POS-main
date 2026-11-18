import { Prisma, type PrismaClient } from "@prisma/client";
import { randomBytes, randomInt, randomUUID } from "crypto";
import { Decimal } from "../../core/decimal.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { hashPassword, verifyPassword } from "../../shared/utils/crypto.js";
import {
  encryptVaultPayload,
  lastFour,
} from "../admin/bank-account-vault.js";
import type {
  CreateMerchantBankAccountInput,
  CreateMerchantInput,
  UpdateMerchantInput,
} from "./merchant.types.js";

function money(
  value: string,
  name: string,
  allowZero = true,
  scale = 2,
  integerDigits = 16,
): Decimal {
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new ValidationError(`${name} must be a valid amount`);
  }
  if (
    !amount.isFinite() ||
    (allowZero ? amount.lt(0) : amount.lte(0)) ||
    amount.decimalPlaces() > scale ||
    amount.abs().gte(new Decimal(10).pow(integerDigits))
  ) {
    throw new ValidationError(
      `${name} must be ${allowZero ? "non-negative" : "positive"} and fit a decimal(${integerDigits + scale}, ${scale}) amount`,
    );
  }
  return amount;
}

/**
 * Merchant Service
 *
 * Handles the merchant lifecycle:
 *   - Onboarding (create merchant + auto-create KYC record)
 *   - Profile management
 *   - Merchant status transitions
 *   - Merchant-level stats
 */
export class MerchantService {
  constructor(private prisma: PrismaClient) {}

  async createMerchant(input: CreateMerchantInput) {
    // Check for duplicate code or email
    const existing = await this.prisma.merchant.findFirst({
      where: {
        OR: [{ code: input.code }, { email: input.email }],
      },
    });
    if (existing) {
      throw new ConflictError(
        "Merchant with this code or email already exists",
      );
    }

    const merchant = await this.prisma.$transaction(async (tx) => {
      // Create merchant
      const m = await tx.merchant.create({
        data: {
          code: input.code,
          legalName: input.legalName,
          displayName: input.displayName,
          dbaName: input.dbaName,
          email: input.email,
          phone: input.phone,
          country: input.country,
          preferredLang: input.preferredLang,
          mcc: input.mcc,
          merchantCategory: input.merchantCategory,
          website: input.website,
          taxId: input.taxId,
          status: "PENDING",
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      // Auto-create KYC record
      await tx.kycRecord.create({
        data: {
          merchantId: m.id,
          status: "NOT_STARTED",
        },
      });

      // Auto-create ledger account for this merchant
      await tx.account.create({
        data: {
          code: `MERCHANT-${m.code}-USD`,
          name: `Merchant Account: ${m.code}`,
          type: "LIABILITY",
          subtype: "MERCHANT",
          currency: "USD",
        },
      });

      logger.info({ merchantId: m.id, code: m.code }, "Merchant created");
      return m;
    });

    return merchant;
  }

  async getMerchant(id: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      include: {
        kycRecord: true,
        merchantIds: true,
        riskProfile: true,
        pricingPlan: true,
        merchantAccounts: {
          include: { wallet: true, settlementAccount: true },
        },
        invoices: { orderBy: { createdAt: "desc" }, take: 10 },
        paymentLinks: { orderBy: { createdAt: "desc" }, take: 10 },
        kycDocuments: { orderBy: { createdAt: "desc" } },
        agent: true,
        _count: {
          select: {
            terminals: true,
            wallets: true,
            transactions: true,
          },
        },
      },
    });
    if (!merchant) throw new NotFoundError("Merchant", id);
    return merchant;
  }

  async getMerchantByCode(code: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { code },
      include: { kycRecord: true },
    });
    if (!merchant) throw new NotFoundError("Merchant", code);
    return merchant;
  }

  async getPortalProfile(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        code: true,
        legalName: true,
        displayName: true,
        email: true,
        phone: true,
        country: true,
        status: true,
        createdAt: true,
        _count: { select: { terminals: true, transactions: true } },
      },
    });
    if (!merchant) throw new NotFoundError("Merchant", merchantId);
    return merchant;
  }

  async createPortalCredentials(
    merchantId: string,
    createdBy: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const temporaryPassword = randomBytes(18).toString("base64url");
    const passwordHash = await hashPassword(temporaryPassword);
    // Numeric PIN the merchant must enter alongside the password. Issued by the
    // administrator and rotated whenever credentials are (re)provisioned.
    const portalPin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const portalPinHash = await hashPassword(portalPin);

    const user = await this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, legalName: true, email: true },
      });
      if (!merchant) throw new NotFoundError("Merchant", merchantId);

      const existing = await tx.user.findUnique({ where: { merchantId } });
      if (existing && existing.role !== "MERCHANT") {
        throw new ConflictError("The linked portal account is not a merchant account");
      }

      const conflictingUser = await tx.user.findFirst({
        where: {
          OR: [{ email: merchant.email }, { username: merchant.email }],
        },
        select: { id: true },
      });
      if (conflictingUser && conflictingUser.id !== existing?.id) {
        throw new ConflictError(
          "A user already uses the merchant's email address; resolve that account before provisioning portal access",
        );
      }

      const credentials = {
        email: merchant.email,
        username: merchant.email,
        passwordHash,
        portalPinHash,
        fullName: merchant.legalName,
        role: "MERCHANT" as const,
        merchantId: merchant.id,
        mustChangePassword: true,
        isActive: true,
      };
      const portalUser = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: credentials,
            select: { id: true, email: true, role: true },
          })
        : await tx.user.create({
            data: credentials,
            select: { id: true, email: true, role: true },
          });

      await tx.auditLog.create({
        data: {
          userId: createdBy,
          merchantId,
          action: existing
            ? "RESET_MERCHANT_PORTAL_CREDENTIALS"
            : "CREATE_MERCHANT_PORTAL_CREDENTIALS",
          entity: "User",
          entityId: portalUser.id,
          before: existing
            ? {
                email: existing.email,
                role: existing.role,
                mustChangePassword: existing.mustChangePassword,
              }
            : undefined,
          after: {
            email: portalUser.email,
            role: portalUser.role,
            mustChangePassword: true,
          },
          ipAddress,
          userAgent,
        },
      });

      return portalUser;
    });

    return {
      userId: user.id,
      email: user.email,
      temporaryPassword,
      portalPin,
      requirePasswordChange: true,
    };
  }

  async changePortalPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || user.role !== "MERCHANT" || !user.merchantId) {
      throw new UnauthorizedError("Merchant portal account is unavailable");
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedError("Current password is incorrect");
    }
    if (currentPassword === newPassword) {
      throw new ValidationError("New password must differ from the current password");
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: {
          id: userId,
          passwordHash: user.passwordHash,
          isActive: true,
          role: "MERCHANT",
        },
        data: { passwordHash, mustChangePassword: false },
      });
      if (changed.count !== 1) {
        throw new ConflictError("Account credentials changed; sign in and try again");
      }
      await tx.auditLog.create({
        data: {
          userId,
          merchantId: user.merchantId,
          action: "CHANGE_MERCHANT_PORTAL_PASSWORD",
          entity: "User",
          entityId: userId,
          before: { mustChangePassword: user.mustChangePassword },
          after: { mustChangePassword: false },
          ipAddress,
          userAgent,
        },
      });
    });

    return { mustChangePassword: false };
  }

  // ── Merchant bank accounts (commission payout destinations) ──────

  /** Masked projection — full account details never leave the server. */
  private presentBankAccount(account: {
    id: string;
    label: string;
    bankName: string;
    accountName: string;
    accountLast4: string;
    currency: string;
    isDefault: boolean;
    createdAt: Date;
  }) {
    return {
      id: account.id,
      label: account.label,
      bankName: account.bankName,
      accountName: account.accountName,
      maskedAccountNumber: `••••${account.accountLast4}`,
      currency: account.currency,
      isDefault: account.isDefault,
      createdAt: account.createdAt,
    };
  }

  async listMerchantBankAccounts(merchantId: string) {
    await this.requireMerchant(merchantId);
    const accounts = await this.prisma.merchantBankAccount.findMany({
      where: { merchantId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
    return accounts.map((account) => this.presentBankAccount(account));
  }

  async createMerchantBankAccount(
    merchantId: string,
    createdByUserId: string,
    input: CreateMerchantBankAccountInput,
    ipAddress?: string,
    userAgent?: string,
  ) {
    await this.requireMerchant(merchantId);
    const encryptedDetails = encryptVaultPayload({
      accountNumber: input.accountNumber.replace(/\s+/g, ""),
      routingNumber: input.routingNumber ?? null,
      swiftCode: input.swiftCode ?? null,
      bankAddress: input.bankAddress ?? null,
    });
    const accountLast4 = lastFour(input.accountNumber);

    const account = await this.prisma.$transaction(async (tx) => {
      // Only one default at a time; a new default demotes the previous one.
      if (input.isDefault) {
        await tx.merchantBankAccount.updateMany({
          where: { merchantId, isDefault: true },
          data: { isDefault: false },
        });
      }
      const created = await tx.merchantBankAccount.create({
        data: {
          merchantId,
          label: input.label.trim(),
          bankName: input.bankName.trim(),
          accountName: input.accountName.trim(),
          accountLast4,
          currency: input.currency,
          encryptedDetails,
          isDefault: input.isDefault ?? false,
          createdByUserId,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: createdByUserId,
          merchantId,
          action: "CREATE_MERCHANT_BANK_ACCOUNT",
          entity: "MerchantBankAccount",
          entityId: created.id,
          after: {
            label: created.label,
            bankName: created.bankName,
            accountLast4: created.accountLast4,
            currency: created.currency,
            isDefault: created.isDefault,
          },
          ipAddress,
          userAgent,
        },
      });
      return created;
    });

    return this.presentBankAccount(account);
  }

  async setDefaultMerchantBankAccount(
    merchantId: string,
    accountId: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.merchantBankAccount.findFirst({
        where: { id: accountId, merchantId },
      });
      if (!account) throw new NotFoundError("Merchant bank account", accountId);

      await tx.merchantBankAccount.updateMany({
        where: { merchantId, isDefault: true },
        data: { isDefault: false },
      });
      const updated = await tx.merchantBankAccount.update({
        where: { id: accountId },
        data: { isDefault: true },
      });
      await tx.auditLog.create({
        data: {
          userId,
          merchantId,
          action: "SET_DEFAULT_MERCHANT_BANK_ACCOUNT",
          entity: "MerchantBankAccount",
          entityId: accountId,
          after: { isDefault: true },
          ipAddress,
          userAgent,
        },
      });
      return this.presentBankAccount(updated);
    });
  }

  async deleteMerchantBankAccount(
    merchantId: string,
    accountId: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.merchantBankAccount.findFirst({
        where: { id: accountId, merchantId },
      });
      if (!account) throw new NotFoundError("Merchant bank account", accountId);

      await tx.merchantBankAccount.delete({ where: { id: accountId } });
      await tx.auditLog.create({
        data: {
          userId,
          merchantId,
          action: "DELETE_MERCHANT_BANK_ACCOUNT",
          entity: "MerchantBankAccount",
          entityId: accountId,
          before: {
            label: account.label,
            bankName: account.bankName,
            accountLast4: account.accountLast4,
          },
          ipAddress,
          userAgent,
        },
      });
      return { id: accountId, deleted: true };
    });
  }

  // ── Merchant portal PIN management ──────────────

  async getMerchantPortalPinStatus(merchantId: string) {
    await this.requireMerchant(merchantId);
    const user = await this.prisma.user.findUnique({
      where: { merchantId },
      select: { id: true, email: true, portalPinHash: true, isActive: true },
    });
    if (!user) throw new NotFoundError("Merchant portal account", merchantId);
    return {
      userId: user.id,
      email: user.email,
      hasPin: Boolean(user.portalPinHash),
      isActive: user.isActive,
    };
  }

  /** Issue a fresh 6-digit PIN. The plaintext is returned exactly once. */
  async resetMerchantPortalPin(
    merchantId: string,
    actorId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    await this.requireMerchant(merchantId);
    const portalPin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const portalPinHash = await hashPassword(portalPin);

    const user = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { merchantId } });
      if (!existing || existing.role !== "MERCHANT") {
        throw new NotFoundError("Merchant portal account", merchantId);
      }
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: { portalPinHash },
        select: { id: true, email: true },
      });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          merchantId,
          action: "RESET_MERCHANT_PORTAL_PIN",
          entity: "User",
          entityId: updated.id,
          after: { email: updated.email, pinReset: true },
          ipAddress,
          userAgent,
        },
      });
      return updated;
    });

    return { userId: user.id, email: user.email, portalPin };
  }

  // ── Merchant transaction pause / resume requests ─────────────────

  async listMerchantControlRequests(
    merchantId: string,
    page: number,
    pageSize: number,
  ) {
    await this.requireMerchant(merchantId);
    const where: Prisma.MerchantTransactionControlRequestWhereInput = { merchantId };
    const [data, total] = await Promise.all([
      this.prisma.merchantTransactionControlRequest.findMany({
        where,
        include: {
          transaction: {
            select: {
              id: true,
              stan: true,
              rrn: true,
              status: true,
              amount: true,
              currency: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.merchantTransactionControlRequest.count({ where }),
    ]);
    return {
      data: data.map((item) => ({
        ...item,
        transaction: { ...item.transaction, amount: item.transaction.amount.toString() },
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /**
   * A merchant asks an administrator to pause a transaction (optionally
   * reported as suspicious) or to release an existing hold. The transaction
   * status only changes once an administrator approves the request.
   */
  async requestMerchantTransactionControl(
    merchantId: string,
    requestedByUserId: string,
    transactionId: string,
    action: "HOLD" | "RESUME",
    reason: string,
    suspicious: boolean,
    ipAddress?: string,
    userAgent?: string,
  ) {
    await this.requireMerchant(merchantId);
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, merchantId },
      select: { id: true, stan: true, status: true, settledAt: true, merchantId: true },
    });
    if (!transaction) throw new NotFoundError("Transaction", transactionId);

    let previousStatus: "AUTHORIZED" | "CAPTURED" | null = null;
    if (action === "HOLD") {
      if (
        transaction.settledAt ||
        (transaction.status !== "AUTHORIZED" && transaction.status !== "CAPTURED")
      ) {
        throw new ConflictError(
          "Only unsettled authorized or captured transactions can be paused",
        );
      }
      previousStatus = transaction.status;
    } else {
      if (transaction.status !== "ON_HOLD" || transaction.settledAt) {
        throw new ConflictError("Only held, unsettled transactions can be resumed");
      }
      const priorHold = await this.prisma.merchantTransactionControlRequest.findFirst({
        where: {
          transactionId,
          action: "HOLD",
          status: "APPROVED",
          previousStatus: { in: ["AUTHORIZED", "CAPTURED"] },
        },
        orderBy: { reviewedAt: "desc" },
        select: { previousStatus: true },
      });
      if (
        priorHold?.previousStatus !== "AUTHORIZED" &&
        priorHold?.previousStatus !== "CAPTURED"
      ) {
        throw new ConflictError("The transaction has no approved pause to resume");
      }
      previousStatus = priorHold.previousStatus;
    }

    const pending = await this.prisma.merchantTransactionControlRequest.findFirst({
      where: { transactionId, action, status: { in: ["PENDING", "INFO_REQUESTED"] } },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictError("A request for this transaction is already awaiting review");
    }

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.merchantTransactionControlRequest.create({
        data: {
          transactionId,
          merchantId,
          requestedByUserId,
          action,
          suspicious,
          reason: reason.trim(),
          previousStatus,
        },
        select: {
          id: true,
          transactionId: true,
          merchantId: true,
          action: true,
          suspicious: true,
          status: true,
          reason: true,
          previousStatus: true,
          createdAt: true,
        },
      });

      const admins = await tx.user.findMany({
        where: { role: { in: ["SUPER_ADMIN", "ADMIN"] }, isActive: true },
        select: { id: true },
      });
      if (admins.length) {
        await tx.notification.createMany({
          data: admins.map(({ id }) => ({
            merchantId,
            type: "ALERT",
            channel: "IN_APP",
            title: suspicious
              ? "Suspicious transaction reported by merchant"
              : `Merchant ${action === "HOLD" ? "pause" : "resume"} request`,
            message: `Merchant requested to ${action === "HOLD" ? "pause" : "resume"} transaction ${transaction.stan}. Reason: ${reason.trim()}`,
            recipient: id,
            metadata: {
              requestId: request.id,
              transactionId,
              merchantId,
              action,
              suspicious,
            },
          })),
        });
      }

      await tx.auditLog.create({
        data: {
          userId: requestedByUserId,
          merchantId,
          action: `MERCHANT_TRANSACTION_${action}_REQUESTED`,
          entity: "Transaction",
          entityId: transactionId,
          before: { status: transaction.status },
          after: { requestId: request.id, action, reason: reason.trim(), suspicious },
          ipAddress,
          userAgent,
        },
      });

      return request;
    });
  }

  /** Administrator queue of merchant pause/resume requests. */
  async listMerchantControlRequestsForAdmin(
    status: "PENDING" | "INFO_REQUESTED" | "APPROVED" | "REJECTED" | undefined,
    page: number,
    pageSize: number,
  ) {
    const where: Prisma.MerchantTransactionControlRequestWhereInput = status
      ? { status }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.merchantTransactionControlRequest.findMany({
        where,
        include: {
          merchant: { select: { id: true, code: true, legalName: true } },
          transaction: {
            select: {
              id: true,
              stan: true,
              rrn: true,
              status: true,
              amount: true,
              currency: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.merchantTransactionControlRequest.count({ where }),
    ]);
    return {
      data: data.map((item) => ({
        ...item,
        transaction: { ...item.transaction, amount: item.transaction.amount.toString() },
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** Administrator approves or rejects a merchant pause/resume request. */
  async reviewMerchantTransactionControlRequest(
    requestId: string,
    decision: "APPROVE" | "REJECT",
    adminRemarks: string,
    reviewedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.merchantTransactionControlRequest.findUnique({
        where: { id: requestId },
        include: {
          transaction: {
            select: { id: true, status: true, settledAt: true, merchantId: true },
          },
        },
      });
      if (!request) throw new NotFoundError("Merchant transaction control request", requestId);
      if (request.status !== "PENDING") {
        throw new ConflictError(`Request is ${request.status} and cannot be reviewed`);
      }

      const nextStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";

      if (decision === "APPROVE") {
        let expectedStatus: "AUTHORIZED" | "CAPTURED" | "ON_HOLD";
        let nextTransactionStatus: "AUTHORIZED" | "CAPTURED" | "ON_HOLD";
        if (request.action === "HOLD") {
          if (
            request.previousStatus !== "AUTHORIZED" &&
            request.previousStatus !== "CAPTURED"
          ) {
            throw new ConflictError(
              "The request does not contain a valid transaction status to hold",
            );
          }
          expectedStatus = request.previousStatus;
          nextTransactionStatus = "ON_HOLD";
        } else {
          if (
            request.previousStatus !== "AUTHORIZED" &&
            request.previousStatus !== "CAPTURED"
          ) {
            throw new ConflictError(
              "The request does not contain a valid transaction status to restore",
            );
          }
          expectedStatus = "ON_HOLD";
          nextTransactionStatus = request.previousStatus;
        }
        const updated = await tx.transaction.updateMany({
          where: { id: request.transactionId, status: expectedStatus, settledAt: null },
          data: { status: nextTransactionStatus },
        });
        if (updated.count !== 1) {
          throw new ConflictError(
            "Transaction status changed or settled before the request was approved",
          );
        }
        await tx.transactionLog.create({
          data: {
            transactionId: request.transactionId,
            stage:
              request.action === "HOLD"
                ? "MERCHANT_HOLD_APPROVED"
                : "MERCHANT_RESUME_APPROVED",
            message: adminRemarks.trim(),
          },
        });
      }

      const updatedRequest = await tx.merchantTransactionControlRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: {
          status: nextStatus,
          adminRemarks: adminRemarks.trim(),
          reviewedBy,
          reviewedAt: new Date(),
        },
      });
      if (updatedRequest.count !== 1) {
        throw new ConflictError("The request was reviewed by another administrator");
      }

      await tx.auditLog.create({
        data: {
          userId: reviewedBy,
          merchantId: request.merchantId,
          action: `ADMIN_MERCHANT_TRANSACTION_${request.action}_${decision}`,
          entity: "MerchantTransactionControlRequest",
          entityId: requestId,
          before: {
            requestStatus: request.status,
            transactionStatus: request.transaction.status,
          },
          after: {
            requestStatus: nextStatus,
            transactionStatus:
              decision === "APPROVE"
                ? request.action === "HOLD"
                  ? "ON_HOLD"
                  : request.previousStatus
                : request.transaction.status,
            adminRemarks: adminRemarks.trim(),
          },
          ipAddress,
          userAgent,
        },
      });

      await tx.notification.create({
        data: {
          merchantId: request.merchantId,
          type: "ALERT",
          channel: "IN_APP",
          title: `Transaction ${request.action === "HOLD" ? "pause" : "resume"} request update`,
          message: `Your ${request.action === "HOLD" ? "pause" : "resume"} request was ${decision === "APPROVE" ? "approved" : "rejected"}.`,
          recipient: `merchant:${request.merchantId}`,
          metadata: { requestId, decision, status: nextStatus },
        },
      });

      return tx.merchantTransactionControlRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          transaction: { select: { id: true, stan: true, status: true, settledAt: true } },
        },
      });
    });
  }

  /**
   * An administrator directly pauses or resumes a transaction without waiting
   * for a merchant request. The action is recorded as an approved control
   * request so the original status can be restored on resume.
   */
  async adminSetTransactionHold(
    merchantId: string,
    transactionId: string,
    action: "HOLD" | "RESUME",
    reason: string,
    reviewedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    await this.requireMerchant(merchantId);
    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findFirst({
        where: { id: transactionId, merchantId },
        select: { id: true, stan: true, status: true, settledAt: true, merchantId: true },
      });
      if (!transaction) throw new NotFoundError("Transaction", transactionId);

      let previousStatus: "AUTHORIZED" | "CAPTURED" | null = null;
      if (action === "HOLD") {
        if (
          transaction.settledAt ||
          (transaction.status !== "AUTHORIZED" && transaction.status !== "CAPTURED")
        ) {
          throw new ConflictError(
            "Only unsettled authorized or captured transactions can be paused",
          );
        }
        previousStatus = transaction.status;
      } else {
        if (transaction.status !== "ON_HOLD" || transaction.settledAt) {
          throw new ConflictError("Only held, unsettled transactions can be resumed");
        }
        const priorHold = await tx.merchantTransactionControlRequest.findFirst({
          where: {
            transactionId,
            action: "HOLD",
            status: "APPROVED",
            previousStatus: { in: ["AUTHORIZED", "CAPTURED"] },
          },
          orderBy: { reviewedAt: "desc" },
          select: { previousStatus: true },
        });
        if (
          priorHold?.previousStatus !== "AUTHORIZED" &&
          priorHold?.previousStatus !== "CAPTURED"
        ) {
          throw new ConflictError("The transaction has no approved pause to resume");
        }
        previousStatus = priorHold.previousStatus;
      }

      const nextTransactionStatus = action === "HOLD" ? "ON_HOLD" : previousStatus;
      const updated = await tx.transaction.updateMany({
        where: { id: transactionId, status: transaction.status, settledAt: null },
        data: { status: nextTransactionStatus },
      });
      if (updated.count !== 1) {
        throw new ConflictError("Transaction status changed; refresh and try again");
      }

      const request = await tx.merchantTransactionControlRequest.create({
        data: {
          transactionId,
          merchantId,
          requestedByUserId: reviewedBy,
          action,
          suspicious: false,
          status: "APPROVED",
          reason: reason.trim(),
          previousStatus,
          adminRemarks: reason.trim(),
          reviewedBy,
          reviewedAt: new Date(),
        },
      });

      await tx.transactionLog.create({
        data: {
          transactionId,
          stage: action === "HOLD" ? "ADMIN_MERCHANT_HOLD" : "ADMIN_MERCHANT_RESUME",
          message: reason.trim(),
        },
      });

      await tx.auditLog.create({
        data: {
          userId: reviewedBy,
          merchantId,
          action: `ADMIN_DIRECT_TRANSACTION_${action}`,
          entity: "Transaction",
          entityId: transactionId,
          before: { status: transaction.status },
          after: { status: nextTransactionStatus, requestId: request.id, reason: reason.trim() },
          ipAddress,
          userAgent,
        },
      });

      await tx.notification.create({
        data: {
          merchantId,
          type: "ALERT",
          channel: "IN_APP",
          title: `Transaction ${action === "HOLD" ? "paused" : "resumed"} by administrator`,
          message: `An administrator ${action === "HOLD" ? "paused" : "resumed"} transaction ${transaction.stan}. Reason: ${reason.trim()}`,
          recipient: `merchant:${merchantId}`,
          metadata: { requestId: request.id, transactionId, action },
        },
      });

      return tx.merchantTransactionControlRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: {
          transaction: { select: { id: true, stan: true, status: true, settledAt: true } },
        },
      });
    });
  }

  async listMerchants(filters: {
    status?: string;
    country?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.MerchantWhereInput = {};
    if (filters.status) where.status = filters.status as never;
    if (filters.country) where.country = filters.country;

    const [merchants, total] = await Promise.all([
      this.prisma.merchant.findMany({
        where,
        include: {
          kycRecord: { select: { status: true } },
          _count: { select: { terminals: true, wallets: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.merchant.count({ where }),
    ]);

    return {
      data: merchants,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  async updateMerchant(id: string, input: UpdateMerchantInput) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new NotFoundError("Merchant", id);

    const updated = await this.prisma.merchant.update({
      where: { id },
      data: {
        legalName: input.legalName,
        displayName: input.displayName,
        dbaName: input.dbaName,
        phone: input.phone,
        preferredLang: input.preferredLang,
        mcc: input.mcc,
        website: input.website,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    logger.info({ merchantId: id }, "Merchant updated");
    return updated;
  }

  async suspendMerchant(id: string, reason?: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new NotFoundError("Merchant", id);

    if (merchant.status === "TERMINATED") {
      throw new ConflictError("Cannot suspend a terminated merchant");
    }

    const updated = await this.prisma.merchant.update({
      where: { id },
      data: {
        status: "SUSPENDED",
        metadata: {
          ...((merchant.metadata as object) ?? {}),
          suspensionReason: reason,
          suspendedAt: new Date().toISOString(),
        },
      },
    });

    logger.warn({ merchantId: id, reason }, "Merchant suspended");
    return updated;
  }

  async reactivateMerchant(id: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      include: { kycRecord: true },
    });
    if (!merchant) throw new NotFoundError("Merchant", id);

    if (merchant.status === "TERMINATED") {
      throw new ConflictError("Cannot reactivate a terminated merchant");
    }

    if (merchant.kycRecord?.status !== "APPROVED") {
      throw new ValidationError(
        "Merchant KYC must be approved before reactivation",
      );
    }

    const updated = await this.prisma.merchant.update({
      where: { id },
      data: { status: "ACTIVE" },
    });

    logger.info({ merchantId: id }, "Merchant reactivated");
    return updated;
  }

  async setMerchantStatus(id: string, status: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      include: { kycRecord: true },
    });
    if (!merchant) throw new NotFoundError("Merchant", id);
    if (
      ["APPROVED", "ACTIVE"].includes(status) &&
      merchant.kycRecord?.status !== "APPROVED"
    ) {
      throw new ValidationError(
        "Merchant KYC must be approved before merchant approval or activation",
      );
    }
    return this.prisma.merchant.update({
      where: { id },
      data: { status: status as never },
    });
  }

  async getMerchantStats(id: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new NotFoundError("Merchant", id);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalTransactions,
      todayTransactions,
      authorizedTransactions,
      declinedTransactions,
      totalTransfers,
      completedTransfers,
      pendingSettlements,
      walletsCount,
      terminalsCount,
      terminalsOnline,
    ] = await Promise.all([
      this.prisma.transaction.count({ where: { merchantId: id } }),
      this.prisma.transaction.count({
        where: { merchantId: id, createdAt: { gte: today } },
      }),
      this.prisma.transaction.count({
        where: { merchantId: id, status: "AUTHORIZED" },
      }),
      this.prisma.transaction.count({
        where: { merchantId: id, status: "DECLINED" },
      }),
      this.prisma.transfer.count({ where: { merchantId: id } }),
      this.prisma.transfer.count({
        where: { merchantId: id, status: "COMPLETED" },
      }),
      this.prisma.settlementBatch.count({
        where: { merchantId: id, status: { in: ["OPEN", "PROCESSING"] } },
      }),
      this.prisma.wallet.count({ where: { merchantId: id } }),
      this.prisma.terminal.count({ where: { merchantId: id } }),
      this.prisma.terminal.count({
        where: { merchantId: id, health: { status: "ONLINE" } },
      }),
    ]);

    return {
      merchantId: id,
      transactions: {
        total: totalTransactions,
        today: todayTransactions,
        authorized: authorizedTransactions,
        declined: declinedTransactions,
        authorizationRate:
          totalTransactions > 0
            ? ((authorizedTransactions / totalTransactions) * 100).toFixed(2) +
              "%"
            : "N/A",
      },
      transfers: {
        total: totalTransfers,
        completed: completedTransfers,
      },
      settlements: {
        pending: pendingSettlements,
      },
      wallets: { count: walletsCount },
      terminals: {
        total: terminalsCount,
        online: terminalsOnline,
        offline: terminalsCount - terminalsOnline,
      },
    };
  }

  async getMerchantHome(id: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        displayName: true,
        legalName: true,
        status: true,
        country: true,
      },
    });
    if (!merchant) throw new NotFoundError("Merchant", id);

    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const successfulStatuses = ["AUTHORIZED", "CAPTURED", "SETTLED"] as const;
    const transactionSelect = {
      stan: true,
      rrn: true,
      type: true,
      status: true,
      amount: true,
      currency: true,
      createdAt: true,
      terminal: { select: { tid: true } },
    } as const;

    const [
      todayVolume,
      monthVolume,
      accounts,
      terminalRecords,
      totalTerminals,
      onlineTerminals,
      recentTransactions,
      settlementStatuses,
      recentSettlements,
    ] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ["currency"],
        where: {
          merchantId: id,
          type: "AUTHORIZATION",
          createdAt: { gte: today },
          status: { in: [...successfulStatuses] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.transaction.groupBy({
        by: ["currency"],
        where: {
          merchantId: id,
          type: "AUTHORIZATION",
          createdAt: { gte: monthStart },
          status: { in: [...successfulStatuses] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.account.findMany({
        where: { code: { startsWith: `MERCHANT-${merchant.code}-` } },
        select: { currency: true, balance: true, heldBalance: true },
        orderBy: { currency: "asc" },
      }),
      this.prisma.terminal.findMany({
        where: { merchantId: id },
        select: { tid: true, health: { select: { status: true } } },
        orderBy: { tid: "asc" },
        take: 8,
      }),
      this.prisma.terminal.count({ where: { merchantId: id } }),
      this.prisma.terminal.count({
        where: { merchantId: id, health: { status: "ONLINE" } },
      }),
      this.prisma.transaction.findMany({
        where: { merchantId: id },
        select: transactionSelect,
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      this.prisma.settlementBatch.groupBy({
        by: ["status"],
        where: { merchantId: id },
        _count: { _all: true },
      }),
      this.prisma.settlementBatch.findMany({
        where: { merchantId: id },
        select: {
          batchNumber: true,
          status: true,
          period: true,
          transactionCount: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

    const serializeVolume = (groups: typeof todayVolume) =>
      groups.map((group) => ({
        currency: group.currency,
        amount: group._sum.amount?.toString() ?? "0",
        transactions: group._count._all,
      }));

    return {
      merchant,
      period: {
        today: today.toISOString(),
        monthStart: monthStart.toISOString(),
      },
      volumes: {
        today: serializeVolume(todayVolume),
        month: serializeVolume(monthVolume),
      },
      balances: accounts.map((account) => ({
        currency: account.currency,
        balance: account.balance.toString(),
        held: account.heldBalance.toString(),
        available: new Decimal(account.balance)
          .minus(account.heldBalance)
          .toString(),
      })),
      terminals: {
        total: totalTerminals,
        online: onlineTerminals,
        items: terminalRecords.map((terminal) => ({
          tid: terminal.tid,
          status: terminal.health?.status ?? "UNKNOWN",
        })),
      },
      recentTransactions: recentTransactions.map((transaction) => ({
        reference: transaction.rrn || transaction.stan,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        terminal: transaction.terminal?.tid ?? "—",
        createdAt: transaction.createdAt,
      })),
      settlements: {
        statuses: settlementStatuses.map((group) => ({
          status: group.status,
          count: group._count._all,
        })),
        recent: recentSettlements,
      },
    };
  }

  async listMerchantIds(merchantId: string) {
    await this.requireMerchant(merchantId);
    return this.prisma.merchantMid.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createMerchantId(
    merchantId: string,
    input: { mid: string; label?: string },
  ) {
    await this.requireMerchant(merchantId);
    const existing = await this.prisma.merchantMid.findUnique({
      where: { mid: input.mid },
    });
    if (existing) throw new ConflictError(`MID already exists: ${input.mid}`);
    return this.prisma.merchantMid.create({
      data: { merchantId, mid: input.mid, label: input.label },
    });
  }

  async listMerchantTerminals(merchantId: string) {
    await this.requireMerchant(merchantId);
    return this.prisma.terminal.findMany({
      where: { merchantId },
      include: { health: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async assignTerminal(merchantId: string, terminalId: string, mid: string) {
    await this.requireMerchant(merchantId);
    const merchantMid = await this.prisma.merchantMid.findFirst({
      where: { merchantId, mid, status: "ACTIVE" },
    });
    if (!merchantMid) throw new NotFoundError("Active merchant MID", mid);
    const terminal = await this.prisma.terminal.findUnique({
      where: { id: terminalId },
    });
    if (!terminal) throw new NotFoundError("Terminal", terminalId);
    return this.prisma.terminal.update({
      where: { id: terminalId },
      data: { merchantId, mid },
      include: { health: true },
    });
  }

  async addKycDocument(
    merchantId: string,
    input: {
      documentType: string;
      documentReference: string;
    },
  ) {
    await this.requireMerchant(merchantId);
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.merchantKycDocument.create({
        data: { merchantId, ...input },
      });
      const kyc = await tx.kycRecord.findUnique({ where: { merchantId } });
      if (!kyc) throw new NotFoundError("KYC record", merchantId);
      if (kyc.status !== "APPROVED") {
        await tx.kycRecord.update({
          where: { merchantId },
          data: { status: "UNDER_REVIEW", submittedAt: new Date() },
        });
        await tx.merchant.updateMany({
          where: { id: merchantId, status: "PENDING" },
          data: { status: "UNDER_REVIEW" },
        });
      }
      return document;
    });
  }

  async listKycDocuments(merchantId: string) {
    await this.requireMerchant(merchantId);
    return this.prisma.merchantKycDocument.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async reviewKycDocument(
    documentId: string,
    input: {
      verificationStatus: string;
      reviewedBy?: string;
    },
  ) {
    const document = await this.prisma.merchantKycDocument.findUnique({
      where: { id: documentId },
    });
    if (!document) throw new NotFoundError("Merchant KYC document", documentId);
    return this.prisma.merchantKycDocument.update({
      where: { id: documentId },
      data: {
        verificationStatus: input.verificationStatus,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.verificationStatus === "PENDING" ? null : new Date(),
      },
    });
  }

  async setRiskProfile(
    merchantId: string,
    input: {
      dailyLimit?: string;
      monthlyLimit?: string;
      chargebackLimit?: string;
      riskScore: number;
    },
  ) {
    await this.requireMerchant(merchantId);
    if (
      !Number.isInteger(input.riskScore) ||
      input.riskScore < 0 ||
      input.riskScore > 100
    ) {
      throw new ValidationError(
        "riskScore must be an integer between 0 and 100",
      );
    }
    for (const [key, value] of Object.entries(input)) {
      if (key === "riskScore" || typeof value !== "string") continue;
      money(value, key);
    }
    const riskLevel =
      input.riskScore >= 75
        ? "HIGH"
        : input.riskScore >= 40
          ? "MEDIUM"
          : "STANDARD";
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.merchantRiskProfile.upsert({
        where: { merchantId },
        create: { merchantId, ...input },
        update: input,
      });
      await tx.merchant.update({
        where: { id: merchantId },
        data: { riskLevel },
      });
      return profile;
    });
  }

  async createPricingPlan(input: {
    planName: string;
    transactionFee: string;
    settlementFee: string;
    payoutFee: string;
    currency: string;
  }) {
    for (const key of [
      "transactionFee",
      "settlementFee",
      "payoutFee",
    ] as const) {
      const fee = money(input[key], key, true, 4, 6);
      if (fee.gt(100))
        throw new ValidationError(`${key} cannot exceed 100 percent`);
    }
    return this.prisma.pricingPlan.create({ data: input });
  }

  async assignPricingPlan(merchantId: string, pricingPlanId: string | null) {
    await this.requireMerchant(merchantId);
    if (pricingPlanId) {
      const plan = await this.prisma.pricingPlan.findUnique({
        where: { id: pricingPlanId },
      });
      if (!plan || !plan.active)
        throw new NotFoundError("Active pricing plan", pricingPlanId);
    }
    return this.prisma.merchant.update({
      where: { id: merchantId },
      data: { pricingPlanId },
      include: { pricingPlan: true },
    });
  }

  async listPricingPlans() {
    return this.prisma.pricingPlan.findMany({
      where: { active: true },
      orderBy: { planName: "asc" },
    });
  }

  async mapMerchantWallet(
    merchantId: string,
    input: {
      walletId: string;
      settlementAccountId?: string;
    },
  ) {
    await this.requireMerchant(merchantId);
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: input.walletId },
    });
    if (
      !wallet ||
      wallet.merchantId !== merchantId ||
      wallet.type !== "MERCHANT"
    ) {
      throw new ValidationError(
        "Wallet must be a MERCHANT wallet owned by this merchant",
      );
    }
    if (input.settlementAccountId) {
      const account = await this.prisma.account.findUnique({
        where: { id: input.settlementAccountId },
      });
      if (!account)
        throw new NotFoundError(
          "Settlement account",
          input.settlementAccountId,
        );
      if (account.currency !== wallet.currency) {
        throw new ValidationError(
          "Settlement account currency must match the merchant wallet",
        );
      }
    }
    return this.prisma.merchantAccount.upsert({
      where: { merchantId_walletId: { merchantId, walletId: input.walletId } },
      create: { merchantId, ...input },
      update: { settlementAccountId: input.settlementAccountId },
      include: { wallet: true, settlementAccount: true },
    });
  }

  async createInvoice(
    merchantId: string,
    input: {
      amount: string;
      currency: string;
      description?: string;
      dueAt?: Date;
    },
  ) {
    await this.requireActiveMerchant(merchantId);
    const amount = money(input.amount, "Invoice amount", false);
    if (
      input.dueAt &&
      (!Number.isFinite(input.dueAt.getTime()) || input.dueAt <= new Date())
    ) {
      throw new ValidationError("Invoice due date must be a future date");
    }
    return this.prisma.invoice.create({
      data: {
        invoiceNumber: `INV-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
        merchantId,
        amount: amount.toString(),
        currency: input.currency,
        description: input.description,
        dueAt: input.dueAt,
      },
    });
  }

  async listInvoices(merchantId: string, page: number, pageSize: number) {
    await this.requireMerchant(merchantId);
    const where = { merchantId };
    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return {
      data,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async createPaymentLink(
    merchantId: string,
    input: {
      amount: string;
      currency: string;
      description?: string;
      expiresAt?: Date;
    },
  ) {
    await this.requireActiveMerchant(merchantId);
    const amount = money(input.amount, "Payment link amount", false);
    if (
      input.expiresAt &&
      (!Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt <= new Date())
    ) {
      throw new ValidationError("Payment link expiry must be a future date");
    }
    return this.prisma.paymentLink.create({
      data: {
        merchantId,
        reference: `PL-${randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase()}`,
        amount: amount.toString(),
        currency: input.currency,
        description: input.description,
        expiresAt: input.expiresAt,
      },
    });
  }

  async listPaymentLinks(merchantId: string, page: number, pageSize: number) {
    await this.requireMerchant(merchantId);
    const where = { merchantId };
    const [data, total] = await Promise.all([
      this.prisma.paymentLink.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.paymentLink.count({ where }),
    ]);
    return {
      data,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async listMerchantTransactions(
    merchantId: string,
    page: number,
    pageSize: number,
  ) {
    await this.requireMerchant(merchantId);
    const where = { merchantId };
    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        select: {
          id: true,
          stan: true,
          rrn: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          responseCode: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return {
      data,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async listMerchantSettlements(
    merchantId: string,
    page: number,
    pageSize: number,
  ) {
    await this.requireMerchant(merchantId);
    const where = { merchantId };
    const [data, total] = await Promise.all([
      this.prisma.settlementBatch.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.settlementBatch.count({ where }),
    ]);
    return {
      data,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async getMerchantBalance(merchantId: string, currency: string) {
    const merchant = await this.requireMerchant(merchantId);
    const account = await this.prisma.account.findUnique({
      where: { code: `MERCHANT-${merchant.code}-${currency}` },
    });
    if (!account)
      throw new NotFoundError(
        "Merchant settlement account",
        `${merchant.code}-${currency}`,
      );
    return {
      merchantId,
      currency,
      balance: account.balance.toString(),
      heldBalance: account.heldBalance.toString(),
      availableBalance: new Decimal(account.balance)
        .minus(account.heldBalance)
        .toString(),
    };
  }

  async listMerchantStatement(
    merchantId: string,
    currency: string,
    page: number,
    pageSize: number,
  ) {
    const merchant = await this.requireMerchant(merchantId);
    const account = await this.prisma.account.findUnique({
      where: { code: `MERCHANT-${merchant.code}-${currency}` },
    });
    if (!account)
      throw new NotFoundError(
        "Merchant settlement account",
        `${merchant.code}-${currency}`,
      );
    const where = { accountId: account.id };
    const [lines, total] = await Promise.all([
      this.prisma.journalLine.findMany({
        where,
        include: { entry: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.journalLine.count({ where }),
    ]);
    return {
      data: lines.map((line) => ({
        reference: line.entry.reference,
        entryType: line.entry.entryType,
        description: line.entry.description,
        debit: line.debit.toString(),
        credit: line.credit.toString(),
        currency: line.currency,
        createdAt: line.createdAt,
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async createAgent(input: {
    code: string;
    name: string;
    commissionRate: string;
    parentAgentId?: string;
  }) {
    const rate = money(input.commissionRate, "Commission rate", true, 4, 6);
    if (rate.gt(100))
      throw new ValidationError("Commission rate cannot exceed 100");
    if (input.parentAgentId) {
      const parent = await this.prisma.agent.findUnique({
        where: { id: input.parentAgentId },
      });
      if (!parent) throw new NotFoundError("Parent agent", input.parentAgentId);
    }
    return this.prisma.agent.create({
      data: { ...input, commissionRate: rate.toString() },
    });
  }

  async listAgents() {
    return this.prisma.agent.findMany({
      include: {
        parentAgent: { select: { id: true, code: true, name: true } },
        _count: { select: { childAgents: true, merchants: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async assignAgent(merchantId: string, agentId: string | null) {
    await this.requireMerchant(merchantId);
    if (agentId) {
      const agent = await this.prisma.agent.findUnique({
        where: { id: agentId },
      });
      if (!agent) throw new NotFoundError("Agent", agentId);
    }
    return this.prisma.merchant.update({
      where: { id: merchantId },
      data: { agentId },
    });
  }

  async getMerchantDashboard() {
    const [total, pending, active, blocked, transactionsToday, recent] =
      await Promise.all([
        this.prisma.merchant.count(),
        this.prisma.merchant.count({
          where: { status: { in: ["PENDING", "UNDER_REVIEW"] } },
        }),
        this.prisma.merchant.count({
          where: { status: { in: ["ACTIVE", "APPROVED"] } },
        }),
        this.prisma.merchant.count({
          where: { status: { in: ["BLOCKED", "SUSPENDED", "TERMINATED"] } },
        }),
        this.prisma.transaction.count({
          where: {
            createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
        }),
        this.prisma.merchant.findMany({
          include: {
            kycRecord: { select: { status: true } },
            _count: { select: { terminals: true, transactions: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      ]);
    return {
      summary: { total, pending, active, blocked, transactionsToday },
      merchants: recent,
    };
  }

  private async requireMerchant(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
    });
    if (!merchant) throw new NotFoundError("Merchant", merchantId);
    return merchant;
  }

  private async requireActiveMerchant(merchantId: string) {
    const merchant = await this.requireMerchant(merchantId);
    if (!["ACTIVE", "APPROVED"].includes(merchant.status)) {
      throw new ValidationError(
        `Merchant is not approved for payment operations (${merchant.status})`,
      );
    }
    return merchant;
  }
}

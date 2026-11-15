import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { MerchantService } from "./merchant.service.js";
import { verifyPassword } from "../../shared/utils/crypto.js";

describe("MerchantService.createPortalCredentials", () => {
  it("issues a 6-digit access PIN alongside the temporary password", async () => {
    const merchant = {
      id: "merchant-1",
      legalName: "Demo Merchant",
      email: "merchant@demo.com",
    };
    const created = { id: "user-1", email: merchant.email, role: "MERCHANT" };

    const create = vi.fn(
      async (args: {
        data: { passwordHash: string; portalPinHash: string | null };
      }) => {
        void args;
        return created;
      },
    );

    const tx = {
      merchant: { findUnique: vi.fn().mockResolvedValue(merchant) },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create,
        update: vi.fn(),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    const prisma = {
      $transaction: (fn: (client: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;

    const result = await new MerchantService(prisma).createPortalCredentials(
      "merchant-1",
      "admin-1",
    );

    expect(result.portalPin).toMatch(/^\d{6}$/);
    expect(result.temporaryPassword).toBeTruthy();

    const stored = create.mock.calls[0][0].data;
    expect(stored.portalPinHash).toBeTruthy();
    expect(await verifyPassword(result.portalPin, stored.portalPinHash as string)).toBe(true);
    expect(await verifyPassword(result.portalPin, stored.passwordHash)).toBe(false);
  });
});

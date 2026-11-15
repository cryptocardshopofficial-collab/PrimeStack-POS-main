import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { AdminService } from "./admin.service.js";
import { hashPassword } from "../../shared/utils/crypto.js";

const MERCHANT_PASSWORD = "MerchantPass#2026";
const MERCHANT_PIN = "482913";

function buildService(user: Record<string, unknown>) {
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue(user),
    },
  } as unknown as PrismaClient;
  return new AdminService(prisma);
}

function merchantUser(portalPinHash: string | null) {
  return {
    id: "merchant-user-1",
    email: "merchant@example.com",
    username: "merchant@example.com",
    fullName: "Demo Merchant",
    role: "MERCHANT",
    merchantId: "merchant-1",
    isActive: true,
    mustChangePassword: true,
    preferredLang: "en",
    passwordHash: "",
    portalPinHash,
  };
}

describe("AdminService.login — merchant access PIN", () => {
  it("signs a staff account in with email and password only", async () => {
    const service = buildService({
      id: "staff-1",
      email: "ops@example.com",
      username: "ops",
      fullName: "Operations",
      role: "OPERATOR",
      merchantId: null,
      isActive: true,
      mustChangePassword: false,
      preferredLang: "en",
      passwordHash: await hashPassword("StaffPass#2026"),
      portalPinHash: null,
    });

    const result = await service.login("ops@example.com", "StaffPass#2026");
    expect(result.user.role).toBe("OPERATOR");
  });

  it("rejects a merchant sign-in that omits the PIN", async () => {
    const user = merchantUser(await hashPassword(MERCHANT_PIN));
    user.passwordHash = await hashPassword(MERCHANT_PASSWORD);
    const service = buildService(user);

    await expect(
      service.login("merchant@example.com", MERCHANT_PASSWORD),
    ).rejects.toThrow();
  });

  it("rejects a merchant sign-in with the wrong PIN", async () => {
    const user = merchantUser(await hashPassword(MERCHANT_PIN));
    user.passwordHash = await hashPassword(MERCHANT_PASSWORD);
    const service = buildService(user);

    await expect(
      service.login("merchant@example.com", MERCHANT_PASSWORD, undefined, "000000"),
    ).rejects.toThrow();
  });

  it("rejects a merchant whose PIN was never issued", async () => {
    const user = merchantUser(null);
    user.passwordHash = await hashPassword(MERCHANT_PASSWORD);
    const service = buildService(user);

    await expect(
      service.login("merchant@example.com", MERCHANT_PASSWORD, undefined, MERCHANT_PIN),
    ).rejects.toThrow();
  });

  it("signs a merchant in with the correct PIN", async () => {
    const user = merchantUser(await hashPassword(MERCHANT_PIN));
    user.passwordHash = await hashPassword(MERCHANT_PASSWORD);
    const service = buildService(user);

    const result = await service.login(
      "merchant@example.com",
      MERCHANT_PASSWORD,
      undefined,
      MERCHANT_PIN,
    );
    expect(result.user.role).toBe("MERCHANT");
  });
});

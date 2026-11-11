import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.js";
import { encryptSecret } from "../s2s-engine/s2s-crypto.js";
import type {
  CreateApplicationInput,
  UpdateApplicationInput,
} from "./developer-platform.types.js";

const applicationInclude = {
  ratePlan: true,
  products: { include: { product: true } },
  keys: {
    select: {
      id: true,
      keyId: true,
      secretLast4: true,
      active: true,
      lastUsedAt: true,
      createdAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" as const },
  },
};

export class DeveloperPlatformService {
  constructor(private readonly prisma: PrismaClient) {}

  async getDashboard() {
    const [
      applicationCount,
      activeApplications,
      productCount,
      ratePlanCount,
      webhookCount,
      sdkCount,
      partnerCount,
      pendingCertifications,
      applications,
      products,
      ratePlans,
      webhooks,
      sdkVersions,
      partners,
      certifications,
    ] = await Promise.all([
      this.prisma.developerApplication.count(),
      this.prisma.developerApplication.count({ where: { status: "ACTIVE" } }),
      this.prisma.developerApiProduct.count(),
      this.prisma.developerApiRatePlan.count(),
      this.prisma.developerWebhook.count({ where: { active: true } }),
      this.prisma.developerSdkVersion.count(),
      this.prisma.developerPartner.count({ where: { active: true } }),
      this.prisma.developerCertification.count({
        where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
      }),
      this.listApplications(),
      this.listProducts(),
      this.listRatePlans(),
      this.listWebhooks(),
      this.listSdkVersions(),
      this.listPartners(),
      this.listCertifications(),
    ]);
    return {
      summary: {
        applications: applicationCount,
        activeApplications,
        products: productCount,
        ratePlans: ratePlanCount,
        activeWebhooks: webhookCount,
        sdkVersions: sdkCount,
        activePartners: partnerCount,
        pendingCertifications,
      },
      applications,
      products,
      ratePlans,
      webhooks,
      sdkVersions,
      partners,
      certifications,
    };
  }

  async listApplications() {
    return this.prisma.developerApplication.findMany({
      include: applicationInclude,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async createApplication(input: CreateApplicationInput) {
    await this.validateAssignments(input.ratePlanId, input.productIds);
    return this.prisma.developerApplication.create({
      data: {
        appName: input.appName,
        ownerId: input.ownerId,
        appType: input.appType,
        ratePlanId: input.ratePlanId,
        products: {
          create: input.productIds.map((productId) => ({
            product: { connect: { id: productId } },
          })),
        },
      },
      include: applicationInclude,
    });
  }

  async updateApplication(id: string, input: UpdateApplicationInput) {
    const existing = await this.prisma.developerApplication.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError("Developer application", id);
    await this.validateAssignments(input.ratePlanId, input.productIds);
    return this.prisma.$transaction(async (tx) => {
      const data: Prisma.DeveloperApplicationUpdateInput = {
        status: input.status,
      };
      if (input.ratePlanId !== undefined) {
        data.ratePlan = input.ratePlanId
          ? { connect: { id: input.ratePlanId } }
          : { disconnect: true };
      }
      const updated = await tx.developerApplication.update({
        where: { id },
        data,
      });
      if (input.status !== "ACTIVE") {
        await tx.developerApplicationKey.updateMany({
          where: { applicationId: id, active: true },
          data: { active: false, revokedAt: new Date() },
        });
      }
      if (input.productIds !== undefined) {
        await tx.developerApplicationProduct.deleteMany({
          where: { applicationId: id },
        });
        if (input.productIds.length > 0) {
          await tx.developerApplicationProduct.createMany({
            data: input.productIds.map((productId) => ({
              applicationId: id,
              productId,
            })),
          });
        }
      }
      return tx.developerApplication.findUniqueOrThrow({
        where: { id: updated.id },
        include: applicationInclude,
      });
    });
  }

  async createApplicationKey(applicationId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await tx.developerApplication.findUnique({
          where: { id: applicationId },
          select: { id: true, status: true },
        });
        if (!application)
          throw new NotFoundError("Developer application", applicationId);
        if (application.status !== "ACTIVE") {
          throw new ValidationError(
            "Activate the application before creating API credentials",
          );
        }
        const activeKey = await tx.developerApplicationKey.findFirst({
          where: { applicationId, active: true },
          select: { id: true },
        });
        if (activeKey)
          throw new ConflictError(
            "An active application key already exists; rotate it instead",
          );
        return this.createKeyRecord(tx, applicationId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async rotateApplicationKey(applicationId: string, keyId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await tx.developerApplication.findUnique({
          where: { id: applicationId },
          select: { id: true, status: true },
        });
        if (!application)
          throw new NotFoundError("Developer application", applicationId);
        if (application.status !== "ACTIVE") {
          throw new ValidationError(
            "Activate the application before rotating API credentials",
          );
        }
        const previous = await tx.developerApplicationKey.findFirst({
          where: { applicationId, keyId, active: true },
          select: { id: true },
        });
        if (!previous) throw new NotFoundError("Active application key", keyId);
        await tx.developerApplicationKey.update({
          where: { id: previous.id },
          data: { active: false, revokedAt: new Date() },
        });
        return this.createKeyRecord(tx, applicationId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async revokeApplicationKey(applicationId: string, keyId: string) {
    const key = await this.prisma.developerApplicationKey.findFirst({
      where: { applicationId, keyId, active: true },
      select: { id: true },
    });
    if (!key) throw new NotFoundError("Active application key", keyId);
    await this.prisma.developerApplicationKey.update({
      where: { id: key.id },
      data: { active: false, revokedAt: new Date() },
    });
    return { keyId, revoked: true };
  }

  async listProducts() {
    return this.prisma.developerApiProduct.findMany({
      orderBy: { productName: "asc" },
      take: 200,
    });
  }

  async createProduct(input: {
    productName: string;
    description?: string;
    active: boolean;
  }) {
    if (
      await this.prisma.developerApiProduct.findUnique({
        where: { productName: input.productName },
      })
    ) {
      throw new ConflictError("API product name already exists");
    }
    return this.prisma.developerApiProduct.create({ data: input });
  }

  async updateProduct(id: string, active: boolean) {
    if (
      !(await this.prisma.developerApiProduct.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("API product", id);
    }
    return this.prisma.developerApiProduct.update({
      where: { id },
      data: { active },
    });
  }

  async listRatePlans() {
    return this.prisma.developerApiRatePlan.findMany({
      orderBy: { planName: "asc" },
      take: 200,
    });
  }

  async createRatePlan(input: {
    planName: string;
    requestsPerMinute?: number | null;
    dailyLimit?: number | null;
  }) {
    if (
      await this.prisma.developerApiRatePlan.findUnique({
        where: { planName: input.planName },
      })
    ) {
      throw new ConflictError("Rate plan name already exists");
    }
    return this.prisma.developerApiRatePlan.create({ data: input });
  }

  async listWebhooks() {
    return this.prisma.developerWebhook.findMany({
      include: { application: { select: { appName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async createWebhook(
    applicationId: string,
    input: { eventName: string; callbackUrl: string },
  ) {
    if (
      !(await this.prisma.developerApplication.findUnique({
        where: { id: applicationId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("Developer application", applicationId);
    }
    return this.prisma.developerWebhook.create({
      data: { applicationId, ...input },
    });
  }

  async updateWebhook(id: string, active: boolean) {
    if (
      !(await this.prisma.developerWebhook.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("Webhook registration", id);
    }
    return this.prisma.developerWebhook.update({
      where: { id },
      data: { active },
    });
  }

  async listSdkVersions() {
    return this.prisma.developerSdkVersion.findMany({
      orderBy: [{ sdkName: "asc" }, { version: "desc" }],
      take: 200,
    });
  }

  async createSdkVersion(input: {
    sdkName: string;
    language: string;
    version: string;
  }) {
    const existing = await this.prisma.developerSdkVersion.findFirst({
      where: input,
      select: { id: true },
    });
    if (existing) throw new ConflictError("SDK version already exists");
    return this.prisma.developerSdkVersion.create({ data: input });
  }

  async listPartners() {
    return this.prisma.developerPartner.findMany({
      orderBy: { partnerName: "asc" },
      take: 200,
    });
  }

  async createPartner(input: {
    partnerName: string;
    partnerType: string;
    active: boolean;
  }) {
    const existing = await this.prisma.developerPartner.findFirst({
      where: { partnerName: input.partnerName, partnerType: input.partnerType },
      select: { id: true },
    });
    if (existing)
      throw new ConflictError("Partner already exists with this type");
    return this.prisma.developerPartner.create({ data: input });
  }

  async updatePartner(id: string, active: boolean) {
    if (
      !(await this.prisma.developerPartner.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("Partner", id);
    }
    return this.prisma.developerPartner.update({
      where: { id },
      data: { active },
    });
  }

  async listCertifications() {
    return this.prisma.developerCertification.findMany({
      include: { application: { select: { appName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async createCertification(input: {
    applicationId: string;
    certificationType: string;
  }) {
    if (
      !(await this.prisma.developerApplication.findUnique({
        where: { id: input.applicationId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("Developer application", input.applicationId);
    }
    return this.prisma.developerCertification.create({ data: input });
  }

  async updateCertification(id: string, status: string) {
    if (
      !(await this.prisma.developerCertification.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("Certification", id);
    }
    return this.prisma.developerCertification.update({
      where: { id },
      data: { status },
    });
  }

  async createTerminalRegistration(input: {
    agentCode: string;
    customerName: string;
    country: string;
    senderPublicIp: string;
    senderTerminalId: string;
    senderServerUrl: string;
    operatingCurrency: string;
    businessPurpose: string;
    customerMessage: string;
  }) {
    const agent = await this.prisma.agent.findFirst({
      where: { code: input.agentCode, status: "APPROVED" },
      select: { code: true, name: true },
    });
    if (!agent) {
      throw new ValidationError(
        "Agent registration number is invalid or has not been approved",
      );
    }
    return this.prisma.terminalRegistrationRequest.create({
      data: {
        agentCode: agent.code,
        agentName: agent.name,
        customerName: input.customerName,
        country: input.country,
        senderPublicIp: input.senderPublicIp,
        senderTerminalId: input.senderTerminalId,
        senderServerUrl: input.senderServerUrl,
        operatingCurrency: input.operatingCurrency,
        businessPurpose: input.businessPurpose,
        customerMessage: input.customerMessage,
      },
    });
  }

  async listTerminalRegistrationRequests() {
    return this.prisma.terminalRegistrationRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  async updateTerminalRegistrationRequest(id: string, status: string) {
    const existing = await this.prisma.terminalRegistrationRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundError("Terminal registration request", id);
    return this.prisma.terminalRegistrationRequest.update({
      where: { id },
      data: { status },
    });
  }

  async listAgents() {
    return this.prisma.agent.findMany({
      include: {
        hmacKeys: {
          select: {
            keyId: true,
            algorithm: true,
            status: true,
            rotatedFrom: true,
            expiresAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  async listAgentKeys(agentId: string) {
    if (!(await this.prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } }))) {
      throw new NotFoundError("Agent registration", agentId);
    }
    return this.prisma.hmacKey.findMany({
      where: { agentId },
      select: {
        keyId: true,
        algorithm: true,
        status: true,
        rotatedFrom: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async createAgentKey(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, code: true, status: true },
    });
    if (!agent) throw new NotFoundError("Agent registration", agentId);
    if (agent.status !== "APPROVED") {
      throw new ValidationError("HMAC keys can only be issued to approved agents");
    }

    const activeKey = await this.prisma.hmacKey.findFirst({
      where: { agentId, status: "ACTIVE" },
      select: { keyId: true },
    });
    if (activeKey) throw new ConflictError("Agent already has an active HMAC key; rotate it instead");

    return this.issueAgentKey(agentId);
  }

  async rotateAgentKey(agentId: string, keyId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, status: true },
    });
    if (!agent) throw new NotFoundError("Agent registration", agentId);
    if (agent.status !== "APPROVED") {
      throw new ValidationError("HMAC keys can only be issued to approved agents");
    }

    const secret = randomBytes(32).toString("hex");
    const newKeyId = `psk_agent_${randomBytes(16).toString("hex")}`;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.hmacKey.findFirst({
        where: { keyId, agentId, status: "ACTIVE" },
        select: { keyId: true, algorithm: true },
      });
      if (!current) throw new NotFoundError("Active agent HMAC key", keyId);

      const updated = await tx.hmacKey.updateMany({
        where: { keyId, agentId, status: "ACTIVE" },
        data: { status: "ROTATED" },
      });
      if (updated.count !== 1) throw new ConflictError("Agent HMAC key was changed concurrently");

      const key = await tx.hmacKey.create({
        data: {
          keyId: newKeyId,
          secret: encryptSecret(secret),
          agentId,
          algorithm: current.algorithm,
          status: "ACTIVE",
          rotatedFrom: keyId,
        },
        select: { keyId: true, algorithm: true, status: true, createdAt: true },
      });
      return {
        keyId: key.keyId,
        algorithm: key.algorithm,
        status: key.status,
        createdAt: key.createdAt,
        secret,
      };
    });
  }

  async revokeAgentKey(agentId: string, keyId: string) {
    const result = await this.prisma.hmacKey.updateMany({
      where: { keyId, agentId, status: "ACTIVE" },
      data: { status: "REVOKED" },
    });
    if (result.count !== 1) throw new NotFoundError("Active agent HMAC key", keyId);
    return { keyId, revoked: true };
  }

  private async issueAgentKey(agentId: string) {
    const secret = randomBytes(32).toString("hex");
    const keyId = `psk_agent_${randomBytes(16).toString("hex")}`;
    try {
      const key = await this.prisma.hmacKey.create({
        data: {
          keyId,
          secret: encryptSecret(secret),
          agentId,
          algorithm: "sha256",
          status: "ACTIVE",
        },
        select: { keyId: true, algorithm: true, status: true, createdAt: true },
      });
      return {
        keyId: key.keyId,
        algorithm: key.algorithm,
        status: key.status,
        createdAt: key.createdAt,
        secret,
      };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      ) {
        throw new ConflictError("Agent already has an active HMAC key; refresh and try again");
      }
      throw error;
    }
  }

  async getAgentProfile(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, code: true, name: true, status: true, country: true },
    });
    if (!agent || agent.status !== "APPROVED") {
      throw new NotFoundError("Approved agent", agentId);
    }
    return agent;
  }

  async listAgentTerminalRegistrationRequests(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { code: true, status: true },
    });
    if (!agent || agent.status !== "APPROVED") {
      throw new NotFoundError("Approved agent", agentId);
    }
    return this.prisma.terminalRegistrationRequest.findMany({
      where: { agentCode: agent.code },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  async createAgentTerminalRegistration(
    agentId: string,
    input: {
      customerName: string;
      country: string;
      senderPublicIp: string;
      senderTerminalId: string;
      senderServerUrl: string;
      operatingCurrency: string;
      businessPurpose: string;
      customerMessage: string;
    },
  ) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { code: true, name: true, status: true },
    });
    if (!agent || agent.status !== "APPROVED") {
      throw new NotFoundError("Approved agent", agentId);
    }
    return this.prisma.terminalRegistrationRequest.create({
      data: {
        agentCode: agent.code,
        agentName: agent.name,
        ...input,
      },
    });
  }

  async createAgentRegistration(input: {
    code: string;
    name: string;
    email: string;
    phone: string;
    country: string;
    address: string;
    documentNumber: string;
    commissionRate?: number;
  }) {
    const existing = await this.prisma.agent.findUnique({
      where: { code: input.code },
      select: { id: true },
    });
    if (existing) throw new ConflictError("Agent registration number already exists");
    return this.prisma.agent.create({
      data: {
        code: input.code,
        name: input.name,
        email: input.email,
        phone: input.phone,
        country: input.country,
        address: input.address,
        documentNumber: input.documentNumber,
        commissionRate: input.commissionRate ?? 0,
        status: "PENDING",
      },
    });
  }

  async updateAgentRegistration(id: string, status: string) {
    const existing = await this.prisma.agent.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError("Agent registration", id);
    return this.prisma.agent.update({
      where: { id },
      data: { status },
    });
  }

  private async validateAssignments(
    ratePlanId?: string | null,
    productIds?: string[],
  ) {
    if (
      ratePlanId &&
      !(await this.prisma.developerApiRatePlan.findUnique({
        where: { id: ratePlanId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundError("API rate plan", ratePlanId);
    }
    if (productIds === undefined || productIds.length === 0) return;
    const uniqueIds = new Set(productIds);
    if (uniqueIds.size !== productIds.length)
      throw new ValidationError("An API product may only be assigned once");
    const count = await this.prisma.developerApiProduct.count({
      where: { id: { in: productIds }, active: true },
    });
    if (count !== productIds.length) {
      throw new ValidationError(
        "All assigned API products must exist and be active",
      );
    }
  }

  private async createKeyRecord(
    tx: Prisma.TransactionClient,
    applicationId: string,
  ) {
    const keyId = `dpk_${randomBytes(16).toString("hex")}`;
    const secret = `dps_${randomBytes(32).toString("hex")}`;
    const secretHash = createHash("sha256").update(secret).digest("hex");
    const secretLast4 = secret.slice(-4);
    const key = await tx.developerApplicationKey.create({
      data: { applicationId, keyId, secretHash, secretLast4 },
      select: { id: true, keyId: true, secretLast4: true, createdAt: true },
    });
    return { ...key, secret };
  }
}

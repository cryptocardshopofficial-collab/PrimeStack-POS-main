import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError, ValidationError } from "../../core/errors.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";
import { developerPlatformDashboardHtml } from "./developer-platform-dashboard.js";
import { DeveloperPlatformService } from "./developer-platform.service.js";
import {
  createApplicationSchema,
  createCertificationSchema,
  createPartnerSchema,
  createProductSchema,
  createRatePlanSchema,
  createSdkVersionSchema,
  createWebhookSchema,
  updateActiveSchema,
  updateApplicationSchema,
  updateCertificationSchema,
  createTerminalRegistrationSchema,
  createAgentRegistrationSchema,
  updateAgentRegistrationSchema,
} from "./developer-platform.types.js";

const readRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "REVIEWER", "READONLY"];
const writeRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR"];
const credentialRoles = ["SUPER_ADMIN", "ADMIN"];

export function registerDeveloperPlatformRoutes(
  app: FastifyInstance,
  service: DeveloperPlatformService,
): void {
  app.get("/admin/agent-registration-dashboard", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Registration</title><style>body{margin:0;background:#eef3f8;font-family:system-ui;color:#172338}header{padding:18px 24px;background:#fff;border-bottom:1px solid #dfe1e2}.login,.app{max-width:1100px;margin:24px auto;padding:24px}.login{max-width:420px;background:#fff;border:1px solid #dfe1e2;border-radius:10px}.app{display:none}input,select,button{font:inherit;padding:10px;border:1px solid #ccd5e2;border-radius:7px}form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.full{grid-column:1/-1}.card{background:#fff;border:1px solid #dfe1e2;border-radius:10px;padding:16px;margin-bottom:16px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:13px}button{cursor:pointer;background:#2563eb;color:#fff;border-color:#2563eb}.badge{padding:4px 8px;border-radius:5px;background:#edf2f7;font-weight:700;font-size:12px}@media(max-width:700px){form{grid-template-columns:1fr}.full{grid-column:auto}}</style></head><body><header><strong>PrimeStack</strong> Agent Registration</header><section class="login" id="login"><h2>Administrator sign-in</h2><form id="login-form" style="grid-template-columns:1fr"><input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Password" required><button>Sign in</button></form><p id="login-error"></p></section><main class="app" id="app"><section class="card"><h2>Register Agent — KYC Review</h2><form id="agent-form"><input class="full" name="code" placeholder="Agent Registration Number *" required><input name="name" placeholder="Full Name / Business Name *" required><input name="email" type="email" placeholder="Email Address *" required><input name="phone" placeholder="Phone / WhatsApp *" required><input name="country" placeholder="Country *" required><input class="full" name="address" placeholder="Business Address *" required><input class="full" name="documentNumber" placeholder="Registration / Identity Document Number *" required><button class="full">Create Pending Agent</button></form></section><section class="card"><h2>Agent Registrations</h2><div class="table-wrap"><table><thead><tr><th>Agent Number</th><th>Name</th><th>Email</th><th>Phone</th><th>Country</th><th>Document</th><th>Status</th><th>Action</th></tr></thead><tbody id="agents"></tbody></table></div></section></main><script>const tokenKey="developerPlatformToken";async function api(path,opt={}){const r=await fetch("/admin/developer-platform"+path,{...opt,headers:{Accept:"application/json","Content-Type":"application/json",Authorization:"Bearer "+sessionStorage.getItem(tokenKey),...(opt.headers||{})}}),p=await r.json();if(!r.ok||p.success===false)throw Error(p.error?.message||"Request failed");return p.data}async function refresh(){const rows=await api("/agents");const body=document.getElementById("agents");body.replaceChildren();for(const a of rows){const tr=document.createElement("tr");["code","name","email","phone","country","documentNumber"].forEach(k=>{const td=document.createElement("td");td.textContent=a[k]||"—";tr.appendChild(td)});let td=document.createElement("td");td.innerHTML='<span class="badge">'+a.status+"</span>";tr.appendChild(td);td=document.createElement("td");if(a.status!=="APPROVED"){let b=document.createElement("button");b.textContent="Approve";b.onclick=()=>update(a.id,"APPROVED");td.appendChild(b)}if(a.status!=="REJECTED"){let b=document.createElement("button");b.textContent="Reject";b.onclick=()=>update(a.id,"REJECTED");td.appendChild(b)}tr.appendChild(td);body.appendChild(tr)}}async function update(id,status){await api("/agents/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({status})});await refresh()}    document.getElementById("login-form").onsubmit=async e=>{e.preventDefault();try{const r=await fetch("/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))}),p=await r.json();if(!r.ok||!p.success)throw Error(p.error?.message||"Sign-in failed");sessionStorage.setItem(tokenKey,p.data.token);document.getElementById("login").style.display="none";document.getElementById("app").style.display="block";await refresh()}catch(err){document.getElementById("login-error").textContent=err.message}};document.getElementById("agent-form").onsubmit=async e=>{e.preventDefault();try{const d=Object.fromEntries(new FormData(e.currentTarget));await api("/agents",{method:"POST",body:JSON.stringify(d)});e.currentTarget.reset();await refresh()}catch(err){alert(err.message)}};</script></body></html>`),
  );
  app.post("/public/terminal-registration", async (request, reply) => {
    const parsed = createTerminalRegistrationSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid terminal registration request", {
        errors: parsed.error.errors,
      });
    return sendCreated(reply, await service.createTerminalRegistration(parsed.data));
  });

  app.get(
    "/admin/developer-platform-dashboard",
    async (_request: FastifyRequest, reply: FastifyReply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(developerPlatformDashboardHtml),
  );

  app.register(
    async (platformApp) => {
      platformApp.addHook("preHandler", async (request, reply) => {
        await platformApp.authenticate(request, reply);
        const role = (request.user as { role?: string } | undefined)?.role;
        const credentialRoute = request.url.includes("/api-keys");
        const roles =
          request.method === "GET" || request.method === "HEAD"
            ? readRoles
            : credentialRoute
              ? credentialRoles
              : writeRoles;
        if (!role || !roles.includes(role)) {
          throw new ForbiddenError(
            "Your admin role cannot perform this developer platform operation",
          );
        }
      });

      platformApp.get("/dashboard", async (_request, reply) =>
        sendSuccess(reply, await service.getDashboard()),
      );

      platformApp.get("/applications", async (_request, reply) =>
        sendSuccess(reply, await service.listApplications()),
      );
      platformApp.post("/applications", async (request, reply) => {
        const parsed = createApplicationSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid developer application", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createApplication(parsed.data));
      });
      platformApp.patch("/applications/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = updateApplicationSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid application update", {
            errors: parsed.error.errors,
          });
        return sendSuccess(
          reply,
          await service.updateApplication(id, parsed.data),
        );
      });
      platformApp.post("/applications/:id/api-keys", async (request, reply) => {
        const { id } = request.params as { id: string };
        return sendCreated(reply, await service.createApplicationKey(id));
      });
      platformApp.post(
        "/applications/:id/api-keys/:keyId/rotate",
        async (request, reply) => {
          const { id, keyId } = request.params as { id: string; keyId: string };
          return sendCreated(
            reply,
            await service.rotateApplicationKey(id, keyId),
          );
        },
      );
      platformApp.delete(
        "/applications/:id/api-keys/:keyId",
        async (request, reply) => {
          const { id, keyId } = request.params as { id: string; keyId: string };
          return sendSuccess(
            reply,
            await service.revokeApplicationKey(id, keyId),
          );
        },
      );

      platformApp.get("/products", async (_request, reply) =>
        sendSuccess(reply, await service.listProducts()),
      );
      platformApp.post("/products", async (request, reply) => {
        const parsed = createProductSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid API product", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createProduct(parsed.data));
      });
      platformApp.patch("/products/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = updateActiveSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid API product update", {
            errors: parsed.error.errors,
          });
        return sendSuccess(
          reply,
          await service.updateProduct(id, parsed.data.active),
        );
      });

      platformApp.get("/rate-plans", async (_request, reply) =>
        sendSuccess(reply, await service.listRatePlans()),
      );
      platformApp.post("/rate-plans", async (request, reply) => {
        const parsed = createRatePlanSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid API rate plan", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createRatePlan(parsed.data));
      });

      platformApp.get("/webhooks", async (_request, reply) =>
        sendSuccess(reply, await service.listWebhooks()),
      );
      platformApp.post("/applications/:id/webhooks", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = createWebhookSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid webhook registration", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createWebhook(id, parsed.data));
      });
      platformApp.patch("/webhooks/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = updateActiveSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid webhook update", {
            errors: parsed.error.errors,
          });
        return sendSuccess(
          reply,
          await service.updateWebhook(id, parsed.data.active),
        );
      });

      platformApp.get("/sdk-versions", async (_request, reply) =>
        sendSuccess(reply, await service.listSdkVersions()),
      );
      platformApp.post("/sdk-versions", async (request, reply) => {
        const parsed = createSdkVersionSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid SDK version", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createSdkVersion(parsed.data));
      });

      platformApp.get("/partners", async (_request, reply) =>
        sendSuccess(reply, await service.listPartners()),
      );
      platformApp.post("/partners", async (request, reply) => {
        const parsed = createPartnerSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid partner", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createPartner(parsed.data));
      });
      platformApp.patch("/partners/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = updateActiveSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid partner update", {
            errors: parsed.error.errors,
          });
        return sendSuccess(
          reply,
          await service.updatePartner(id, parsed.data.active),
        );
      });

      platformApp.get("/certifications", async (_request, reply) =>
        sendSuccess(reply, await service.listCertifications()),
      );
      platformApp.post("/certifications", async (request, reply) => {
        const parsed = createCertificationSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid certification", {
            errors: parsed.error.errors,
          });
        return sendCreated(
          reply,
          await service.createCertification(parsed.data),
        );
      });
      platformApp.patch("/certifications/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = updateCertificationSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid certification update", {
            errors: parsed.error.errors,
          });
        return sendSuccess(
          reply,
          await service.updateCertification(id, parsed.data.status),
        );
      });
      platformApp.get("/terminal-registration-requests", async (_request, reply) =>
        sendSuccess(reply, await service.listTerminalRegistrationRequests()),
      );
      platformApp.patch("/terminal-registration-requests/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { status?: string };
        if (!body.status || !["PENDING", "APPROVED", "REJECTED"].includes(body.status))
          throw new ValidationError("Invalid terminal registration status");
        return sendSuccess(
          reply,
          await service.updateTerminalRegistrationRequest(id, body.status),
        );
      });
      platformApp.get("/agents", async (_request, reply) =>
        sendSuccess(reply, await service.listAgents()),
      );
      platformApp.post("/agents", async (request, reply) => {
        const parsed = createAgentRegistrationSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid agent registration", {
            errors: parsed.error.errors,
          });
        return sendCreated(reply, await service.createAgentRegistration(parsed.data));
      });
      platformApp.patch("/agents/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = updateAgentRegistrationSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid agent registration status", {
            errors: parsed.error.errors,
          });
        return sendSuccess(reply, await service.updateAgentRegistration(id, parsed.data.status));
      });
    },
    { prefix: "/admin/developer-platform" },
  );
}

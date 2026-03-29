#!/usr/bin/env node
/**
 * belloemeglio-api — HTTP API server per la pipeline belloemeglio.it
 *
 * Deployato su Render. Env vars: VERCEL_TOKEN, VERCEL_TEAM_ID, GITHUB_ORG, API_KEY
 *
 * Endpoints:
 *   POST /publish        — Crea progetto Vercel + dominio + attendi deploy
 *   GET  /status/:slug   — Controlla stato progetto Vercel
 *   GET  /health         — Health check
 *
 * Autenticazione: header "x-api-key" richiesto su POST /publish
 */

import { createServer } from "node:http";

// ─── Config ─────────────────────────────────────────────────────
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const GITHUB_ORG = process.env.GITHUB_ORG || "fox-0101";
const API_KEY = process.env.API_KEY || "";
const API = "https://api.vercel.com";
const DOMAIN_BASE = "belloemeglio.it";
const PORT = parseInt(process.env.PORT || "3456", 10);

if (!VERCEL_TOKEN) {
  console.error("❌ VERCEL_TOKEN mancante. Imposta VERCEL_TOKEN nelle env vars.");
  process.exit(1);
}

// ─── Vercel API Helper ──────────────────────────────────────────
async function vercelAPI(path, method = "GET", body = null) {
  const teamParam = VERCEL_TEAM_ID
    ? (path.includes("?") ? "&" : "?") + `teamId=${VERCEL_TEAM_ID}`
    : "";
  const url = `${API}${path}${teamParam}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Pipeline ───────────────────────────────────────────────────
async function publishPreview(slug, azienda) {
  const steps = [];
  const domain = `${slug}.${DOMAIN_BASE}`;

  // Step 1: Create/check project
  let projectId;
  const check = await vercelAPI(`/v9/projects/${slug}`);
  if (check.status === 200) {
    projectId = check.data.id;
    steps.push({ step: "project", status: "exists", project_id: projectId });
  } else {
    const create = await vercelAPI("/v10/projects", "POST", {
      name: slug,
      framework: "vite",
      gitRepository: { repo: `${GITHUB_ORG}/${slug}`, type: "github" },
    });
    if (create.status === 200 || create.status === 201) {
      projectId = create.data.id;
      steps.push({ step: "project", status: "created", project_id: projectId });
    } else if (create.status === 409) {
      const retry = await vercelAPI(`/v9/projects/${slug}`);
      projectId = retry.data?.id;
      steps.push({ step: "project", status: "exists_409", project_id: projectId });
    } else {
      return { ok: false, error: `Create project failed: ${create.status}`, details: create.data, steps };
    }
  }

  // Step 1b: Verify git integration is linked
  const projCheck = await vercelAPI(`/v9/projects/${projectId}`);
  const gitLink = projCheck.data?.link;
  if (!gitLink || !gitLink.repo) {
    steps.push({ step: "git_check", status: "no_git_integration", message: "Project has no linked Git repo — deploy will never trigger" });
    // Attempt to link the repo
    const linkRes = await vercelAPI(`/v9/projects/${projectId}/link`, "POST", {
      type: "github",
      repo: `${GITHUB_ORG}/${slug}`,
      productionBranch: "main",
    });
    if (linkRes.status === 200 || linkRes.status === 201) {
      steps.push({ step: "git_link", status: "linked", repo: `${GITHUB_ORG}/${slug}` });
    } else {
      steps.push({ step: "git_link", status: "failed", http: linkRes.status, details: linkRes.data });
      return { ok: false, error: `Git integration failed: cannot link ${GITHUB_ORG}/${slug}`, slug, steps };
    }
  } else {
    steps.push({ step: "git_check", status: "ok", repo: gitLink.repo });
  }

  // Step 2: Add domain (bloccante — senza dominio il sito non è raggiungibile)
  const domRes = await vercelAPI(`/v10/projects/${projectId}/domains`, "POST", { name: domain });
  if (domRes.status === 200 || domRes.status === 201) {
    steps.push({ step: "domain", status: "added", domain });
  } else if (domRes.status === 409) {
    steps.push({ step: "domain", status: "already_configured", domain });
  } else {
    steps.push({ step: "domain", status: "failed", http: domRes.status, details: domRes.data });
    return { ok: false, error: `Domain setup failed: ${domRes.status}`, slug, domain, steps };
  }

  // Step 3: Trigger build via Vercel Deployments API (più affidabile dei deploy hooks)
  // Metodo primario: POST /v13/deployments con gitSource
  let deployTriggered = false;

  // Metodo 1: Vercel Create Deployment API (diretto, affidabile)
  const deployBody = {
    name: slug,
    project: projectId,
    target: "production",
    gitSource: {
      type: "github",
      org: GITHUB_ORG,
      repo: slug,
      ref: "main",
    },
  };
  console.log(`[DEPLOY] Triggering deployment via POST /v13/deployments for ${slug}...`);
  const deployRes = await vercelAPI("/v13/deployments", "POST", deployBody);
  if (deployRes.status === 200 || deployRes.status === 201) {
    deployTriggered = true;
    steps.push({
      step: "deploy_trigger",
      status: "triggered_via_api",
      deploymentId: deployRes.data?.id,
      url: deployRes.data?.url,
    });
    console.log(`[DEPLOY] ✅ Deployment created: ${deployRes.data?.id} — ${deployRes.data?.url}`);
  } else {
    steps.push({
      step: "deploy_trigger_api",
      status: "failed",
      http: deployRes.status,
      details: deployRes.data,
    });
    console.log(`[DEPLOY] ⚠️ API deploy failed (${deployRes.status}), trying deploy hook fallback...`);

    // Metodo 2 (fallback): Deploy hook
    let deployHookUrl = null;
    const hookRes = await vercelAPI(`/v1/integrations/deploy-hooks`, "POST", {
      projectId,
      name: "belloemeglio-auto",
      ref: "main",
    });
    if (hookRes.status === 200 || hookRes.status === 201) {
      // Usa la URL dalla response (include il secret)
      deployHookUrl = hookRes.data?.url;
      if (!deployHookUrl) {
        // Fallback: costruisci URL con id
        deployHookUrl = `https://api.vercel.com/v1/integrations/deploy/${hookRes.data?.id}`;
      }
      steps.push({ step: "deploy_hook", status: "created", hookId: hookRes.data?.id });
    } else {
      const listHooks = await vercelAPI(`/v1/integrations/deploy-hooks?projectId=${projectId}`);
      const existing = Array.isArray(listHooks.data) ? listHooks.data[0] : null;
      if (existing) {
        deployHookUrl = existing.url || `https://api.vercel.com/v1/integrations/deploy/${existing.id}`;
        steps.push({ step: "deploy_hook", status: "reused_existing", hookId: existing.id });
      } else {
        steps.push({ step: "deploy_hook", status: "failed", http: hookRes.status, details: hookRes.data });
      }
    }

    if (deployHookUrl) {
      // Deploy hooks si triggerano con POST (non GET)
      const triggerRes = await fetch(deployHookUrl, { method: "POST" });
      const triggerData = await triggerRes.json().catch(() => ({}));
      if (triggerRes.status < 300 && (triggerData?.job || triggerData?.id)) {
        deployTriggered = true;
        steps.push({ step: "deploy_hook_trigger", status: "triggered", data: triggerData });
        console.log(`[DEPLOY] ✅ Hook triggered successfully`);
      } else {
        steps.push({ step: "deploy_hook_trigger", status: "warning", http: triggerRes.status, details: triggerData });
        console.log(`[DEPLOY] ❌ Hook trigger failed: ${triggerRes.status}`);
      }
    }
  }

  if (!deployTriggered) {
    steps.push({ step: "deploy", status: "no_trigger", message: "Could not trigger deployment via API or hook" });
  }

  // Step 4: Wait for deploy to be READY (max 120s)
  let deployReady = false;
  for (let i = 0; i < 12; i++) {
    const deps = await vercelAPI(`/v6/deployments?projectId=${projectId}&limit=1`);
    const dep = deps.data?.deployments?.[0];
    if (dep && (dep.readyState === "READY" || dep.state === "READY")) {
      deployReady = true;
      steps.push({ step: "deploy", status: "ready", url: dep.url });
      break;
    }
    const state = dep?.readyState || dep?.state || "no_deployment";
    if (i === 0) steps.push({ step: "deploy_wait", status: "polling", currentState: state });
    await sleep(10000);
  }
  if (!deployReady) {
    steps.push({ step: "deploy", status: "pending", message: "Not ready after 120s, check later" });
  }

  // Se il deploy non è pronto, è un fallimento — Relay NON deve aggiornare Notion
  if (!deployReady) {
    return {
      ok: false,
      error: "Deploy not ready after 120s — no deployment found. Check Vercel git integration.",
      preview_url: `https://${domain}`,
      slug,
      azienda,
      project_id: projectId,
      domain,
      deploy_ready: false,
      steps,
    };
  }

  return {
    ok: true,
    preview_url: `https://${domain}`,
    slug,
    azienda,
    project_id: projectId,
    domain,
    deploy_ready: true,
    steps,
  };
}

async function checkStatus(slug) {
  const check = await vercelAPI(`/v9/projects/${slug}`);
  if (check.status !== 200) {
    return { ok: false, error: "Project not found" };
  }
  const p = check.data;
  const dep = p.latestDeployments?.[0] || {};
  return {
    ok: true,
    project_id: p.id,
    name: p.name,
    framework: p.framework,
    deploy_state: dep.readyState || dep.state || "unknown",
    deploy_url: dep.url || null,
    domains: p.alias || [],
  };
}

// ─── HTTP Server ────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Content-Type", "application/json");

  try {
    // Health check
    if (url.pathname === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, service: "belloemeglio-publish", uptime: process.uptime() }));
      return;
    }

    // Publish preview
    if (url.pathname === "/publish" && req.method === "POST") {
      // Auth check
      if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: "Unauthorized — x-api-key header required" }));
        return;
      }
      const body = await parseBody(req);
      if (!body.slug) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "slug is required" }));
        return;
      }
      console.log(`[${new Date().toISOString()}] POST /publish slug=${body.slug} azienda=${body.azienda || ""}`);
      const result = await publishPreview(body.slug, body.azienda || body.slug);
      res.writeHead(result.ok ? 200 : 500);
      res.end(JSON.stringify(result, null, 2));
      console.log(`[${new Date().toISOString()}] → ${result.ok ? "OK" : "FAIL"} ${result.preview_url || ""}`);
      return;
    }

    // Check status
    const statusMatch = url.pathname.match(/^\/status\/([a-z0-9-]+)$/);
    if (statusMatch && req.method === "GET") {
      const slug = statusMatch[1];
      console.log(`[${new Date().toISOString()}] GET /status/${slug}`);
      const result = await checkStatus(slug);
      res.writeHead(result.ok ? 200 : 404);
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "Not found. Use POST /publish or GET /status/:slug" }));
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 belloemeglio publish-server running on http://localhost:${PORT}`);
  console.log(`   POST /publish          — Deploy pipeline`);
  console.log(`   GET  /status/:slug     — Check project status`);
  console.log(`   GET  /health           — Health check\n`);
});

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

  // Step 2: Add domain
  const domRes = await vercelAPI(`/v10/projects/${projectId}/domains`, "POST", { name: domain });
  if (domRes.status === 200 || domRes.status === 201) {
    steps.push({ step: "domain", status: "added", domain });
  } else if (domRes.status === 409) {
    steps.push({ step: "domain", status: "already_configured", domain });
  } else {
    steps.push({ step: "domain", status: "warning", http: domRes.status, details: domRes.data });
  }

  // Step 3: Wait for deploy (max 90s)
  let deployReady = false;
  for (let i = 0; i < 9; i++) {
    const deps = await vercelAPI(`/v6/deployments?projectId=${projectId}&limit=1`);
    const dep = deps.data?.deployments?.[0];
    if (dep && (dep.readyState === "READY" || dep.state === "READY")) {
      deployReady = true;
      steps.push({ step: "deploy", status: "ready", url: dep.url });
      break;
    }
    await sleep(10000);
  }
  if (!deployReady) {
    steps.push({ step: "deploy", status: "pending", message: "Not ready after 90s, check later" });
  }

  return {
    ok: true,
    preview_url: `https://${domain}`,
    slug,
    azienda,
    project_id: projectId,
    domain,
    deploy_ready: deployReady,
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

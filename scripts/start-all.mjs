#!/usr/bin/env node
// Multi-agent supervisor for single-container deploys (Railway, Fly, Render,
// any platform where you get ONE process and no systemd/launchd to spawn the
// rest).
//
// ClaudeClaw runs one OS process per agent. `npm start` boots only `main`.
// Locally the extra agents are launched by launchd (macOS) or systemd (Linux);
// inside a container neither exists, so the specialist agents never come up.
// This wrapper takes their place: it boots `main` plus every agent whose bot
// token is present in the environment, and keeps them alive.
//
// Which agents start is driven entirely by env vars. Each agent declares its
// token var in agent.yaml (`telegram_bot_token_env:`), e.g. research ->
// RESEARCH_BOT_TOKEN. Set that var in your platform's dashboard and the agent
// auto-starts on the next boot; remove it and the agent stays dormant. No code
// or start-command changes needed to add or drop an agent.
//
// agent.yaml is gitignored and container filesystems are ephemeral, so for any
// enabled agent that has only agent.yaml.example on disk we materialize
// agent.yaml from the example at boot. That makes the whole setup survive
// redeploys with nothing but env vars to manage.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');

function log(msg) {
  console.log(`[supervisor] ${msg}`);
}

if (!fs.existsSync(ENTRY)) {
  console.error(`[supervisor] Build output missing: ${ENTRY}\nRun "npm run build" before starting.`);
  process.exit(1);
}

// Pull the token env var name out of an agent.yaml / agent.yaml.example without
// a YAML dependency. The field is a flat scalar, so a line match is enough.
function readTokenEnvName(yamlPath) {
  try {
    const text = fs.readFileSync(yamlPath, 'utf-8');
    const m = text.match(/^\s*telegram_bot_token_env:\s*["']?([A-Za-z0-9_]+)["']?\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Discover agents that should run: a directory under agents/ (skipping
// _template and friends) whose declared token env var is set. Returns the
// agent id for each enabled agent and ensures its agent.yaml exists.
function discoverEnabledAgents() {
  const enabled = [];
  if (!fs.existsSync(AGENTS_DIR)) return enabled;

  for (const id of fs.readdirSync(AGENTS_DIR)) {
    if (id.startsWith('_') || id.startsWith('.')) continue;
    const dir = path.join(AGENTS_DIR, id);
    if (!fs.statSync(dir).isDirectory()) continue;

    const yamlPath = path.join(dir, 'agent.yaml');
    const examplePath = path.join(dir, 'agent.yaml.example');
    const sourcePath = fs.existsSync(yamlPath) ? yamlPath : examplePath;
    if (!fs.existsSync(sourcePath)) continue;

    const tokenEnv = readTokenEnvName(sourcePath);
    if (!tokenEnv) {
      log(`skip ${id}: no telegram_bot_token_env in ${path.basename(sourcePath)}`);
      continue;
    }

    if (!process.env[tokenEnv]) {
      log(`skip ${id}: ${tokenEnv} not set`);
      continue;
    }

    // Token is present -> this agent is on. Materialize agent.yaml from the
    // example so loadAgentConfig() can find it (agent.yaml is gitignored and
    // wiped on redeploy).
    if (!fs.existsSync(yamlPath)) {
      try {
        fs.copyFileSync(examplePath, yamlPath);
        log(`generated agent.yaml for ${id} from example`);
      } catch (err) {
        log(`skip ${id}: could not write agent.yaml (${err?.message || err})`);
        continue;
      }
    }

    enabled.push({ id, tokenEnv });
  }
  return enabled;
}

let shuttingDown = false;
const children = new Map(); // label -> ChildProcess

// Supervise one process. Restarts on crash with exponential backoff, resetting
// the backoff once the process has stayed up long enough to be considered
// healthy. Mirrors the war-room respawn policy used elsewhere in the codebase.
function supervise(label, args) {
  const MAX_BACKOFF_MS = 30_000;
  const HEALTHY_MS = 60_000;
  let attempts = 0;

  const start = () => {
    if (shuttingDown) return;
    const startedAt = Date.now();
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    children.set(label, child);
    log(`started ${label} (pid ${child.pid})`);

    child.on('exit', (code, signal) => {
      children.delete(label);
      if (shuttingDown) return;
      if (Date.now() - startedAt > HEALTHY_MS) attempts = 0;
      attempts += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 5));
      log(`${label} exited (code=${code ?? 'null'} signal=${signal ?? 'null'}); restarting in ${delay}ms`);
      setTimeout(start, delay);
    });

    child.on('error', (err) => {
      log(`${label} failed to spawn: ${err?.message || err}`);
    });
  };

  start();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, stopping ${children.size} process(es)`);
  for (const child of children.values()) {
    try { child.kill(signal); } catch { /* already gone */ }
  }
  // Give children a moment to exit cleanly, then force quit.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const agents = discoverEnabledAgents();
log(`starting main + ${agents.length} agent(s): ${agents.map((a) => a.id).join(', ') || '(none)'}`);

// main first (owns the dashboard, scheduler, memory decay/consolidation), then
// each enabled specialist agent.
supervise('main', []);
for (const agent of agents) {
  supervise(`agent:${agent.id}`, ['--agent', agent.id]);
}

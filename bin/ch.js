#!/usr/bin/env node
'use strict';
// claudehopper helper: the account vault behind /account. Also usable from a terminal:
//
//   node ch.js list                  list saved accounts
//   node ch.js add <name>            save the logged-in account under <name>
//   node ch.js remove <name>         forget a saved account
//   node ch.js rename <old> <new>    rename a saved account
//   node ch.js switch <name>         switch every Claude Code session to a saved account
//   node ch.js sync                  save the logged-in account's current tokens to the vault
//
// Claude Code re-reads ~/.claude/.credentials.json before each request, so a switch takes effect
// on the next message of every open session; no restart.
//
// Machine commands used by the mod (JSON on stdout with --json): status, adopt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = '0.1.0';
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CREDS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const CONFIG_FILE = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(HOME, '.claude.json');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const VAULT = process.env.CLAUDEHOPPER_HOME || path.join(HOME, '.claudehopper');
const META_FILE = path.join(VAULT, 'accounts.json');
const SECRETS_DIR = path.join(VAULT, 'secrets');
const USAGE_FILE = path.join(VAULT, 'usage.json');

class UserError extends Error {}

// ---------- files ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ch-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2));
}

// ---------- secret storage (DPAPI on Windows) ----------

const PS_DPAPI = (op) => `Add-Type -AssemblyName System.Security;` +
  `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
  `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser');` +
  `[Console]::Out.Write([Convert]::ToBase64String($o))`;

function dpapi(op, base64) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_DPAPI(op)], {
    input: base64, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`DPAPI ${op} failed: ${(r.stderr || r.error || '').toString().trim()}`);
  return r.stdout.trim();
}

function secretFile(id) {
  return path.join(SECRETS_DIR, `${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24)}.bin`);
}

function writeSecret(id, value) {
  const plain = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const body = process.platform === 'win32' ? `dpapi:${dpapi('Protect', plain)}` : `plain:${plain}`;
  writeAtomic(secretFile(id), body);
}

function readSecret(id) {
  const body = fs.readFileSync(secretFile(id), 'utf8');
  const [kind, data] = [body.slice(0, body.indexOf(':')), body.slice(body.indexOf(':') + 1)];
  const plain = kind === 'dpapi' ? dpapi('Unprotect', data) : data;
  return JSON.parse(Buffer.from(plain, 'base64').toString('utf8'));
}

// ---------- live Claude Code state ----------

function liveCreds() {
  return readJson(CREDS_FILE, {}).claudeAiOauth || null;
}

function liveAccount() {
  return readJson(CONFIG_FILE, {}).oauthAccount || null;
}

function identityOf(account) {
  return account && account.accountUuid ? `${account.accountUuid}:${account.organizationUuid || ''}` : null;
}

function hash(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

// Which account the credentials file logs in as. A running session can write its stale
// oauthAccount back to .claude.json, so the token is the signal; then the account this vault
// last put in place or confirmed (`meta.current`); the config only when neither is known.
function activeEntry(meta) {
  const creds = liveCreds();
  if (!creds || !creds.refreshToken) return null;
  const rt = hash(creds.refreshToken);
  return meta.accounts.find(a => a.rtHash === rt)
    || meta.accounts.find(a => a.id === meta.current)
    || meta.accounts.find(a => a.id === identityOf(liveAccount()))
    || null;
}

// Asks Anthropic whose tokens these are. null when it cannot tell (expired token, offline,
// endpoint changed).
async function profileOf(creds) {
  if (!creds || !creds.accessToken || (creds.expiresAt && creds.expiresAt < Date.now() + 30_000)) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const p = await res.json();
    if (!p.account || !p.account.uuid) return null;
    const org = p.organization || {};
    return {
      id: `${p.account.uuid}:${org.uuid || ''}`,
      account: {
        accountUuid: p.account.uuid,
        emailAddress: p.account.email,
        organizationUuid: org.uuid,
        displayName: p.account.display_name,
        fullName: p.account.full_name,
        organizationName: org.name,
        organizationType: org.organization_type,
        billingType: org.billing_type,
        organizationRateLimitTier: org.rate_limit_tier,
        hasExtraUsageEnabled: org.has_extra_usage_enabled,
      },
    };
  } catch (_) {
    return null;
  }
}

// ---------- vault metadata ----------

function loadMeta() {
  const meta = readJson(META_FILE, null) || { version: 1, accounts: [] };
  meta.accounts = meta.accounts || [];
  return meta;
}

function findByName(meta, name) {
  return meta.accounts.find(a => a.name.toLowerCase() === String(name).toLowerCase());
}

function validName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name || '')) {
    throw new UserError(`invalid name "${name}": use letters, digits, ".", "_" or "-" (max 32)`);
  }
  return name;
}

function autoName(meta, account) {
  const base = String(account.emailAddress || 'account').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'account';
  let name = base;
  for (let i = 2; findByName(meta, name); i++) name = `${base}-${i}`;
  return name;
}

function describe(account, creds) {
  return {
    email: account.emailAddress || '',
    displayName: account.displayName || account.fullName || '',
    orgName: account.organizationName || '',
    plan: (creds && creds.subscriptionType) || account.billingType || '',
    tier: (creds && creds.rateLimitTier) || '',
    refreshExpiresAt: (creds && creds.refreshTokenExpiresAt) || null,
  };
}

function isRefreshExpired(entry) {
  return Boolean(entry.refreshExpiresAt && entry.refreshExpiresAt < Date.now());
}

// Stores the logged-in account's tokens in the vault. `create` adds an account the vault does not
// know; `name` names (or renames) it. Without either, only a known account is updated.
async function saveLive({ name, create } = {}) {
  const creds = liveCreds();
  if (!creds || !creds.refreshToken) return { saved: false, reason: 'not-logged-in' };

  const meta = loadMeta();
  const rt = hash(creds.refreshToken);
  const fp = hash(`${creds.refreshToken}|${creds.accessToken}`);
  let entry = meta.accounts.find(a => a.rtHash === rt);
  let account = null;

  if (!entry) {
    // A refreshed or brand-new token: find out whose it is before storing it anywhere.
    const live = liveAccount();
    const prof = await profileOf(creds);
    // Offline: right after a login (create) the config was just written for this token; otherwise
    // the token is one Claude Code refreshed for the account last put in place.
    const id = prof ? prof.id : create || name ? identityOf(live) : meta.current || identityOf(live);
    if (!id) return { saved: false, reason: 'not-logged-in' };
    account = identityOf(live) === id ? live : prof ? prof.account : null;
    entry = meta.accounts.find(a => a.id === id);
    if (!entry && !create && !name) return { saved: false, reason: 'unknown-account', email: account.emailAddress };
  }

  const created = !entry;
  if (!entry && !account) return { saved: false, reason: 'unknown-account' };
  if (!entry) {
    entry = { name: name ? validName(name) : autoName(meta, account), id: identityOf(account) };
    meta.accounts.push(entry);
  } else if (name && name !== entry.name) {
    const clash = findByName(meta, validName(name));
    if (clash && clash !== entry) throw new UserError(`an account named "${name}" already exists`);
    entry.name = name;
  }

  const needsWrite = created || entry.fingerprint !== fp;
  if (needsWrite) {
    if (!account) {
      const live = liveAccount();
      account = identityOf(live) === entry.id ? live : readSecret(entry.id).oauthAccount;
    }
    writeSecret(entry.id, { claudeAiOauth: creds, oauthAccount: account });
    Object.assign(entry, describe(account, creds), { savedAt: Date.now() });
  }
  Object.assign(entry, { fingerprint: fp, rtHash: rt, refreshExpiresAt: creds.refreshTokenExpiresAt || entry.refreshExpiresAt || null });
  meta.current = entry.id;
  writeJson(META_FILE, meta);
  return { saved: needsWrite, name: entry.name, email: entry.email, created };
}

function applyAccount(name) {
  const meta = loadMeta();
  const entry = findByName(meta, name);
  if (!entry) throw new UserError(`no saved account named "${name}"`);
  const secret = readSecret(entry.id);

  const credsDoc = readJson(CREDS_FILE, {});
  credsDoc.claudeAiOauth = secret.claudeAiOauth;
  writeJson(CREDS_FILE, credsDoc);

  const config = readJson(CONFIG_FILE, null);
  if (config) {
    config.oauthAccount = secret.oauthAccount;
    writeJson(CONFIG_FILE, config);
  }
  entry.rtHash = hash(secret.claudeAiOauth.refreshToken);
  meta.current = entry.id;
  writeJson(META_FILE, meta);

  return { name: entry.name, email: entry.email, needsLogin: isRefreshExpired(entry) };
}

async function switchTo(name) {
  const meta = loadMeta();
  const target = findByName(meta, name);
  if (!target) throw new UserError(`no saved account named "${name}"`);
  // Save first: a refreshed token is matched to its account (asking Anthropic if need be) before
  // anything decides which account is active, so the newest tokens are never lost.
  await saveLive({});
  const current = activeEntry(loadMeta());
  if (current && current.id === target.id) return { name: target.name, email: target.email, unchanged: true };
  return applyAccount(target.name);
}

// ---------- running sessions ----------

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function runningSessions() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => /^\d+\.json$/.test(f)); } catch (_) {}
  return files
    .map(f => readJson(path.join(SESSIONS_DIR, f), null))
    .filter(s => s && s.pid && isAlive(s.pid))
    .map(s => ({ pid: s.pid, sessionId: s.sessionId, name: s.name || '', cwd: s.cwd || '', status: s.status || '' }));
}

// ---------- commands ----------

async function status(sessionId) {
  const creds = liveCreds();
  if (creds && creds.refreshToken && !loadMeta().accounts.some(a => a.rtHash === hash(creds.refreshToken))) {
    await saveLive({}); // a token Claude Code refreshed: tie it to its account
  }
  const meta = loadMeta();
  const active = activeEntry(meta);
  const live = liveAccount();
  const accounts = meta.accounts.map(a => ({
    name: a.name, id: a.id, email: a.email, displayName: a.displayName, orgName: a.orgName,
    plan: a.plan, tier: a.tier, savedAt: a.savedAt, refreshExpiresAt: a.refreshExpiresAt,
    needsLogin: isRefreshExpired(a), isActive: Boolean(active && a.id === active.id),
  }));
  return {
    version: VERSION,
    vault: VAULT,
    usageFile: USAGE_FILE,
    activeId: active ? active.id : identityOf(live),
    activeName: active ? active.name : null,
    liveEmail: active ? active.email : (live || {}).emailAddress || null,
    otherSessions: runningSessions().filter(s => s.sessionId !== sessionId),
    accounts,
  };
}

async function printList() {
  const s = await status();
  if (s.accounts.length === 0) {
    console.log('No saved accounts. Log in with Claude Code, then run: ch add <name>');
    return;
  }
  const width = Math.max(...s.accounts.map(a => a.name.length));
  for (const a of s.accounts) {
    const flags = [a.isActive ? 'active' : '', a.needsLogin ? 'login expired' : ''].filter(Boolean).join(', ');
    console.log(`${a.isActive ? '*' : ' '} ${a.name.padEnd(width)}  ${a.email.padEnd(32)} ${(a.plan || '').padEnd(6)} ${flags}`);
  }
  if (s.liveEmail && !s.activeName) console.log(`\nLogged in as ${s.liveEmail} (not saved): ch add <name>`);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  const out = v => (json ? console.log(JSON.stringify(v)) : console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
  switch (cmd) {
    case 'status': return out(await status(flag(rest, '--session')));
    case 'list': case 'ls': case undefined: return json ? out(await status()) : printList();
    case 'add': {
      const r = await saveLive({ name: rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined, create: true });
      if (r.reason) throw new UserError('not logged in to Claude Code');
      return out(json ? r : `saved ${r.name} (${r.email})`);
    }
    case 'adopt': return out(await saveLive({ create: true }));
    case 'sync': return out(await saveLive({}));
    case 'remove': case 'rm': {
      const meta = loadMeta();
      const entry = findByName(meta, rest[0]);
      if (!entry) throw new UserError(`no saved account named "${rest[0]}"`);
      meta.accounts = meta.accounts.filter(a => a !== entry);
      writeJson(META_FILE, meta);
      try { fs.unlinkSync(secretFile(entry.id)); } catch (_) {}
      const usage = readJson(USAGE_FILE, {});
      if (usage[entry.id]) { delete usage[entry.id]; writeJson(USAGE_FILE, usage); }
      return out(json ? { removed: entry.name } : `removed ${entry.name}`);
    }
    case 'rename': {
      const meta = loadMeta();
      const entry = findByName(meta, rest[0]);
      if (!entry) throw new UserError(`no saved account named "${rest[0]}"`);
      const clash = findByName(meta, validName(rest[1]));
      if (clash && clash !== entry) throw new UserError(`an account named "${rest[1]}" already exists`);
      entry.name = rest[1];
      writeJson(META_FILE, meta);
      return out(json ? { renamed: entry.name } : `renamed to ${entry.name}`);
    }
    case 'switch': case 'use': {
      const r = await switchTo(rest[0]);
      if (json) return out(r);
      if (r.unchanged) return out(`already on ${r.name}`);
      const others = runningSessions().length;
      return out(`switched to ${r.name} (${r.email})${r.needsLogin ? ', login expired: run /login' : ''}` +
        (others ? `\n${others} open Claude Code session(s) use it from their next message.` : ''));
    }
    case 'version': case '--version': return out(VERSION);
    case 'help': case '--help': case '-h':
      return out(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    default: throw new UserError(`unknown command "${cmd}" (try: help)`);
  }
}

main(process.argv.slice(2)).catch(e => {
  const json = process.argv.includes('--json');
  const message = e instanceof UserError ? e.message : `${e.message}`;
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(`ch: ${message}`);
  process.exit(e instanceof UserError ? 2 : 1);
});

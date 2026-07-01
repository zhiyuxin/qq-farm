#!/usr/bin/env node

const process = require('node:process');

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function usage() {
  console.log(`Usage:
  node tools/push-code.cjs --server http://YOUR_VPS:3007 --token TOKEN --account ACCOUNT --platform qq --code "wss://...&code=..."

Options:
  --server      Farm panel base URL, for example http://1.2.3.4:3007
  --endpoint    Full update endpoint. Overrides --server.
  --token       CODE_UPDATE_TOKEN configured on the server.
  --account     Account id, QQ/uin, or exact account remark.
  --platform    Optional: qq or wx.
  --ver         Optional client version. Auto-extracted from full URLs.
  --code        Plain code or a full URL containing code=.
  --restart     Optional: true/false. Default true.
  --no-restart  Only save code, do not start or restart the account.

Environment:
  QQ_FARM_SERVER, QQ_FARM_CODE_ENDPOINT, QQ_FARM_CODE_TOKEN,
  QQ_FARM_ACCOUNT, QQ_FARM_PLATFORM, QQ_FARM_CODE
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }

    const eq = item.indexOf('=');
    const key = item.slice(2, eq >= 0 ? eq : undefined);
    if (key === 'help' || key === 'h') {
      args.help = true;
      continue;
    }
    if (key === 'no-restart') {
      args.restart = false;
      continue;
    }

    const value = eq >= 0 ? item.slice(eq + 1) : argv[i + 1];
    if (eq < 0) i += 1;
    args[key] = value;
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function extractCode(input) {
  return extractLoginParams(input).code;
}

function extractQueryValue(raw, key) {
  const match = clean(raw).match(new RegExp(`[?&]${key}=([^&\\s]+)`, 'i'));
  if (!match || !match[1]) return '';
  try {
    return clean(decodeURIComponent(match[1]));
  } catch {
    return clean(match[1]);
  }
}

function extractLoginParams(input) {
  const raw = clean(input);
  if (!raw) return {};

  try {
    const parsed = new URL(raw);
    const code = clean(parsed.searchParams.get('code'));
    if (code) {
      return {
        code,
        clientVersion: clean(parsed.searchParams.get('ver')),
        platform: clean(parsed.searchParams.get('platform')),
        os: clean(parsed.searchParams.get('os')),
        serverUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
      };
    }
  } catch {
    // Plain codes are not URLs.
  }

  const code = extractQueryValue(raw, 'code');
  if (code) {
    return {
      code,
      clientVersion: extractQueryValue(raw, 'ver'),
      platform: extractQueryValue(raw, 'platform'),
      os: extractQueryValue(raw, 'os'),
      serverUrl: '',
    };
  }

  return { code: raw };
}

function buildEndpoint(args) {
  const explicit = clean(args.endpoint || process.env.QQ_FARM_CODE_ENDPOINT);
  if (explicit) return explicit;

  const server = clean(args.server || process.env.QQ_FARM_SERVER);
  if (!server) return '';
  if (/\/api\/code\/update\/?$/i.test(server)) return server;
  return `${server.replace(/\/+$/, '')}/api/code/update`;
}

function normalizeRestart(value) {
  if (value === false) return false;
  const text = clean(value);
  if (!text) return true;
  return !['0', 'false', 'no', 'n', 'off'].includes(text.toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js 18+ because it uses built-in fetch.');
  }

  const stdin = await readStdin();
  const endpoint = buildEndpoint(args);
  const token = clean(args.token || process.env.QQ_FARM_CODE_TOKEN || process.env.CODE_UPDATE_TOKEN);
  const account = clean(args.account || args.id || process.env.QQ_FARM_ACCOUNT);
  const rawCode = clean(args.code || args.url || args._[0] || process.env.QQ_FARM_CODE || stdin);
  const loginParams = extractLoginParams(rawCode);
  const code = loginParams.code;
  const platform = clean(args.platform || process.env.QQ_FARM_PLATFORM || loginParams.platform).toLowerCase();
  const clientVersion = clean(args.clientVersion || args.ver || process.env.QQ_FARM_CLIENT_VERSION || loginParams.clientVersion);
  const os = clean(args.os || process.env.QQ_FARM_OS || loginParams.os);
  const serverUrl = clean(args.gameServer || process.env.QQ_FARM_GAME_SERVER || loginParams.serverUrl);

  if (!endpoint || !token || !account || !code) {
    usage();
    const missing = [
      !endpoint ? 'endpoint/server' : '',
      !token ? 'token' : '',
      !account ? 'account' : '',
      !code ? 'code' : '',
    ].filter(Boolean).join(', ');
    throw new Error(`Missing required value: ${missing}`);
  }

  const payload = {
    account,
    code,
    restart: normalizeRestart(args.restart),
    source: clean(args.source || 'push-code-script'),
  };
  if (platform) payload.platform = platform;
  if (clientVersion) payload.clientVersion = clientVersion;
  if (os) payload.os = os;
  if (serverUrl) payload.serverUrl = serverUrl;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Code-Update-Token': token,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error.message}; body=${text.slice(0, 200)}`);
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  const result = data.data || {};
  console.log('Code updated successfully.');
  console.log(`Account: ${result.accountName || account} (${result.accountId || account})`);
  console.log(`Platform: ${result.platform || platform || 'unchanged'}`);
  console.log(`Client version: ${result.clientVersion || clientVersion || 'unchanged'}`);
  console.log(`Code: ${result.codePreview || '(hidden)'} length=${result.codeLength || code.length}`);
  console.log(`Runtime: ${result.runtimeAction || 'none'}`);
}

main().catch((error) => {
  console.error(`push-code failed: ${error.message}`);
  process.exit(1);
});

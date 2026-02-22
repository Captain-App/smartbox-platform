/**
 * Gateway utilities for admin-api worker
 * 
 * Uses presigned R2 URLs for restore — same approach as the main worker.
 * The startup script (start-moltbot.sh v7) handles restore via RESTORE_URL.
 */

// ─── S3v4 Presigned URL (inlined from src/gateway/presign.ts) ───

function formatDateStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').slice(0, 8);
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function arrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return arrayToHex(new Uint8Array(hash));
}

async function hmacSign(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const sig = await hmacSign(key, data);
  return arrayToHex(new Uint8Array(sig));
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSign(new TextEncoder().encode(`AWS4${secretKey}`).buffer, dateStamp);
  const kRegion = await hmacSign(kDate, region);
  const kService = await hmacSign(kRegion, service);
  return hmacSign(kService, 'aws4_request');
}

async function presignR2Url(opts: {
  accessKeyId: string; secretAccessKey: string; accountId: string;
  bucket: string; key: string; method?: 'GET' | 'PUT'; expiresIn?: number;
}): Promise<string> {
  const { accessKeyId, secretAccessKey, accountId, bucket, key, method = 'GET', expiresIn = 300 } = opts;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const dateStamp = formatDateStamp(now);
  const amzDate = formatAmzDate(now);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalQueryString = Object.keys(queryParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQueryString, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await getSigningKey(secretAccessKey, dateStamp, 'auto', 's3');
  const signature = await hmacHex(signingKey, stringToSign);

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

// ─── Gateway shim ───

export function getSandboxForUser(env: any, userId: string): any {
  return env.Sandbox;
}

export async function ensureMoltbotGateway(sandbox: any, env: any, userId: string): Promise<void> {
  // Check if gateway is already running
  try {
    const processes = await sandbox.listProcesses();
    const gatewayRunning = processes.some((p: any) =>
      (p.command?.includes('openclaw gateway') || p.command?.includes('start-moltbot.sh'))
      && p.status === 'running'
    );
    if (gatewayRunning) return;
  } catch { /* cold container — proceed */ }

  // Load config from R2 and inject it directly (avoids presign + ensures channels/plugins/models are present)
  let injectedConfigB64: string | null = null;
  try {
    const key = `users/${userId}/openclaw/openclaw.json`;
    const obj = await env.MOLTBOT_BUCKET?.get?.(key);
    if (obj) {
      const txt = await obj.text();
      // base64 encode in a unicode-safe way
      injectedConfigB64 = btoa(unescape(encodeURIComponent(txt)));
      console.log(`[gateway-shim] Injecting openclaw.json from R2 for ${userId.slice(0, 8)} (${txt.length} bytes)`);
    } else {
      console.warn(`[gateway-shim] No openclaw.json found in R2 for ${userId.slice(0, 8)}`);
    }
  } catch (err) {
    console.warn('[gateway-shim] Failed to load config from R2:', err);
  }

  // NOTE: @cloudflare/sandbox startProcess env injection is unreliable; pass env via shell exports.
  const exports: string[] = [];
  const esc = (s: string) => s.replace(/'/g, `'"'"'`);

  exports.push(`export OPENCLAW_USER_ID='${esc(userId)}'`);
  if (injectedConfigB64) exports.push(`export OPENCLAW_CONFIG_B64='${esc(injectedConfigB64)}'`);
  if (env.CAPTAINAPP_USER_KEY) exports.push(`export CAPTAINAPP_USER_KEY='${esc(String(env.CAPTAINAPP_USER_KEY))}'`);

  // Derive per-user gateway token
  if (env.MOLTBOT_GATEWAY_MASTER_TOKEN) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(env.MOLTBOT_GATEWAY_MASTER_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`gateway-token:${userId}`));
    const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    exports.push(`export OPENCLAW_GATEWAY_TOKEN='${token}'`);
  }

  // Start via startup script (handles restore + config + gateway)
  const cmd = `sh -lc "${exports.join('; ')}; exec /usr/local/bin/start-moltbot.sh"`;
  await sandbox.startProcess(cmd);

  // Wait for gateway to be ready
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    if (await checkHealth(sandbox)) {
      console.log(`[gateway-shim] Gateway ready for ${userId.slice(0, 8)} in ${Date.now() - (deadline - 30000)}ms`);
      return;
    }
  }
  console.warn(`[gateway-shim] Gateway not healthy after 30s for ${userId.slice(0, 8)}`);
}

export async function checkHealth(sandbox: any): Promise<boolean> {
  try {
    const resp = await sandbox.containerFetch(new Request('http://localhost:18789/'), 18789);
    return resp.status > 0;
  } catch { return false; }
}

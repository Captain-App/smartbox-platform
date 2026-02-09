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

  // Generate presigned restore URL
  let restoreUrl: string | null = null;
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CF_ACCOUNT_ID) {
    try {
      restoreUrl = await presignR2Url({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        accountId: env.CF_ACCOUNT_ID,
        bucket: env.R2_BUCKET_NAME || 'moltbot-data',
        key: `users/${userId}/backup.tar.gz`,
        method: 'GET',
        expiresIn: 300,
      });
      console.log(`[gateway-shim] Presigned restore URL generated for ${userId.slice(0, 8)}...`);
    } catch (err) {
      console.warn('[gateway-shim] Presign failed:', err);
    }
  }

  // Build env vars
  const startEnv: Record<string, string> = { OPENCLAW_USER_ID: userId };
  if (restoreUrl) startEnv.RESTORE_URL = restoreUrl;
  
  // Derive per-user gateway token
  if (env.MOLTBOT_GATEWAY_MASTER_TOKEN) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(env.MOLTBOT_GATEWAY_MASTER_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`gateway-token:${userId}`));
    startEnv.OPENCLAW_GATEWAY_TOKEN = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Start via startup script (handles restore + config + gateway)
  await sandbox.startProcess('/usr/local/bin/start-moltbot.sh', { env: startEnv });

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

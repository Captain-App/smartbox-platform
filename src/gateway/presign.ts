/**
 * S3v4 Presigned URL generator for R2.
 *
 * Generates time-limited, object-scoped URLs that allow a container
 * to download/upload its own backup without having bucket-wide credentials.
 * 
 * Security: each URL is scoped to a single R2 key and expires quickly.
 * A container cannot construct a URL for another user's data.
 */

interface PresignOptions {
  /** R2/S3 access key ID */
  accessKeyId: string;
  /** R2/S3 secret access key */
  secretAccessKey: string;
  /** Cloudflare account ID (for R2 endpoint) */
  accountId: string;
  /** R2 bucket name */
  bucket: string;
  /** Object key (e.g., 'users/{userId}/backup.tar.gz') */
  key: string;
  /** HTTP method: GET for download, PUT for upload */
  method?: 'GET' | 'PUT';
  /** Expiry in seconds (default: 300 = 5 minutes) */
  expiresIn?: number;
  /** Region (default: 'auto' for R2) */
  region?: string;
}

/**
 * Generate an S3v4 presigned URL for R2.
 * 
 * Uses AWS Signature Version 4 (which R2 supports) to create a
 * time-limited URL scoped to a single object.
 */
export async function presignR2Url(opts: PresignOptions): Promise<string> {
  const {
    accessKeyId,
    secretAccessKey,
    accountId,
    bucket,
    key,
    method = 'GET',
    expiresIn = 300,
    region = 'auto',
  } = opts;

  const service = 's3';
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}`;
  
  const now = new Date();
  const dateStamp = formatDateStamp(now);   // YYYYMMDD
  const amzDate = formatAmzDate(now);       // YYYYMMDD'T'HHMMSS'Z'
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // Canonical URI — must be URL-encoded path
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  // Query parameters for presigned URL (sorted alphabetically)
  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };

  // Build canonical query string (sorted by key)
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  // Canonical headers
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  // For presigned URLs, payload is UNSIGNED-PAYLOAD
  const hashedPayload = 'UNSIGNED-PAYLOAD';

  // Build canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  // Signing key
  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);

  // Signature
  const signature = await hmacHex(signingKey, stringToSign);

  // Build final URL
  return `${endpoint}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Generate presigned GET URL for a user's backup.
 * Convenience wrapper that constructs the right key.
 */
export async function presignRestoreUrl(
  env: { R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string; CF_ACCOUNT_ID?: string; R2_BUCKET_NAME?: string },
  userId: string,
  expiresIn = 300,
): Promise<string | null> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.warn('[presign] Missing R2 credentials, cannot generate presigned URL');
    return null;
  }

  return presignR2Url({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    accountId: env.CF_ACCOUNT_ID,
    bucket: env.R2_BUCKET_NAME || 'moltbot-data',
    key: `users/${userId}/backup.tar.gz`,
    method: 'GET',
    expiresIn,
  });
}

/**
 * Generate presigned PUT URL for a user's backup.
 * Used by containers to upload their own backup directly.
 */
export async function presignBackupUrl(
  env: { R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string; CF_ACCOUNT_ID?: string; R2_BUCKET_NAME?: string },
  userId: string,
  expiresIn = 300,
): Promise<string | null> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.warn('[presign] Missing R2 credentials, cannot generate presigned URL');
    return null;
  }

  return presignR2Url({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    accountId: env.CF_ACCOUNT_ID,
    bucket: env.R2_BUCKET_NAME || 'moltbot-data',
    key: `users/${userId}/backup.tar.gz`,
    method: 'PUT',
    expiresIn,
  });
}

// ─── Crypto helpers ──────────────────────────────────────────

function formatDateStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').slice(0, 8);
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return arrayToHex(new Uint8Array(hash));
}

async function hmacSign(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const sig = await hmacSign(key, data);
  return arrayToHex(new Uint8Array(sig));
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSign(
    new TextEncoder().encode(`AWS4${secretKey}`).buffer,
    dateStamp,
  );
  const kRegion = await hmacSign(kDate, region);
  const kService = await hmacSign(kRegion, service);
  return hmacSign(kService, 'aws4_request');
}

function arrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

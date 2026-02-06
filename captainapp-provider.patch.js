#!/usr/bin/env node
/**
 * CaptainApp Provider Patch for OpenClaw
 * Adds support for captainapp/kimi-k2.5 model via proxy
 *
 * Handles two scenarios:
 * 1. Native captainapp support exists (v2026.2.4+): Injects process.env.CAPTAINAPP_API_KEY
 *    as a priority override into ALL files containing the native resolver (which can't find
 *    the env var without the envMap mapping).
 * 2. No native support: Adds full provider constants, builder function, and resolver.
 *
 * IMPORTANT: The bundler may duplicate the resolver into multiple chunks (e.g.
 * auth-profiles-*.js AND model-selection-*.js). We must patch ALL of them.
 */

const fs = require('fs');
const path = require('path');

const distDir = '/usr/local/lib/node_modules/openclaw/dist';

// Recursively collect all .js files in distDir (including subdirs like plugin-sdk/)
function collectJsFiles(dir) {
  let results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(collectJsFiles(full));
      } else if (entry.name.endsWith('.js')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

// Collect ALL files that need patching
let nativeFiles = [];     // Files with native captainapp support (need env override)
let legacyTarget = null;  // File with buildMoonshotProvider (for full patch if no native support)

try {
  const files = collectJsFiles(distDir);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');

    // Skip already-patched files
    if (content.includes('CAPTAINAPP_PATCH_APPLIED')) continue;

    // Check for native captainapp support
    if (content.includes('CAPTAINAPP_BASE_URL') || content.includes('buildCaptainAppProvider')) {
      nativeFiles.push(filePath);
    }

    // Find legacy target (for full patch fallback)
    if (!legacyTarget && content.includes('function buildMoonshotProvider') && content.includes('resolveImplicitProviders')) {
      legacyTarget = filePath;
    }
  }
} catch (err) {
  console.error('Could not search dist directory:', err.message);
  process.exit(1);
}

// Check if everything is already patched
if (nativeFiles.length === 0 && !legacyTarget) {
  // Check if any file has our marker (all patched already)
  try {
    const files = collectJsFiles(distDir);
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('CAPTAINAPP_PATCH_APPLIED')) {
        console.log('Already patched (marker found), skipping');
        process.exit(0);
      }
    }
  } catch {}
  console.error('Could not find any files to patch in', distDir);
  process.exit(1);
}

// === NATIVE SUPPORT: Patch all files with env key override ===
if (nativeFiles.length > 0) {
  console.log(`Native captainapp support detected in ${nativeFiles.length} file(s)`);

  let totalPatched = 0;

  for (const filePath of nativeFiles) {
    console.log(`Patching: ${path.basename(filePath)}`);
    let content = fs.readFileSync(filePath, 'utf8');
    let patched = false;

    // Pattern 1: const captainappKey = resolveEnvApiKeyVarName("captainapp")
    const p1 = /((?:const|let|var)\s+captainappKey\s*=\s*)(resolveEnvApiKeyVarName\s*\(\s*["']captainapp["']\s*\))/;
    if (p1.test(content)) {
      content = content.replace(p1, '$1process.env.CAPTAINAPP_API_KEY ?? $2');
      patched = true;
      console.log('  Applied: env override on resolveEnvApiKeyVarName');
    }

    // Pattern 2: buildCaptainAppProvider(someVar) — inject at call site
    if (!patched) {
      const p2 = /(buildCaptainAppProvider\s*\()(\w+)\)/;
      if (p2.test(content)) {
        content = content.replace(p2, '$1process.env.CAPTAINAPP_API_KEY ?? $2)');
        patched = true;
        console.log('  Applied: env override at buildCaptainAppProvider call');
      }
    }

    // Pattern 3: Minified — any assignment from resolveEnvApiKeyVarName("captainapp")
    if (!patched) {
      const p3 = /(=\s*)(resolveEnvApiKeyVarName\s*\(\s*["']captainapp["']\s*\))/;
      if (p3.test(content)) {
        content = content.replace(p3, '$1process.env.CAPTAINAPP_API_KEY ?? $2');
        patched = true;
        console.log('  Applied: env override (minified variant)');
      }
    }

    // Fix model ID: remove provider prefix from CAPTAINAPP_DEFAULT_MODEL_ID
    // The convention is model IDs don't include the provider prefix (e.g., "kimi-k2.5" not "captainapp/kimi-k2.5")
    // Without this fix, ModelRegistry.find("captainapp", "kimi-k2.5") won't match id "captainapp/kimi-k2.5"
    const modelIdRegex = /const CAPTAINAPP_DEFAULT_MODEL_ID\s*=\s*"captainapp\/kimi-k2\.5"/;
    if (modelIdRegex.test(content)) {
      content = content.replace(modelIdRegex, 'const CAPTAINAPP_DEFAULT_MODEL_ID = "kimi-k2.5"');
      patched = true;
      console.log('  Applied: model ID fix (removed provider prefix)');
    }

    if (patched) {
      // Add marker
      content = '// CAPTAINAPP_PATCH_APPLIED\n' + content;
      fs.writeFileSync(filePath, content);
      totalPatched++;
      console.log(`  ✓ Written`);
    } else {
      console.log('  ⚠ No patchable pattern found (may use different code path)');
    }
  }

  if (totalPatched > 0) {
    console.log(`Patch applied to ${totalPatched}/${nativeFiles.length} file(s)`);
    process.exit(0);
  } else {
    console.error('Failed to patch any files');
    process.exit(1);
  }
}

// === NO NATIVE SUPPORT: Apply full patch ===
if (!legacyTarget) {
  console.error('Could not find provider resolution file for full patch');
  process.exit(1);
}

console.log('No native captainapp support — applying full provider patch');
console.log('Patching:', legacyTarget);

let content = fs.readFileSync(legacyTarget, 'utf8');
let patchCount = 0;

// 1. Add CaptainApp constants before MOONSHOT_DEFAULT_COST
const constantsBlock = `
// CAPTAINAPP_PATCH_APPLIED
const CAPTAINAPP_BASE_URL = "https://captainapp-proxy.captainapp.workers.dev/v1";
const CAPTAINAPP_DEFAULT_MODEL_ID = "kimi-k2.5";
const CAPTAINAPP_DEFAULT_CONTEXT_WINDOW = 256000;
const CAPTAINAPP_DEFAULT_MAX_TOKENS = 8192;
const CAPTAINAPP_DEFAULT_COST = {
\tinput: 0.0000005,
\toutput: 0.000001,
\tcacheRead: 0,
\tcacheWrite: 0
};
`;

const costRegex = /const MOONSHOT_DEFAULT_COST\s*=\s*\{/;
if (costRegex.test(content)) {
  content = content.replace(costRegex, constantsBlock + 'const MOONSHOT_DEFAULT_COST = {');
  patchCount++;
  console.log('  [1/3] Added CaptainApp constants');
} else {
  console.error('  [1/3] FAILED: Could not find MOONSHOT_DEFAULT_COST');
}

// 2. Add buildCaptainAppProvider function after buildMoonshotProvider function
const funcRegex = /(function buildMoonshotProvider\(\)[^]*?\n\})/;
if (funcRegex.test(content)) {
  const captainappFunc = `
function buildCaptainAppProvider(apiKey) {
\tconst parts = apiKey.includes(":") ? apiKey.split(":", 2) : [undefined, apiKey];
\tconst userId = parts[0];
\tconst userKey = parts[1] || apiKey;
\treturn {
\t\tbaseUrl: CAPTAINAPP_BASE_URL,
\t\tapi: "openai-completions",
\t\tapiKey: userKey,
\t\theaders: userId ? {
\t\t\t"X-CaptainApp-User-ID": userId,
\t\t\t"X-CaptainApp-User-Key": userKey
\t\t} : undefined,
\t\tmodels: [{
\t\t\tid: CAPTAINAPP_DEFAULT_MODEL_ID,
\t\t\tname: "Kimi K2.5 (Metered)",
\t\t\treasoning: false,
\t\t\tinput: ["text"],
\t\t\tcost: CAPTAINAPP_DEFAULT_COST,
\t\t\tcontextWindow: CAPTAINAPP_DEFAULT_CONTEXT_WINDOW,
\t\t\tmaxTokens: CAPTAINAPP_DEFAULT_MAX_TOKENS
\t\t}]
\t};
}`;
  content = content.replace(funcRegex, '$1' + captainappFunc);
  patchCount++;
  console.log('  [2/3] Added buildCaptainAppProvider function');
} else {
  console.error('  [2/3] FAILED: Could not find buildMoonshotProvider function');
}

// 3. Add captainapp resolution after moonshot resolution
const resolveRegex = /(if\s*\(moonshotKey\)\s*providers\.moonshot\s*=\s*\{[^}]*\}[^;]*;?)/;
if (resolveRegex.test(content)) {
  const captainappResolve = `
\tconst captainappKey = process.env.CAPTAINAPP_API_KEY ?? resolveEnvApiKeyVarName("captainapp") ?? resolveApiKeyFromProfiles({
\t\tprovider: "captainapp",
\t\tstore: authStore
\t});
\tif (captainappKey) providers.captainapp = buildCaptainAppProvider(captainappKey);`;
  content = content.replace(resolveRegex, '$1' + captainappResolve);
  patchCount++;
  console.log('  [3/3] Added captainapp provider resolution');
} else {
  console.error('  [3/3] FAILED: Could not find moonshot resolve block');
}

if (patchCount === 3) {
  fs.writeFileSync(legacyTarget, content);
  console.log('Patch applied successfully! (' + patchCount + '/3 sections)');
} else {
  console.error('Patch incomplete (' + patchCount + '/3 sections). Not writing.');
  process.exit(1);
}

#!/usr/bin/env node
/**
 * CaptainApp Provider Patch for OpenClaw
 * Adds support for captainapp/kimi-k2.5 model via proxy
 */

const fs = require('fs');
const path = require('path');

// Find the models-config.providers.js file
const possiblePaths = [
  '/usr/local/lib/node_modules/openclaw/dist/models-config.providers.js',
  '/usr/local/lib/node_modules/openclaw/dist/agents/models-config.providers.js',
  '/usr/lib/node_modules/openclaw/dist/models-config.providers.js',
];

let targetFile = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    targetFile = p;
    break;
  }
}

if (!targetFile) {
  console.error('Could not find models-config.providers.js');
  process.exit(1);
}

console.log('Patching:', targetFile);

let content = fs.readFileSync(targetFile, 'utf8');

// Check if already patched
if (content.includes('CAPTAINAPP_BASE_URL')) {
  console.log('Already patched, skipping');
  process.exit(0);
}

// Add CaptainApp constants after Moonshot constants
const moonshotConst = `const MOONSHOT_DEFAULT_COST = {`;
const captainappInsert = `
const CAPTAINAPP_BASE_URL = "https://captainapp-proxy.captainapp.workers.dev/v1";
const CAPTAINAPP_DEFAULT_MODEL_ID = "captainapp/kimi-k2.5";
const CAPTAINAPP_DEFAULT_CONTEXT_WINDOW = 256000;
const CAPTAINAPP_DEFAULT_MAX_TOKENS = 8192;
const CAPTAINAPP_DEFAULT_COST = {
  input: 0.0000005,
  output: 0.000001,
  cacheRead: 0,
  cacheWrite: 0,
};
`;

content = content.replace(moonshotConst, captainappInsert + moonshotConst);

// Add buildCaptainAppProvider function after buildMoonshotProvider
const moonshotFunc = `function buildMoonshotProvider(): ProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: MOONSHOT_DEFAULT_MODEL_ID,
        name: "Kimi K2.5",
        reasoning: false,
        input: ["text"],
        cost: MOONSHOT_DEFAULT_COST,
        contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}`;

const captainappFunc = `
function buildCaptainAppProvider(apiKey: string): ProviderConfig {
  // apiKey format: "userId:userApiKey"
  const [userId, userKey] = apiKey.includes(":")
    ? apiKey.split(":", 2)
    : [undefined, apiKey];

  return {
    baseUrl: CAPTAINAPP_BASE_URL,
    api: "openai-completions",
    apiKey: userKey || apiKey,
    headers: userId
      ? {
          "X-CaptainApp-User-ID": userId,
          "X-CaptainApp-User-Key": userKey || apiKey,
        }
      : undefined,
    models: [
      {
        id: CAPTAINAPP_DEFAULT_MODEL_ID,
        name: "Kimi K2.5 (Metered)",
        reasoning: false,
        input: ["text"],
        cost: CAPTAINAPP_DEFAULT_COST,
        contextWindow: CAPTAINAPP_DEFAULT_CONTEXT_WINDOW,
        maxTokens: CAPTAINAPP_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
`;

content = content.replace(moonshotFunc, moonshotFunc + captainappFunc);

// Add captainapp to resolveImplicitProviders
const moonshotResolve = `  const moonshotKey =
    resolveEnvApiKeyVarName("moonshot") ??
    resolveApiKeyFromProfiles({ provider: "moonshot", store: authStore });
  if (moonshotKey) {
    providers.moonshot = { ...buildMoonshotProvider(), apiKey: moonshotKey };
  }`;

const captainappResolve = `
  const captainappKey =
    resolveEnvApiKeyVarName("captainapp") ??
    resolveApiKeyFromProfiles({ provider: "captainapp", store: authStore });
  if (captainappKey) {
    providers.captainapp = buildCaptainAppProvider(captainappKey);
  }`;

content = content.replace(moonshotResolve, moonshotResolve + captainappResolve);

// Write back
fs.writeFileSync(targetFile, content);
console.log('Patch applied successfully!');
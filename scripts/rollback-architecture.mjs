#!/usr/bin/env node
/**
 * Rollback to legacy architecture
 * 
 * This script safely rolls back to the legacy single-worker architecture
 * by disabling the new feature flags.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('🔄 Rolling back to legacy architecture...\n');

// =============================================================================
// Step 1: Validate current state
// =============================================================================
console.log('Step 1: Validating current state...');

try {
  const routerConfig = JSON.parse(readFileSync(join(rootDir, 'workers/router/wrangler.jsonc'), 'utf8'));
  const currentAdminApiFlag = routerConfig.vars?.USE_NEW_ADMIN_API;
  const currentGatewayFlag = routerConfig.vars?.USE_NEW_CONTAINER_GATEWAY;
  
  console.log(`  Current USE_NEW_ADMIN_API: ${currentAdminApiFlag}`);
  console.log(`  Current USE_NEW_CONTAINER_GATEWAY: ${currentGatewayFlag}`);
  
  if (currentAdminApiFlag === 'false' && currentGatewayFlag === 'false') {
    console.log('\n⚠️  Already using legacy architecture!');
    process.exit(0);
  }
} catch (error) {
  console.error('  ❌ Failed to read router config:', error.message);
  process.exit(1);
}

// =============================================================================
// Step 2: Disable feature flags
// =============================================================================
console.log('\nStep 2: Disabling new feature flags...');

try {
  const routerConfigPath = join(rootDir, 'workers/router/wrangler.jsonc');
  const routerConfig = JSON.parse(readFileSync(routerConfigPath, 'utf8'));
  
  routerConfig.vars = routerConfig.vars || {};
  routerConfig.vars.USE_NEW_ADMIN_API = 'false';
  routerConfig.vars.USE_NEW_CONTAINER_GATEWAY = 'false';
  
  writeFileSync(routerConfigPath, JSON.stringify(routerConfig, null, 2));
  console.log('  ✅ Feature flags disabled');
} catch (error) {
  console.error('  ❌ Failed to update feature flags:', error.message);
  process.exit(1);
}

// =============================================================================
// Step 3: Deploy updated router
// =============================================================================
console.log('\nStep 3: Deploying updated Router...');

try {
  execSync('cd workers/router && wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('  ✅ Router updated with legacy routing');
} catch (error) {
  console.error('  ❌ Failed to deploy router');
  process.exit(1);
}

// =============================================================================
// Step 4: Validation
// =============================================================================
console.log('\nStep 4: Running validation tests...');

async function runValidation() {
  try {
    // Test main endpoint
    const response = await fetch('https://claw.captainapp.co.uk/health');
    console.log(`  Health check: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
    
    return response.status === 200;
  } catch (error) {
    console.error('  ❌ Validation failed:', error.message);
    return false;
  }
}

const validationPassed = await runValidation();

// =============================================================================
// Summary
// =============================================================================
console.log('\n' + '='.repeat(60));
if (validationPassed) {
  console.log('✅ Rollback completed successfully!');
  console.log('');
  console.log('The system is now using the legacy single-worker architecture.');
  console.log('');
  console.log('To re-enable the new architecture:');
  console.log('  node scripts/enable-new-architecture.mjs');
} else {
  console.log('⚠️  Rollback deployed but validation failed');
  console.log('   Check logs immediately');
}
console.log('='.repeat(60));

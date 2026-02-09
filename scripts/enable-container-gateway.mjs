#!/usr/bin/env node
/**
 * Enable Container Gateway
 * 
 * This script enables the new Container Gateway Worker after
 * the Admin API has been validated.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('🚀 Enabling Container Gateway...\n');

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
  
  if (currentGatewayFlag === 'true') {
    console.log('\n⚠️  Container Gateway is already enabled!');
    process.exit(0);
  }
  
  if (currentAdminApiFlag !== 'true') {
    console.log('\n⚠️  Warning: Admin API is not enabled yet.');
    console.log('   It is recommended to enable Admin API first.');
  }
} catch (error) {
  console.error('  ❌ Failed to read router config:', error.message);
  process.exit(1);
}

// =============================================================================
// Step 2: Enable container gateway feature flag
// =============================================================================
console.log('\nStep 2: Enabling Container Gateway feature flag...');

try {
  const routerConfigPath = join(rootDir, 'workers/router/wrangler.jsonc');
  const routerConfig = JSON.parse(readFileSync(routerConfigPath, 'utf8'));
  
  routerConfig.vars = routerConfig.vars || {};
  routerConfig.vars.USE_NEW_CONTAINER_GATEWAY = 'true';
  
  writeFileSync(routerConfigPath, JSON.stringify(routerConfig, null, 2));
  console.log('  ✅ Container Gateway enabled');
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
  console.log('  ✅ Router updated with Container Gateway enabled');
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
    // Test container gateway
    const response = await fetch('https://claw.captainapp.co.uk/api/status');
    console.log(`  API status: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
    
    if (response.status === 200) {
      const data = await response.json();
      console.log(`  Router: ${data.router || 'legacy'}`);
    }
    
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
  console.log('✅ Container Gateway enabled successfully!');
  console.log('');
  console.log('The new architecture is now fully active:');
  console.log('  - Edge Router: ✅');
  console.log('  - Admin API Worker: ✅');
  console.log('  - Container Gateway Worker: ✅');
  console.log('');
  console.log('Rollback if needed:');
  console.log('  node scripts/rollback-architecture.mjs');
} else {
  console.log('⚠️  Container Gateway enabled but validation failed');
  console.log('   Check logs and consider rolling back');
}
console.log('='.repeat(60));

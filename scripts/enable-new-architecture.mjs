#!/usr/bin/env node
/**
 * Enable the new architecture
 * 
 * This script safely enables the new workers by:
 * 1. Deploying all new workers
 * 2. Setting feature flags to enable new routing
 * 3. Running validation tests
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('🚀 Enabling new moltworker architecture...\n');

// =============================================================================
// Step 1: Validate current state
// =============================================================================
console.log('Step 1: Validating current state...');

try {
  // Check if workers are already deployed
  const routerConfig = JSON.parse(readFileSync(join(rootDir, 'workers/router/wrangler.jsonc'), 'utf8'));
  const currentAdminApiFlag = routerConfig.vars?.USE_NEW_ADMIN_API;
  const currentGatewayFlag = routerConfig.vars?.USE_NEW_CONTAINER_GATEWAY;
  
  console.log(`  Current USE_NEW_ADMIN_API: ${currentAdminApiFlag}`);
  console.log(`  Current USE_NEW_CONTAINER_GATEWAY: ${currentGatewayFlag}`);
  
  if (currentAdminApiFlag === 'true' && currentGatewayFlag === 'true') {
    console.log('\n⚠️  New architecture is already enabled!');
    process.exit(0);
  }
} catch (error) {
  console.error('  ❌ Failed to read router config:', error.message);
  process.exit(1);
}

// =============================================================================
// Step 2: Deploy Admin API Worker
// =============================================================================
console.log('\nStep 2: Deploying Admin API Worker...');

try {
  execSync('cd workers/admin-api && wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('  ✅ Admin API Worker deployed');
} catch (error) {
  console.error('  ❌ Failed to deploy Admin API Worker');
  process.exit(1);
}

// =============================================================================
// Step 3: Deploy Container Gateway Worker
// =============================================================================
console.log('\nStep 3: Deploying Container Gateway Worker...');

try {
  execSync('cd workers/container-gateway && wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('  ✅ Container Gateway Worker deployed');
} catch (error) {
  console.error('  ❌ Failed to deploy Container Gateway Worker');
  process.exit(1);
}

// =============================================================================
// Step 4: Deploy Router Worker
// =============================================================================
console.log('\nStep 4: Deploying Edge Router Worker...');

try {
  execSync('cd workers/router && wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('  ✅ Edge Router Worker deployed');
} catch (error) {
  console.error('  ❌ Failed to deploy Edge Router Worker');
  process.exit(1);
}

// =============================================================================
// Step 5: Update feature flags
// =============================================================================
console.log('\nStep 5: Updating feature flags...');

try {
  const routerConfigPath = join(rootDir, 'workers/router/wrangler.jsonc');
  const routerConfig = JSON.parse(readFileSync(routerConfigPath, 'utf8'));
  
  // Enable feature flags gradually
  routerConfig.vars = routerConfig.vars || {};
  routerConfig.vars.USE_NEW_ADMIN_API = 'true';
  // Keep container gateway disabled initially - enable after admin API validation
  routerConfig.vars.USE_NEW_CONTAINER_GATEWAY = 'false';
  
  writeFileSync(routerConfigPath, JSON.stringify(routerConfig, null, 2));
  console.log('  ✅ Feature flags updated');
  console.log('     USE_NEW_ADMIN_API: true');
  console.log('     USE_NEW_CONTAINER_GATEWAY: false (enable after validation)');
} catch (error) {
  console.error('  ❌ Failed to update feature flags:', error.message);
  process.exit(1);
}

// =============================================================================
// Step 6: Deploy updated router
// =============================================================================
console.log('\nStep 6: Deploying updated Router...');

try {
  execSync('cd workers/router && wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('  ✅ Router updated with new feature flags');
} catch (error) {
  console.error('  ❌ Failed to deploy updated router');
  process.exit(1);
}

// =============================================================================
// Step 7: Validation
// =============================================================================
console.log('\nStep 7: Running validation tests...');

async function runValidation() {
  try {
    // Test health endpoints
    const routerHealth = await fetch('https://claw.captainapp.co.uk/health');
    console.log(`  Router health: ${routerHealth.status === 200 ? '✅' : '❌'} (${routerHealth.status})`);
    
    // Test admin API
    const adminSecret = process.env.ADMIN_SECRET || '';
    const adminHealth = await fetch('https://claw.captainapp.co.uk/api/super/users', {
      headers: { 'X-Admin-Secret': adminSecret },
    });
    console.log(`  Admin API: ${adminHealth.status === 200 ? '✅' : '❌'} (${adminHealth.status})`);
    
    return routerHealth.status === 200 && adminHealth.status === 200;
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
  console.log('✅ New architecture enabled successfully!');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Monitor logs for any issues');
  console.log('  2. Test admin endpoints: /api/super/state/dashboard');
  console.log('  3. When ready, enable container gateway:');
  console.log('     node scripts/enable-container-gateway.mjs');
  console.log('');
  console.log('Rollback if needed:');
  console.log('  node scripts/rollback-architecture.mjs');
} else {
  console.log('⚠️  Architecture deployed but validation failed');
  console.log('   Check logs and run validation manually');
}
console.log('='.repeat(60));

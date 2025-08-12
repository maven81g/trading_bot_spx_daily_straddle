#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Setting up Trading Bot...\n');

// Create necessary directories
const directories = [
  'logs',
  'data',
  'backtest_results',
  'config/local'
];

console.log('📁 Creating directories...');
directories.forEach(dir => {
  const fullPath = path.join(process.cwd(), dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`   ✓ Created ${dir}`);
  } else {
    console.log(`   ⚠ ${dir} already exists`);
  }
});

// Copy .env.example to .env if it doesn't exist
console.log('\n🔧 Setting up environment...');
const envPath = path.join(process.cwd(), '.env');
const envExamplePath = path.join(process.cwd(), '.env.example');

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  fs.copyFileSync(envExamplePath, envPath);
  console.log('   ✓ Created .env from .env.example');
  console.log('   ⚠ Please update .env with your TradeStation API credentials');
} else if (fs.existsSync(envPath)) {
  console.log('   ⚠ .env already exists');
} else {
  console.log('   ✗ .env.example not found');
}

// Install dependencies if needed
console.log('\n📦 Checking dependencies...');
const packageJsonPath = path.join(process.cwd(), 'package.json');
const nodeModulesPath = path.join(process.cwd(), 'node_modules');

if (fs.existsSync(packageJsonPath) && !fs.existsSync(nodeModulesPath)) {
  console.log('   Installing dependencies...');
  try {
    execSync('npm install', { stdio: 'inherit' });
    console.log('   ✓ Dependencies installed');
  } catch (error) {
    console.log('   ✗ Failed to install dependencies');
    console.log('   Run "npm install" manually');
  }
} else {
  console.log('   ✓ Dependencies already installed');
}

// Build the project
console.log('\n🔨 Building project...');
try {
  execSync('npm run build', { stdio: 'inherit' });
  console.log('   ✓ Project built successfully');
} catch (error) {
  console.log('   ⚠ Build failed - you may need to fix TypeScript errors');
}

console.log('\n✅ Setup complete!\n');
console.log('Next steps:');
console.log('1. Update .env with your TradeStation API credentials');
console.log('2. Review config/strategies.json for your trading strategies');
console.log('3. Run "npm run dev" to start in development mode');
console.log('4. Run "npm start" to start in production mode');
console.log('\nFor more information, check the README.md file.');
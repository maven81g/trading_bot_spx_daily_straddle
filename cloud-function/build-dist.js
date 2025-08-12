#!/usr/bin/env node

/**
 * Build script - Copy only essential files for Cloud Function deployment
 */

const fs = require('fs');
const path = require('path');

console.log('🏗️  Building Cloud Function distribution...');

const distDir = 'dist';
const sourceFiles = [
    'main.js',
    'spx-daily-reporter.js', 
    'bigquery-client.js',
    'email-client.js',
    'package.json'
];

// Clean dist directory
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
    console.log('🧹 Cleaned existing dist directory');
}

// Create dist directory
fs.mkdirSync(distDir, { recursive: true });
console.log('📁 Created dist directory');

// Copy essential files
sourceFiles.forEach(file => {
    if (fs.existsSync(file)) {
        if (file === 'package.json') {
            // Clean package.json for deployment
            const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
            // Keep only essential scripts
            pkg.scripts = {
                "start": "functions-framework --target=main"
            };
            fs.writeFileSync(path.join(distDir, file), JSON.stringify(pkg, null, 2));
            console.log(`✅ Copied and cleaned ${file}`);
        } else {
            fs.copyFileSync(file, path.join(distDir, file));
            console.log(`✅ Copied ${file}`);
        }
    } else {
        console.log(`⚠️  Skipped ${file} (not found)`);
    }
});

// Create simplified README for dist
const distReadme = `# SPX Daily Trader - Cloud Function

## Deployment Files

This directory contains only the essential files needed for Cloud Function deployment:

- \`main.js\` - Cloud Function entry point
- \`spx-daily-reporter.js\` - Core trading logic 
- \`bigquery-client.js\` - Database storage
- \`email-client.js\` - Email notifications
- \`package.json\` - Dependencies

## Deploy

From this directory:

\`\`\`bash
# Set environment variables
export GOOGLE_CLOUD_PROJECT=galvanic-ripsaw-381707
export ts_client_id=your_client_id
export ts_client_secret=your_client_secret  
export ts_refresh_token=your_refresh_token
export mailgun_api_key=your_mailgun_key

# Deploy
gcloud functions deploy spx-daily-trader \\
    --runtime nodejs18 \\
    --trigger-http \\
    --entry-point main \\
    --memory 512MB \\
    --timeout 540s \\
    --region us-central1 \\
    --set-env-vars "GOOGLE_CLOUD_PROJECT=galvanic-ripsaw-381707,BIGQUERY_DATASET=spx_trading,ts_client_id=$ts_client_id,ts_client_secret=$ts_client_secret,ts_refresh_token=$ts_refresh_token,mailgun_api_key=$mailgun_api_key,CLOUD_FUNCTION_VERSION=1.0.0" \\
    --allow-unauthenticated
\`\`\`

## Schedule

\`\`\`bash
gcloud scheduler jobs create http spx-daily-trading \\
    --schedule="30 21 * * 1-5" \\
    --uri="https://us-central1-galvanic-ripsaw-381707.cloudfunctions.net/spx-daily-trader" \\
    --http-method=POST \\
    --time-zone="America/New_York"
\`\`\`
`;

fs.writeFileSync(path.join(distDir, 'README.md'), distReadme);
console.log('✅ Created deployment README');

console.log('\n🎉 Distribution build complete!');
console.log(`📦 Files in ${distDir}:`);
fs.readdirSync(distDir).forEach(file => {
    const stats = fs.statSync(path.join(distDir, file));
    const size = (stats.size / 1024).toFixed(1);
    console.log(`   ${file} (${size} KB)`);
});

console.log('\n💡 Next steps:');
console.log(`1. cd ${distDir}`);
console.log('2. Set your environment variables');
console.log('3. Run the gcloud deploy command from the README');
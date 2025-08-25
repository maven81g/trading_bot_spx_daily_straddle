#!/usr/bin/env node

import 'dotenv/config';
import fetch from 'node-fetch';
import FormData from 'form-data';

async function testDirectMailgun() {
  console.log('📧 Testing Direct Mailgun API Call...\n');

  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM;
  const to = process.env.MAILGUN_TO;

  console.log('Configuration:');
  console.log(`  API Key: ${apiKey ? apiKey.substring(0, 12) + '...' : 'NOT SET'}`);
  console.log(`  Domain: ${domain}`);
  console.log(`  From: ${from}`);
  console.log(`  To: ${to}\n`);

  if (!apiKey || !domain || !from || !to) {
    console.error('❌ Missing Mailgun configuration');
    return;
  }

  try {
    // Create form data exactly like the working cloud function
    const form = new FormData();
    form.append('from', from);
    form.append('to', to);
    form.append('subject', 'SPX Bot Direct Test - URGENT');
    form.append('text', 'This is a DIRECT test from your SPX Bot. If you receive this, Mailgun is working!');
    form.append('html', `
      <h2>🚨 SPX Bot Direct Test</h2>
      <p>This is a DIRECT API test from your SPX Straddle Bot.</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
      <p><strong>Status:</strong> If you receive this email, Mailgun is working correctly!</p>
      <p><strong>Domain:</strong> ${domain}</p>
      <p><strong>API Key:</strong> ${apiKey.substring(0, 12)}...</p>
    `);

    console.log('📤 Making direct Mailgun API call...');
    console.log(`URL: https://api.mailgun.net/v3/${domain}/messages`);
    
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`
      },
      body: form
    });

    const responseText = await response.text();
    
    console.log(`Response Status: ${response.status}`);
    console.log(`Response Headers:`, Object.fromEntries(response.headers));
    console.log(`Response Body: ${responseText}\n`);
    
    if (response.ok) {
      console.log('✅ Direct API call successful!');
      console.log('📧 Check ulises81g@gmail.com (including spam folder)');
      
      const result = JSON.parse(responseText);
      console.log(`📨 Message ID: ${result.id}`);
      console.log(`📨 Message: ${result.message}`);
    } else {
      console.error(`❌ Mailgun API failed (${response.status})`);
      console.error(`Response: ${responseText}`);
      
      if (response.status === 400) {
        console.error('\n💡 This might be because:');
        console.error('   - ulises81g@gmail.com is not added as authorized recipient');
        console.error('   - Go to Mailgun dashboard > Authorized Recipients');
        console.error('   - Add ulises81g@gmail.com and verify it');
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testDirectMailgun().catch(console.error);
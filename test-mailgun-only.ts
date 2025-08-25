#!/usr/bin/env node

import 'dotenv/config';
import { SimpleMailgunService, NotificationLevel } from './src/utils/simple-mailgun-service';
import { createLogger } from './src/utils/logger';

const logger = createLogger('MailgunTest', { level: 'info' });

async function testMailgunOnly() {
  console.log('📧 Testing Simple Mailgun Service...\n');

  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM;
  const to = process.env.MAILGUN_TO;

  console.log('Configuration:');
  console.log(`  API Key: ${apiKey ? apiKey.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`  Domain: ${domain || 'NOT SET'}`);
  console.log(`  From: ${from || 'NOT SET'}`);
  console.log(`  To: ${to || 'NOT SET'}\n`);

  if (!apiKey || !domain || !from || !to) {
    console.error('❌ Missing Mailgun configuration in .env file');
    console.error('💡 Make sure to set MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, and MAILGUN_TO');
    return;
  }

  // Initialize the service (mimicking the working cloud function approach)
  const mailgunConfig = {
    enabled: true,
    apiKey,
    domain,
    from,
    to: to.split(',')
  };

  const notificationService = new SimpleMailgunService(mailgunConfig, logger);

  try {
    console.log('📤 Sending test notification...');
    
    await notificationService.send({
      level: NotificationLevel.INFO,
      title: 'Mailgun Test',
      message: 'This is a test email from your SPX Straddle Bot using the simplified Mailgun service. If you receive this, email notifications are working correctly!',
      details: {
        testType: 'Simple Mailgun Service Test',
        timestamp: new Date().toISOString(),
        apiKey: apiKey.substring(0, 8) + '...',
        domain: domain
      }
    });

    console.log('✅ Test email sent successfully!');
    console.log('📧 Check ulises81g@gmail.com for the test email');

  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('💡 Verify your Mailgun API key and domain are correct');
  }
}

testMailgunOnly().catch(console.error);
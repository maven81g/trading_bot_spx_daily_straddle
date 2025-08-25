#!/usr/bin/env node

import 'dotenv/config';
import { NotificationService, NotificationLevel } from './src/utils/mailgun-notification-service';
import { createLogger } from './src/utils/logger';

const logger = createLogger('NotificationTest', { level: 'info' });

async function testNotifications() {
  console.log('🔔 Testing Notification Services...\n');

  // Initialize notification service
  const notificationConfig = {
    discord: {
      enabled: !!process.env.DISCORD_WEBHOOK_URL,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
      mentionUserId: process.env.DISCORD_USER_ID
    },
    mailgun: process.env.MAILGUN_API_KEY ? {
      enabled: true,
      apiKey: process.env.MAILGUN_API_KEY,
      domain: process.env.MAILGUN_DOMAIN || '',
      from: process.env.MAILGUN_FROM || 'noreply@yourdomain.com',
      to: process.env.MAILGUN_TO?.split(',') || []
    } : undefined,
    windows: {
      enabled: true,
      playSound: true
    },
    pushover: process.env.PUSHOVER_USER_KEY ? {
      enabled: true,
      userKey: process.env.PUSHOVER_USER_KEY,
      apiToken: process.env.PUSHOVER_API_TOKEN || ''
    } : undefined
  };

  const notificationService = new NotificationService(notificationConfig, logger);

  console.log('📊 Notification Channels:');
  console.log(`   Discord: ${notificationConfig.discord?.enabled ? '✅' : '❌'}`);
  console.log(`   Mailgun: ${notificationConfig.mailgun?.enabled ? '✅' : '❌'}`);
  console.log(`   Windows: ${notificationConfig.windows?.enabled ? '✅' : '❌'}`);
  console.log(`   Pushover: ${notificationConfig.pushover?.enabled ? '✅' : '❌'}`);
  console.log('');

  try {
    // Test 1: Basic notification
    console.log('📤 Sending test notification...');
    await notificationService.send({
      level: NotificationLevel.INFO,
      title: 'Notification Test',
      message: 'This is a test notification from the SPX Straddle Bot',
      details: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        test: true
      }
    });
    console.log('✅ Test notification sent\n');

    // Test 2: Trade opened notification
    console.log('📈 Sending trade opened notification...');
    await notificationService.sendTradeOpened({
      strike: 5500,
      spxPrice: 5498.25,
      totalEntryPrice: 45.50,
      callEntryPrice: 25.75,
      putEntryPrice: 19.75,
      quantity: 1,
      targetPrice: 54.60,
      stopPrice: 22.75,
      entryTime: new Date()
    });
    console.log('✅ Trade opened notification sent\n');

    // Test 3: Trade closed notification
    console.log('📉 Sending trade closed notification...');
    await notificationService.sendTradeClosed({
      strike: 5500,
      totalEntryPrice: 45.50,
      totalExitPrice: 52.25,
      pnl: 675,
      quantity: 1,
      exitReason: 'TARGET',
      entryTime: new Date(Date.now() - 1800000), // 30 minutes ago
      exitTime: new Date()
    });
    console.log('✅ Trade closed notification sent\n');

    // Test 4: Critical alert
    console.log('🚨 Sending critical alert...');
    await notificationService.sendCriticalAlert(
      'Test Critical Alert',
      'This is a test critical alert to verify high-priority notifications work correctly'
    );
    console.log('✅ Critical alert sent\n');

    // Test 5: Daily summary
    console.log('📊 Sending daily summary...');
    await notificationService.sendDailySummary({
      dailyPnL: 1250,
      totalTrades: 3,
      winRate: 66.7,
      uptime: '8h 45m'
    });
    console.log('✅ Daily summary sent\n');

    console.log('🎉 All notification tests completed successfully!');
    console.log('📧 Check your email, Discord, mobile, and Windows notifications');

  } catch (error) {
    console.error('❌ Notification test failed:', error);
  }
}

if (require.main === module) {
  testNotifications().catch(console.error);
}
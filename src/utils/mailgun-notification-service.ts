import { EventEmitter } from 'events';
import { Logger } from 'winston';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';
import FormData from 'form-data';

const execAsync = promisify(exec);

export interface NotificationConfig {
  discord?: {
    enabled: boolean;
    webhookUrl: string;
    mentionUserId?: string; // For critical alerts
  };
  mailgun?: {
    enabled: boolean;
    apiKey: string;
    domain: string;
    from: string;
    to: string[];
  };
  windows?: {
    enabled: boolean;
    playSound?: boolean;
  };
  pushover?: {
    enabled: boolean;
    userKey: string;
    apiToken: string;
  };
}

export enum NotificationLevel {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
  SUCCESS = 'success'
}

export interface NotificationMessage {
  level: NotificationLevel;
  title: string;
  message: string;
  details?: any;
  timestamp?: Date;
}

export class NotificationService extends EventEmitter {
  private config: NotificationConfig;
  private logger: Logger;

  constructor(config: NotificationConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  public async send(notification: NotificationMessage): Promise<void> {
    notification.timestamp = notification.timestamp || new Date();

    const promises: Promise<void>[] = [];

    // Send to all configured channels
    if (this.config.discord?.enabled) {
      promises.push(this.sendDiscord(notification));
    }

    if (this.config.mailgun?.enabled) {
      promises.push(this.sendMailgun(notification));
    }

    if (this.config.windows?.enabled) {
      promises.push(this.sendWindowsNotification(notification));
    }

    if (this.config.pushover?.enabled) {
      promises.push(this.sendPushover(notification));
    }

    // Execute all notifications in parallel
    const results = await Promise.allSettled(promises);
    
    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(`Notification failed:`, result.reason);
      }
    });

    this.emit('notificationSent', notification);
  }

  private async sendDiscord(notification: NotificationMessage): Promise<void> {
    if (!this.config.discord?.webhookUrl) return;

    try {
      const color = this.getDiscordColor(notification.level);
      const emoji = this.getEmoji(notification.level);

      const embed = {
        title: `${emoji} ${notification.title}`,
        description: notification.message,
        color,
        timestamp: notification.timestamp?.toISOString(),
        fields: notification.details ? [
          {
            name: 'Details',
            value: typeof notification.details === 'object' 
              ? '```json\n' + JSON.stringify(notification.details, null, 2) + '\n```'
              : String(notification.details)
          }
        ] : []
      };

      const content = notification.level === NotificationLevel.CRITICAL && this.config.discord.mentionUserId
        ? `<@${this.config.discord.mentionUserId}>`
        : undefined;

      const response = await fetch(this.config.discord.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          embeds: [embed]
        })
      });

      if (!response.ok) {
        throw new Error(`Discord webhook failed: ${response.status}`);
      }
    } catch (error) {
      this.logger.error('Failed to send Discord notification:', error);
      throw error;
    }
  }

  private async sendMailgun(notification: NotificationMessage): Promise<void> {
    if (!this.config.mailgun) return;

    try {
      const { apiKey, domain, from, to } = this.config.mailgun;
      const subject = `[${notification.level.toUpperCase()}] SPX Straddle Bot - ${notification.title}`;
      
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .header { background: ${this.getEmailHeaderColor(notification.level)}; color: white; padding: 20px; text-align: center; }
            .content { padding: 20px; }
            .details { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 10px 0; }
            .footer { text-align: center; color: #666; font-size: 12px; padding: 10px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${this.getEmoji(notification.level)} ${notification.title}</h1>
          </div>
          <div class="content">
            <p><strong>Message:</strong> ${notification.message}</p>
            ${notification.details ? `
              <div class="details">
                <h3>Details:</h3>
                <pre>${JSON.stringify(notification.details, null, 2)}</pre>
              </div>
            ` : ''}
          </div>
          <div class="footer">
            <p>Sent at ${notification.timestamp?.toLocaleString()}</p>
            <p>SPX Straddle Trading Bot</p>
          </div>
        </body>
        </html>
      `;

      const form = new FormData();
      form.append('from', from);
      form.append('to', to.join(','));
      form.append('subject', subject);
      form.append('html', html);

      const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`
        },
        body: form
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mailgun API failed (${response.status}): ${errorText}`);
      }

      this.logger.debug('Email sent successfully via Mailgun');
    } catch (error) {
      this.logger.error('Failed to send Mailgun email:', error);
      throw error;
    }
  }

  private async sendWindowsNotification(notification: NotificationMessage): Promise<void> {
    if (!this.config.windows?.enabled) return;

    try {
      // Simple fallback notification using msg command
      const title = notification.title.replace(/[<>"|&]/g, '');
      const message = notification.message.replace(/[<>"|&]/g, '');
      
      // Use simple msg command for Windows notifications
      await execAsync(`msg * "[${title}] ${message}"`).catch(() => {
        // If msg fails, try echo to console (for debugging)
        console.log(`📢 Windows Notification: [${title}] ${message}`);
      });
      
    } catch (error) {
      this.logger.debug('Windows notification not available, using console output');
      console.log(`📢 Notification: [${notification.title}] ${notification.message}`);
    }
  }

  private async sendPushover(notification: NotificationMessage): Promise<void> {
    if (!this.config.pushover?.enabled) return;

    try {
      const priority = notification.level === NotificationLevel.CRITICAL ? 1 : 0;
      
      const response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: this.config.pushover.apiToken,
          user: this.config.pushover.userKey,
          title: notification.title,
          message: notification.message,
          priority,
          timestamp: Math.floor(notification.timestamp!.getTime() / 1000)
        })
      });

      if (!response.ok) {
        throw new Error(`Pushover API failed: ${response.status}`);
      }
    } catch (error) {
      this.logger.error('Failed to send Pushover notification:', error);
      throw error;
    }
  }

  private getDiscordColor(level: NotificationLevel): number {
    switch (level) {
      case NotificationLevel.INFO: return 0x3498db; // Blue
      case NotificationLevel.WARNING: return 0xf39c12; // Orange
      case NotificationLevel.CRITICAL: return 0xe74c3c; // Red
      case NotificationLevel.SUCCESS: return 0x2ecc71; // Green
      default: return 0x95a5a6; // Gray
    }
  }

  private getEmailHeaderColor(level: NotificationLevel): string {
    switch (level) {
      case NotificationLevel.INFO: return '#3498db'; // Blue
      case NotificationLevel.WARNING: return '#f39c12'; // Orange
      case NotificationLevel.CRITICAL: return '#e74c3c'; // Red
      case NotificationLevel.SUCCESS: return '#2ecc71'; // Green
      default: return '#95a5a6'; // Gray
    }
  }

  private getEmoji(level: NotificationLevel): string {
    switch (level) {
      case NotificationLevel.INFO: return 'ℹ️';
      case NotificationLevel.WARNING: return '⚠️';
      case NotificationLevel.CRITICAL: return '🚨';
      case NotificationLevel.SUCCESS: return '✅';
      default: return '📢';
    }
  }

  // Predefined notification templates
  public async sendTradeOpened(position: any): Promise<void> {
    await this.send({
      level: NotificationLevel.INFO,
      title: 'Straddle Position Opened',
      message: `Entered ${position.strike} straddle at $${position.totalEntryPrice.toFixed(2)}`,
      details: {
        strike: position.strike,
        spxPrice: position.spxPrice,
        callPrice: position.callEntryPrice,
        putPrice: position.putEntryPrice,
        totalCost: position.totalEntryPrice * position.quantity * 100,
        target: position.targetPrice,
        stop: position.stopPrice,
        entryTime: position.entryTime
      }
    });
  }

  public async sendTradeClosed(position: any): Promise<void> {
    const pnlPercent = (position.pnl / (position.totalEntryPrice * position.quantity * 100)) * 100;
    const level = position.pnl > 0 ? NotificationLevel.SUCCESS : NotificationLevel.WARNING;

    await this.send({
      level,
      title: 'Straddle Position Closed',
      message: `Closed ${position.strike} straddle - P&L: $${position.pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)`,
      details: {
        exitReason: position.exitReason,
        strike: position.strike,
        entryPrice: position.totalEntryPrice,
        exitPrice: position.totalExitPrice,
        pnl: position.pnl,
        pnlPercent: pnlPercent.toFixed(1) + '%',
        duration: Math.floor((new Date(position.exitTime).getTime() - new Date(position.entryTime).getTime()) / 60000) + ' minutes'
      }
    });
  }

  public async sendCriticalAlert(title: string, message: string, details?: any): Promise<void> {
    await this.send({
      level: NotificationLevel.CRITICAL,
      title,
      message,
      details
    });
  }

  public async sendDailySummary(summary: any): Promise<void> {
    const level = summary.dailyPnL > 0 ? NotificationLevel.SUCCESS : NotificationLevel.INFO;
    
    await this.send({
      level,
      title: 'Daily Trading Summary',
      message: `Daily P&L: $${summary.dailyPnL.toFixed(2)} | Win Rate: ${summary.winRate.toFixed(1)}%`,
      details: {
        dailyPnL: '$' + summary.dailyPnL.toFixed(2),
        totalTrades: summary.totalTrades,
        winRate: summary.winRate.toFixed(1) + '%',
        uptime: summary.uptime
      }
    });
  }
}
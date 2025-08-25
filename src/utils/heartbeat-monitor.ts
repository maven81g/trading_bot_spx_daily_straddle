import { EventEmitter } from 'events';
import { Logger } from 'winston';
import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import path from 'path';

export interface HeartbeatConfig {
  intervalMs: number; // How often to send heartbeat
  webhookUrl?: string; // Optional webhook for alerts
  fileLogPath?: string; // Optional file for local heartbeat log
  alertAfterMissedBeats?: number; // Alert after X missed beats
}

export interface HeartbeatStatus {
  lastBeat: Date;
  totalBeats: number;
  missedBeats: number;
  uptime: number;
  status: 'healthy' | 'warning' | 'critical';
  details?: any;
}

export class HeartbeatMonitor extends EventEmitter {
  private config: HeartbeatConfig;
  private logger: Logger;
  private interval: NodeJS.Timeout | null = null;
  private startTime: Date;
  private lastBeat: Date;
  private totalBeats = 0;
  private consecutiveMissed = 0;
  private isRunning = false;
  private statusCallback?: () => Promise<any>;

  constructor(config: HeartbeatConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.startTime = new Date();
    this.lastBeat = new Date();
  }

  public start(statusCallback?: () => Promise<any>): void {
    if (this.isRunning) {
      return;
    }

    this.statusCallback = statusCallback;
    this.isRunning = true;
    this.startTime = new Date();
    
    this.interval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.intervalMs);

    // Send initial heartbeat
    this.sendHeartbeat();
    this.logger.info(`Heartbeat monitor started (interval: ${this.config.intervalMs}ms)`);
  }

  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.isRunning = false;
    this.logger.info('Heartbeat monitor stopped');
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const now = new Date();
      const status = await this.getStatus();
      
      this.lastBeat = now;
      this.totalBeats++;
      this.consecutiveMissed = 0;

      // Log to file if configured
      if (this.config.fileLogPath) {
        await this.logToFile(status);
      }

      // Send webhook if configured
      if (this.config.webhookUrl) {
        await this.sendWebhook(status);
      }

      this.emit('heartbeat', status);
      this.logger.debug(`Heartbeat #${this.totalBeats} sent`);

    } catch (error) {
      this.consecutiveMissed++;
      this.logger.error('Failed to send heartbeat:', error);
      
      if (this.config.alertAfterMissedBeats && 
          this.consecutiveMissed >= this.config.alertAfterMissedBeats) {
        this.sendAlert('Critical: Multiple heartbeats missed');
      }
    }
  }

  private async getStatus(): Promise<HeartbeatStatus> {
    const now = new Date();
    const uptime = Math.floor((now.getTime() - this.startTime.getTime()) / 1000);
    
    let details = {};
    if (this.statusCallback) {
      try {
        details = await this.statusCallback();
      } catch (error) {
        this.logger.error('Failed to get status details:', error);
      }
    }

    const timeSinceLastBeat = now.getTime() - this.lastBeat.getTime();
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    if (timeSinceLastBeat > this.config.intervalMs * 3) {
      status = 'critical';
    } else if (timeSinceLastBeat > this.config.intervalMs * 2) {
      status = 'warning';
    }

    return {
      lastBeat: this.lastBeat,
      totalBeats: this.totalBeats,
      missedBeats: this.consecutiveMissed,
      uptime,
      status,
      details
    };
  }

  private async logToFile(status: HeartbeatStatus): Promise<void> {
    if (!this.config.fileLogPath) return;

    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        ...status
      };

      const logLine = JSON.stringify(logEntry) + '\n';
      await fs.appendFile(this.config.fileLogPath, logLine);
    } catch (error) {
      this.logger.error('Failed to write heartbeat to file:', error);
    }
  }

  private async sendWebhook(status: HeartbeatStatus): Promise<void> {
    if (!this.config.webhookUrl) return;

    try {
      const payload = {
        service: 'SPX-Straddle-Bot',
        timestamp: new Date().toISOString(),
        ...status
      };

      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        timeout: 5000
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status}`);
      }
    } catch (error) {
      this.logger.error('Failed to send heartbeat webhook:', error);
    }
  }

  private async sendAlert(message: string): Promise<void> {
    this.logger.error(`ALERT: ${message}`);
    this.emit('alert', message);

    // Send critical alert via webhook if available
    if (this.config.webhookUrl) {
      try {
        await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            service: 'SPX-Straddle-Bot',
            alert: true,
            level: 'critical',
            message,
            timestamp: new Date().toISOString()
          }),
          timeout: 5000
        });
      } catch (error) {
        this.logger.error('Failed to send alert webhook:', error);
      }
    }
  }

  public getHeartbeatStatus(): HeartbeatStatus {
    const now = new Date();
    const uptime = Math.floor((now.getTime() - this.startTime.getTime()) / 1000);
    const timeSinceLastBeat = now.getTime() - this.lastBeat.getTime();
    
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (timeSinceLastBeat > this.config.intervalMs * 3) {
      status = 'critical';
    } else if (timeSinceLastBeat > this.config.intervalMs * 2) {
      status = 'warning';
    }

    return {
      lastBeat: this.lastBeat,
      totalBeats: this.totalBeats,
      missedBeats: this.consecutiveMissed,
      uptime,
      status
    };
  }
}
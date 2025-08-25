import { promises as fs } from 'fs';
import path from 'path';
import { Logger } from 'winston';

export interface PositionState {
  entryTime: string;
  spxPrice: number;
  strike: number;
  callSymbol: string;
  putSymbol: string;
  callEntryPrice: number;
  putEntryPrice: number;
  totalEntryPrice: number;
  quantity: number;
  targetPrice: number;
  stopPrice?: number;
  callOrderId?: string;
  putOrderId?: string;
  isOpen: boolean;
  exitReason?: string;
  exitTime?: string;
  callExitPrice?: number;
  putExitPrice?: number;
  totalExitPrice?: number;
  pnl?: number;
}

export interface BotState {
  version: string;
  lastSaved: string;
  dailyPnL: number;
  totalTrades: number;
  currentPosition?: PositionState;
  closedPositions: PositionState[];
  lastDataReceived?: string;
  lastBarTimestamp?: string;
  currentSPXPrice?: number;
}

export class StateManager {
  private statePath: string;
  private logger: Logger;
  private saveInterval: NodeJS.Timeout | null = null;
  private pendingState: BotState | null = null;
  private saveInProgress = false;

  constructor(statePath: string, logger: Logger) {
    this.statePath = statePath;
    this.logger = logger;
  }

  public async initialize(): Promise<BotState | null> {
    try {
      const exists = await this.fileExists(this.statePath);
      if (!exists) {
        this.logger.info('No existing state file found');
        return null;
      }

      const content = await fs.readFile(this.statePath, 'utf-8');
      const state = JSON.parse(content) as BotState;
      
      // Validate state version
      if (state.version !== '1.0') {
        this.logger.warn(`State version mismatch: ${state.version}`);
      }

      this.logger.info(`State loaded from ${this.statePath}`);
      this.logger.info(`  Last saved: ${state.lastSaved}`);
      this.logger.info(`  Daily P&L: $${state.dailyPnL}`);
      this.logger.info(`  Total trades: ${state.totalTrades}`);
      
      if (state.currentPosition?.isOpen) {
        this.logger.info(`  Open position: ${state.currentPosition.strike} straddle`);
      }

      return state;
    } catch (error) {
      this.logger.error('Failed to load state:', error);
      return null;
    }
  }

  public async save(state: BotState): Promise<void> {
    // Queue the state for saving
    this.pendingState = {
      ...state,
      version: '1.0',
      lastSaved: new Date().toISOString()
    };

    // Perform save if not already in progress
    if (!this.saveInProgress) {
      await this.performSave();
    }
  }

  private async performSave(): Promise<void> {
    if (!this.pendingState || this.saveInProgress) {
      return;
    }

    this.saveInProgress = true;
    const stateToSave = this.pendingState;
    this.pendingState = null;

    try {
      // Create backup of existing file
      const exists = await this.fileExists(this.statePath);
      if (exists) {
        const backupPath = `${this.statePath}.backup`;
        await fs.copyFile(this.statePath, backupPath);
      }

      // Write new state
      const content = JSON.stringify(stateToSave, null, 2);
      await fs.writeFile(this.statePath, content, 'utf-8');
      
      this.logger.debug('State saved successfully');
    } catch (error) {
      this.logger.error('Failed to save state:', error);
      // Restore state to pending for retry
      this.pendingState = stateToSave;
    } finally {
      this.saveInProgress = false;
      
      // If there's still pending state, save it
      if (this.pendingState) {
        setTimeout(() => this.performSave(), 1000);
      }
    }
  }

  public startAutoSave(intervalMs: number = 30000): void {
    if (this.saveInterval) {
      return;
    }

    this.saveInterval = setInterval(async () => {
      if (this.pendingState) {
        await this.performSave();
      }
    }, intervalMs);

    this.logger.info(`Auto-save enabled (every ${intervalMs / 1000}s)`);
  }

  public stopAutoSave(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  public async createSnapshot(snapshotName?: string): Promise<void> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = snapshotName || `snapshot_${timestamp}`;
      const snapshotPath = path.join(
        path.dirname(this.statePath),
        `${name}.json`
      );

      const exists = await this.fileExists(this.statePath);
      if (exists) {
        await fs.copyFile(this.statePath, snapshotPath);
        this.logger.info(`Snapshot created: ${snapshotPath}`);
      }
    } catch (error) {
      this.logger.error('Failed to create snapshot:', error);
    }
  }

  public async recover(snapshotPath?: string): Promise<BotState | null> {
    try {
      const sourcePath = snapshotPath || `${this.statePath}.backup`;
      const exists = await this.fileExists(sourcePath);
      
      if (!exists) {
        this.logger.warn(`Recovery file not found: ${sourcePath}`);
        return null;
      }

      const content = await fs.readFile(sourcePath, 'utf-8');
      const state = JSON.parse(content) as BotState;
      
      // Save recovered state as current
      await this.save(state);
      
      this.logger.info(`State recovered from ${sourcePath}`);
      return state;
    } catch (error) {
      this.logger.error('Failed to recover state:', error);
      return null;
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public async cleanup(daysToKeep: number = 7): Promise<void> {
    try {
      const dir = path.dirname(this.statePath);
      const files = await fs.readdir(dir);
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith('snapshot_') || file.endsWith('.backup')) {
          const filePath = path.join(dir, file);
          const stats = await fs.stat(filePath);
          
          if (now - stats.mtime.getTime() > maxAge) {
            await fs.unlink(filePath);
            this.logger.debug(`Cleaned up old state file: ${file}`);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old state files:', error);
    }
  }
}
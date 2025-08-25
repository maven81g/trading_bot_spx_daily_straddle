#!/usr/bin/env node

import 'dotenv/config';
import { StateManager, BotState } from './src/utils/state-manager';
import { createLogger } from './src/utils/logger';
import * as fs from 'fs';

const logger = createLogger('StateTest', { level: 'info' });

async function testStateManager() {
  console.log('💾 Testing State Management...\n');

  // Create test directory
  const testDir = './test-data';
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const stateManager = new StateManager(`${testDir}/test-state.json`, logger);

  try {
    // Test 1: Initialize empty state
    console.log('🔄 Initializing state manager...');
    const initialState = await stateManager.initialize();
    console.log(`✅ Initialized: ${initialState ? 'Existing state loaded' : 'No existing state'}\n`);

    // Test 2: Save test state
    console.log('💾 Saving test state...');
    const testState: BotState = {
      version: '1.0',
      lastSaved: new Date().toISOString(),
      dailyPnL: 1250.75,
      totalTrades: 5,
      currentPosition: {
        entryTime: new Date().toISOString(),
        spxPrice: 5498.25,
        strike: 5500,
        callSymbol: 'SPXW 250823C5500',
        putSymbol: 'SPXW 250823P5500',
        callEntryPrice: 25.75,
        putEntryPrice: 19.75,
        totalEntryPrice: 45.50,
        quantity: 1,
        targetPrice: 54.60,
        stopPrice: 22.75,
        isOpen: true
      },
      closedPositions: [
        {
          entryTime: new Date(Date.now() - 3600000).toISOString(),
          spxPrice: 5495.00,
          strike: 5495,
          callSymbol: 'SPXW 250823C5495',
          putSymbol: 'SPXW 250823P5495',
          callEntryPrice: 28.50,
          putEntryPrice: 21.25,
          totalEntryPrice: 49.75,
          quantity: 1,
          targetPrice: 59.70,
          isOpen: false,
          exitReason: 'TARGET',
          exitTime: new Date(Date.now() - 1800000).toISOString(),
          callExitPrice: 32.25,
          putExitPrice: 18.50,
          totalExitPrice: 50.75,
          pnl: 100
        }
      ],
      lastDataReceived: new Date().toISOString(),
      lastBarTimestamp: new Date().toISOString(),
      currentSPXPrice: 5498.25
    };

    await stateManager.save(testState);
    console.log('✅ Test state saved\n');

    // Test 3: Load saved state
    console.log('📖 Loading saved state...');
    const loadedState = await stateManager.initialize();
    
    if (loadedState) {
      console.log(`✅ State loaded successfully:`);
      console.log(`   Daily P&L: $${loadedState.dailyPnL}`);
      console.log(`   Total Trades: ${loadedState.totalTrades}`);
      console.log(`   Current Position: ${loadedState.currentPosition ? loadedState.currentPosition.strike + ' straddle' : 'None'}`);
      console.log(`   Closed Positions: ${loadedState.closedPositions.length}`);
      console.log(`   Last Data: ${loadedState.lastDataReceived || 'N/A'}`);
    } else {
      console.log('❌ Failed to load state');
    }
    console.log('');

    // Test 4: Create snapshot
    console.log('📸 Creating state snapshot...');
    await stateManager.createSnapshot('test_snapshot');
    console.log('✅ Snapshot created\n');

    // Test 5: Test auto-save
    console.log('🔄 Testing auto-save...');
    stateManager.startAutoSave(2000); // 2 seconds for testing

    // Update state
    testState.dailyPnL += 500;
    testState.totalTrades += 1;
    await stateManager.save(testState);
    
    console.log('⏳ Waiting for auto-save (2 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    stateManager.stopAutoSave();
    console.log('✅ Auto-save test completed\n');

    // Test 6: Test cleanup
    console.log('🧹 Testing cleanup...');
    // Create some old test files
    const oldFile1 = `${testDir}/snapshot_old_test.json`;
    const oldFile2 = `${testDir}/test-state.json.backup`;
    
    fs.writeFileSync(oldFile1, '{}');
    fs.writeFileSync(oldFile2, '{}');
    
    // Set file times to old (simulate old files)
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    fs.utimesSync(oldFile1, oldTime, oldTime);
    fs.utimesSync(oldFile2, oldTime, oldTime);
    
    await stateManager.cleanup(7); // Keep 7 days
    console.log('✅ Cleanup test completed\n');

    console.log('🎉 All state management tests completed successfully!');

    // Cleanup test directory
    console.log('🧹 Cleaning up test files...');
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('✅ Test cleanup completed');

  } catch (error) {
    console.error('❌ State management test failed:', error);
  }
}

if (require.main === module) {
  testStateManager().catch(console.error);
}
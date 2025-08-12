// Test single day 2025-08-08 to understand the discrepancy
const { SPX20DayBacktest } = require('./spx-20day-backtest');

async function testSingleDay() {
    const backtest = new SPX20DayBacktest();
    
    // Override the getLastTradingDays to return only 2025-08-08
    const originalGetTradingDays = backtest.constructor.prototype.getLastTradingDays;
    backtest.constructor.prototype.getLastTradingDays = function() {
        return [new Date('2025-08-08')];
    };
    
    console.log('🧪 Testing single day: 2025-08-08');
    console.log('='.repeat(50));
    
    try {
        await backtest.runBacktest();
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testSingleDay();
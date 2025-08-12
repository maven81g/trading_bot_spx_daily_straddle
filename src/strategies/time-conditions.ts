// Time-based Conditions for Strategy Evaluation

import { TimeConditionConfig, MarketContext } from '@/types/strategy';

export class TimeConditions {
  
  /**
   * Evaluate time-based conditions
   */
  evaluate(config: TimeConditionConfig, context: MarketContext): boolean {
    try {
      const { timeType } = config.parameters;
      const currentTime = context.timestamp;
      
      switch (timeType) {
        case 'time_of_day':
          return this.evaluateTimeOfDay(config, currentTime);
          
        case 'day_of_week':
          return this.evaluateDayOfWeek(config, currentTime);
          
        case 'market_session':
          return this.evaluateMarketSession(config, currentTime);
          
        case 'duration_since':
          return this.evaluateDurationSince(config, context);
          
        default:
          return true;
      }
      
    } catch (error) {
      console.warn('Time condition evaluation error:', error);
      return false;
    }
  }
  
  private evaluateTimeOfDay(config: TimeConditionConfig, currentTime: Date): boolean {
    const { startTime, endTime } = config.parameters;
    
    if (!startTime || !endTime) return true;
    
    const currentHour = currentTime.getHours();
    const currentMinute = currentTime.getMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;
    
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);
    
    const startTimeInMinutes = startHour * 60 + startMin;
    const endTimeInMinutes = endHour * 60 + endMin;
    
    if (startTimeInMinutes <= endTimeInMinutes) {
      // Same day range
      return currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes <= endTimeInMinutes;
    } else {
      // Overnight range  
      return currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes <= endTimeInMinutes;
    }
  }
  
  private evaluateDayOfWeek(config: TimeConditionConfig, currentTime: Date): boolean {
    const { daysOfWeek } = config.parameters;
    
    if (!daysOfWeek || daysOfWeek.length === 0) return true;
    
    const currentDay = currentTime.getDay(); // 0 = Sunday, 1 = Monday, etc.
    return daysOfWeek.includes(currentDay);
  }
  
  private evaluateMarketSession(config: TimeConditionConfig, currentTime: Date): boolean {
    const { sessionType } = config.parameters;
    
    if (!sessionType) return true;
    
    const hour = currentTime.getHours();
    const minute = currentTime.getMinutes();
    const timeInMinutes = hour * 60 + minute;
    
    // US Eastern Time market hours (assuming UTC-5/UTC-4)
    switch (sessionType) {
      case 'pre_market':
        // 4:00 AM - 9:30 AM ET
        return timeInMinutes >= 240 && timeInMinutes < 570;
        
      case 'regular':
        // 9:30 AM - 4:00 PM ET  
        return timeInMinutes >= 570 && timeInMinutes < 960;
        
      case 'after_hours':
        // 4:00 PM - 8:00 PM ET
        return timeInMinutes >= 960 && timeInMinutes < 1200;
        
      default:
        return true;
    }
  }
  
  private evaluateDurationSince(config: TimeConditionConfig, context: MarketContext): boolean {
    const { duration, referenceEvent } = config.parameters;
    
    if (!duration || !referenceEvent) return true;
    
    // This would need additional context data to track reference events
    // For now, return true as a placeholder
    return true;
  }
}
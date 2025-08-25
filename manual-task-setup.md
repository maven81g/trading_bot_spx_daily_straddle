# Manual Windows Task Scheduler Setup

If the automated setup doesn't work, follow these steps to create the task manually:

## Step 1: Open Task Scheduler
1. Press `Win + R`
2. Type `taskschd.msc` and press Enter

## Step 2: Create Basic Task
1. In the right panel, click **"Create Basic Task..."**
2. **Name**: `SPX_Straddle_Bot`
3. **Description**: `Runs the SPX Straddle Trading Bot with auto-restart`
4. Click **Next**

## Step 3: Trigger
1. Select **"When the computer starts"**
2. Click **Next**

## Step 4: Action
1. Select **"Start a program"**
2. Click **Next**

## Step 5: Program Details
1. **Program/script**: `C:\Development\GenAI Projects\trading_bot_spx_daily_straddle\run-bot-local.bat`
2. **Start in**: `C:\Development\GenAI Projects\trading_bot_spx_daily_straddle`
3. Click **Next**

## Step 6: Finish
1. Check **"Open the Properties dialog..."**
2. Click **Finish**

## Step 7: Configure Properties
In the Properties dialog:

### General Tab:
- Check **"Run with highest privileges"**
- Check **"Run whether user is logged on or not"**

### Triggers Tab:
- Edit the trigger
- Check **"Delay task for: 2 minutes"**
- Under Advanced settings, check **"Repeat task every: 5 minutes"**
- Set **"for a duration of: Indefinitely"**

### Settings Tab:
- Check **"Allow task to be run on demand"**
- Check **"Run task as soon as possible after a scheduled start is missed"**
- Check **"If the task fails, restart every: 1 minute"**
- Set **"Attempt to restart up to: 999 times"**

### Actions Tab:
- Verify the program path is correct
- Working directory should be: `C:\Development\GenAI Projects\trading_bot_spx_daily_straddle`

## Step 8: Save and Test
1. Click **OK** to save
2. Right-click on the task and select **"Run"** to test
3. Check if the bot starts running

## Troubleshooting:
- If the task shows as "Running" but nothing happens, check the path in Actions tab
- Make sure the .bat file exists and is executable
- Check Windows Event Viewer for task scheduler errors
- Ensure you have admin privileges when creating the task
#!/bin/bash

echo "========================================"
echo "   BOT RESET SCRIPT"
echo "========================================"
echo ""
echo "This will delete all users, tasks, and data!"
echo "A backup will be created automatically."
echo ""
read -p "Press Enter to continue or Ctrl+C to cancel..."
echo ""
node reset-bot.js
echo ""
read -p "Press Enter to exit..."

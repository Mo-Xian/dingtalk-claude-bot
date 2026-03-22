@echo off
cd /d C:\Users\Administrator\dingtalk-claude-bot
title DingTalk-Bot
npx tsx src/index.ts >> bot.log 2>&1

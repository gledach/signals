@echo off
REM Zone 1 — Gmail ingest (local Task Scheduler). See .apsolut/ideas/gmail-next-steps.html
cd /d "%~dp0.."
if not exist .logs mkdir .logs
echo ===== %date% %time% gmail-ingest =====>> .logs\gmail-ingest.log
call npm run watch:gmail >> .logs\gmail-ingest.log 2>&1
exit /b %ERRORLEVEL%

@echo off
REM Zone 2 — promote pending email hits (local Task Scheduler).
REM Requires CI_EMAIL_PROMOTE_ALLOW_PROD=1 when TURSO is hosted.
REM See .apsolut/ideas/gmail-next-steps.html
cd /d "%~dp0.."
if not exist .logs mkdir .logs
echo ===== %date% %time% gmail-promote =====>> .logs\gmail-promote.log
call npm run email:promote:nollm >> .logs\gmail-promote.log 2>&1
exit /b %ERRORLEVEL%

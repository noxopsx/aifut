@echo off
setlocal
cd /d "%~dp0"
set "LOG=actualizacion_live.log"
echo.>>"%LOG%"
echo [%date% %time%] Actualizacion manual>>"%LOG%"
node datos_live.mjs %* >>"%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo [%date% %time%] Error %CODE%>>"%LOG%"
exit /b %CODE%

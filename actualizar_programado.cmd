@echo off
setlocal
cd /d "%~dp0"
set "LOG=actualizacion_live.log"
set "CODE=0"
echo.>>"%LOG%"
echo [%date% %time%] Actualizacion programada>>"%LOG%"

rem Cartelera live: 15 min en día de partido, 6 h fuera de él.
node datos_live.mjs --programado --min-horas 6 --min-minutos-dia 15 %* >>"%LOG%" 2>&1
if not "%ERRORLEVEL%"=="0" set "CODE=%ERRORLEVEL%"
if not "%ERRORLEVEL%"=="0" echo [%date% %time%] Error live %ERRORLEVEL%>>"%LOG%"

rem Catálogo + fixtures + cobertura: lock y cadencia propios.
python -m pipeline.sync_operativo --scheduled >>"%LOG%" 2>&1
if not "%ERRORLEVEL%"=="0" if "%CODE%"=="0" set "CODE=%ERRORLEVEL%"
if not "%ERRORLEVEL%"=="0" echo [%date% %time%] Error sync %ERRORLEVEL%>>"%LOG%"

exit /b %CODE%

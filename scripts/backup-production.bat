@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%backup-production.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

rem Si se ejecuta mediante doble clic desde el Explorador de Windows, mantener la ventana abierta para leer el resultado
echo %cmdcmdline% | find /i "%~f0" >nul
if not errorlevel 1 pause

exit /b %EXIT_CODE%

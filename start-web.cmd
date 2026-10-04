@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>&1
if not errorlevel 1 (
  py -3 scripts\start_web.py
  goto :finish
)

where python >nul 2>&1
if not errorlevel 1 (
  python scripts\start_web.py
  goto :finish
)

where python3 >nul 2>&1
if not errorlevel 1 (
  python3 scripts\start_web.py
  goto :finish
)

echo Python 3 is required to start the WebUI.
pause
exit /b 1

:finish
if errorlevel 1 (
  echo.
  echo WebUI failed to start. Please check the message above.
  pause
  exit /b 1
)
exit /b 0

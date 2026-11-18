@echo off
rem Microtone diagnostics (the Start menu's "Microtone diagnostics"): what the
rem audio systems do on this computer, and the app's own log and crash
rem reports, gathered into one folder on the Desktop to send to the developers.
rem Installed beside microtone.exe; desktop-qt/README.md has the details.
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Microtone diagnostics

for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESK=%%d"
if not defined DESK set "DESK=%USERPROFILE%\Desktop"
set "OUT=%DESK%\Microtone report"
if not exist "%OUT%" mkdir "%OUT%"

echo Microtone diagnostics
echo.
echo This takes about a minute and plays short test tones (440 Hz) through
echo each audio system, so turn the volume down. Close Microtone first.
echo.
pause

tasklist /fi "imagename eq microtone.exe" | find /i "microtone.exe" >nul
if not errorlevel 1 (
  echo Microtone is still running: close it, then run this again.
  pause
  exit /b 1
)

echo [1/4] This computer...
(
  ver
  echo.
  powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | Format-List; Get-CimInstance Win32_SoundDevice | Select-Object Name, Manufacturer, Status | Format-Table -AutoSize"
) > "%OUT%\system.txt" 2>&1

echo [2/4] WASAPI (shared, low latency, exclusive)...
(
  echo === wasapi-probe all 128
  "%~dp0wasapi-probe.exe" all 128
  echo === exit code !errorlevel!
  echo.
  echo === wasapi-probe all 480
  "%~dp0wasapi-probe.exe" all 480
  echo === exit code !errorlevel!
) > "%OUT%\wasapi-probe.txt" 2>&1

echo [3/4] ASIO...
(
  echo === asio-probe all
  "%~dp0asio-probe.exe" all
  echo === exit code !errorlevel!
) > "%OUT%\asio-probe.txt" 2>&1

echo [4/4] Microtone's log and crash reports...
xcopy /y /q "%LOCALAPPDATA%\Microtone\Microtone\logs\*" "%OUT%\" >nul 2>&1

echo.
echo Done. Please send the folder "%OUT%" (zip it first).
explorer "%OUT%"
pause

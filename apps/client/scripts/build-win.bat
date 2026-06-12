@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo === Nexio Client Windows Build ===
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo Node.js is required. Download from https://nodejs.org
  pause
  exit /b 1
)

:: Go to client directory
cd /d "%~dp0.."

:: Install dependencies
echo.
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
  echo npm install failed
  pause
  exit /b 1
)

:: Build
echo.
echo Building...
call npm run build
if %errorlevel% neq 0 (
  echo Build failed
  pause
  exit /b 1
)

:: Package
echo.
echo Packaging for Windows...
if "%1"=="--portable" (
  npx electron-builder --win portable
) else (
  npx electron-builder --win
)
if %errorlevel% neq 0 (
  echo Packaging failed
  pause
  exit /b 1
)

echo.
echo === Done ===
echo Output: %CD%\release\
pause
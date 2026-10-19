@echo off
setlocal
title Building the Tandem installer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

echo.
echo  Step 1 of 3: downloading build tools. The first run takes a few minutes.
echo.
call npm install
if errorlevel 1 goto :fail

rem electron-builder needs its winCodeSign toolkit to put the icon and version
rem info on Tandem.exe. The archive includes two macOS-only symbolic links that
rem Windows refuses to create without admin rights or Developer Mode, which
rem makes electron-builder's own extraction fail. Unpacking it here first, and
rem skipping those two links, avoids that. Windows builds don't use them.
set "WCS=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
set "WCS_URL=https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
set "WCS_7Z=%TEMP%\winCodeSign-2.6.0.7z"
set "SEVENZIP=%~dp0node_modules\7zip-bin\win\x64\7za.exe"

echo.
echo  Step 2 of 3: preparing the Windows build toolkit.
echo.
dir /a-d /s /b "%WCS%" >nul 2>nul
if not errorlevel 1 goto :build

if not exist "%SEVENZIP%" goto :fail
curl.exe -L --fail --silent --show-error -o "%WCS_7Z%" "%WCS_URL%"
if errorlevel 1 goto :fail
"%SEVENZIP%" x -y -bd "%WCS_7Z%" "-o%WCS%" >nul 2>nul
del "%WCS_7Z%" >nul 2>nul
dir /a-d /s /b "%WCS%" >nul 2>nul
if errorlevel 1 goto :fail

:build
echo.
echo  Step 3 of 3: building the installer.
echo.
call npm run dist
if errorlevel 1 goto :fail

echo.
echo  Done. Your files are in the dist folder:
echo    Tandem-Setup-1.0.0.exe     installer with Start menu and desktop shortcuts
echo    Tandem-Portable-1.0.0.exe  runs without installing
echo.
start "" "%~dp0dist"
pause
exit /b 0

:nonode
echo.
echo  Node.js isn't installed yet.
echo  Download the LTS version from https://nodejs.org, install it,
echo  then double-click this file again.
echo.
start "" "https://nodejs.org"
pause
exit /b 1

:fail
echo.
echo  The build stopped with an error. Scroll up to see what went wrong.
echo  If it mentions "symbolic link", right-click build-installer.bat and
echo  choose "Run as administrator".
echo.
pause
exit /b 1

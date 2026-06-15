@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: ============================================================
:MENU
:: Re-read version each loop (version may have changed)
set CURRENT_VER=
for /f "tokens=2 delims=:, " %%a in ('findstr "version" src-tauri\tauri.conf.json') do (
    if "!CURRENT_VER!"=="" set CURRENT_VER=%%~a
)

cls
echo ========================================
echo   ComicReader (Android) Release Tool
echo ========================================
echo.
echo Current version: %CURRENT_VER%

if "%CURRENT_VER%"=="" (
    echo ERROR: Cannot read version from src-tauri\tauri.conf.json
    pause ^& exit /b 1
)

echo.
echo [1] New release  (bump version, commit, tag, push -^> Actions builds APK)
echo [2] Re-push tag  (delete + recreate tag to retrigger Actions)
echo [3] Exit
echo.
set /p MODE=Choose (1/2/3):
if "%MODE%"=="1" goto NEW_RELEASE
if "%MODE%"=="2" goto REPUSH
if "%MODE%"=="3" goto EXIT
echo Invalid choice, try again.
pause
goto MENU

:: ============================================================
:: --- NEW RELEASE ---
:NEW_RELEASE
set /p NEW_VER=Enter new version (e.g. 0.1.1):
if "%NEW_VER%"=="" (
    echo ERROR: Version cannot be empty
    pause ^& goto MENU
)

echo.
echo Will release v%NEW_VER% ^(current: v%CURRENT_VER%^)
set /p CONFIRM=Continue? (y/N):
if /i not "%CONFIRM%"=="y" (
    echo Cancelled.
    pause ^& goto MENU
)

echo.
echo [1/4] Updating version numbers...

:: Use [System.IO.File] to avoid UTF-8 BOM corruption
powershell -NoProfile -Command "$enc = New-Object System.Text.UTF8Encoding($false); $f = 'package.json'; [System.IO.File]::WriteAllText($f, ([System.IO.File]::ReadAllText($f) -replace '\"version\": \"%CURRENT_VER%\"', '\"version\": \"%NEW_VER%\"'), $enc)"
if errorlevel 1 ( echo ERROR: package.json failed ^& pause ^& goto MENU )

powershell -NoProfile -Command "$enc = New-Object System.Text.UTF8Encoding($false); $f = 'src-tauri\tauri.conf.json'; [System.IO.File]::WriteAllText($f, ([System.IO.File]::ReadAllText($f) -replace '\"version\": \"%CURRENT_VER%\"', '\"version\": \"%NEW_VER%\"'), $enc)"
if errorlevel 1 ( echo ERROR: tauri.conf.json failed ^& pause ^& goto MENU )

powershell -NoProfile -Command "$enc = New-Object System.Text.UTF8Encoding($false); $f = 'src-tauri\Cargo.toml'; [System.IO.File]::WriteAllText($f, ([System.IO.File]::ReadAllText($f) -replace '(?m)^version = \"%CURRENT_VER%\"', 'version = \"%NEW_VER%\"'), $enc)"
if errorlevel 1 ( echo ERROR: Cargo.toml failed ^& pause ^& goto MENU )

echo   Done.

echo.
echo [2/4] Git commit...
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to %NEW_VER%"
if errorlevel 1 ( echo ERROR: git commit failed ^& pause ^& goto MENU )

echo.
echo [3/4] Creating tag v%NEW_VER%...
git tag v%NEW_VER%
if errorlevel 1 ( echo ERROR: tag exists? Run: git tag -d v%NEW_VER% ^& pause ^& goto MENU )

echo.
echo [4/4] Pushing to GitHub...
git push origin master
if errorlevel 1 ( echo ERROR: push master failed ^& pause ^& goto MENU )
git push origin v%NEW_VER%
if errorlevel 1 ( echo ERROR: push tag failed ^& pause ^& goto MENU )

echo.
echo ========================================
echo   Done! v%NEW_VER% pushed.
echo   APK build: https://github.com/stevedaydream/zip_reader_android/actions
echo   Release:   https://github.com/stevedaydream/zip_reader_android/releases
echo ========================================
pause
goto MENU

:: ============================================================
:: --- RE-PUSH ---
:REPUSH
echo.
set /p REPUSH_VER=Tag to re-push (leave blank for current v%CURRENT_VER%):
if "%REPUSH_VER%"=="" set REPUSH_VER=%CURRENT_VER%

echo.
echo Will delete and re-push tag v%REPUSH_VER%
set /p CONFIRM2=Continue? (y/N):
if /i not "%CONFIRM2%"=="y" ( echo Cancelled. ^& pause ^& goto MENU )

echo.
echo [1/3] Deleting local tag v%REPUSH_VER%...
git tag -d v%REPUSH_VER%
if errorlevel 1 ( echo WARNING: local tag not found, continuing... )

echo.
echo [2/3] Deleting remote tag v%REPUSH_VER%...
git push origin --delete v%REPUSH_VER%
if errorlevel 1 ( echo WARNING: remote tag not found, continuing... )

echo.
echo [3/3] Creating and pushing tag v%REPUSH_VER%...
git tag v%REPUSH_VER%
if errorlevel 1 ( echo ERROR: failed to create tag ^& pause ^& goto MENU )
git push origin v%REPUSH_VER%
if errorlevel 1 ( echo ERROR: push tag failed ^& pause ^& goto MENU )

echo.
echo ========================================
echo   Done! v%REPUSH_VER% re-pushed.
echo   Actions: https://github.com/stevedaydream/zip_reader_android/actions
echo ========================================
pause
goto MENU

:: ============================================================
:EXIT
echo Bye.
exit /b 0

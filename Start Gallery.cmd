@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\python.exe" (
  set "GALLERY_PYTHON=runtime\python.exe"
) else (
  set "GALLERY_PYTHON=python"
)
if exist "collection.json" (
  "%GALLERY_PYTHON%" setup_dataset.py
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
"%GALLERY_PYTHON%" app.py %*
if errorlevel 1 pause

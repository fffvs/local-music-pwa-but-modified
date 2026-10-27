@echo off
REM Double-click this after unzipping the build folder next to scripts\.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*

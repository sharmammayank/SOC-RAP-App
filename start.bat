@echo off
rem Double-click to start SOC-RAP on Windows. Keep this window open while you use the app.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 server.py & goto :eof)
where python >nul 2>nul && (python server.py & goto :eof)
echo Python 3 is needed to run the local server. Install it from https://www.python.org/downloads/ and try again.
pause

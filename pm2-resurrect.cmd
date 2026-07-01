@echo off
REM Auto-resurrect pm2 (atlas + shadow-atlas) at user logon.
REM Created to prevent silent outages after logoff/reboot.
"C:\Program Files\nodejs\node.exe" "C:\Users\Derek DiCamillo\AppData\Roaming\npm\node_modules\pm2\bin\pm2" resurrect

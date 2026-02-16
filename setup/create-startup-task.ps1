$action = New-ScheduledTaskAction -Execute 'C:\Users\derek\AppData\Roaming\npm\pm2.cmd' -Argument 'resurrect'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'derek'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'pm2-resurrect' -Action $action -Trigger $trigger -Settings $settings -Description 'Resurrect pm2 saved processes on login' -RunLevel Limited
Write-Host "Scheduled task 'pm2-resurrect' created successfully."

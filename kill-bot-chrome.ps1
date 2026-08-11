Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | 
    Where-Object { $_.CommandLine -like '*chrome-profile-automessage*' } | 
    ForEach-Object { 
        Write-Host "Killing bot Chrome PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue 
    }

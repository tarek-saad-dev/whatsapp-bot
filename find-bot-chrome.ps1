Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | 
    Select-Object ProcessId, CommandLine | 
    Where-Object { $_.CommandLine -like '*chrome-profile-automessage*' } | 
    Format-Table -AutoSize

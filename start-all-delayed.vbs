' ============================================================
' Auto-Start All Services with Delay
' This script waits 30 seconds after Windows startup,
' then launches start-all.bat automatically
' ============================================================

' Wait 30 seconds to allow Windows to fully boot
WScript.Sleep 30000

' Create shell object
Set objShell = CreateObject("WScript.Shell")

' Get the directory where this script is located
strScriptPath = WScript.ScriptFullName
strScriptDir = Left(strScriptPath, InStrRev(strScriptPath, "\"))

' Build path to start-all.bat
strBatchFile = strScriptDir & "start-all.bat"

' Run the batch file
' 1 = Normal window, True = Wait for completion
objShell.Run """" & strBatchFile & """", 1, False

' Clean up
Set objShell = Nothing

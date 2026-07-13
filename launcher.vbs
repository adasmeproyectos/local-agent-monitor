' launcher.vbs — Silent launcher for Navi Cleaner
' Uses CreateObject("WScript.Shell").Run with WindowStyle=0 (hidden)
' so NO cmd.exe terminal appears on double-click.

Set oShell = CreateObject("WScript.Shell")

' Get the folder of this .vbs file
strPath = WScript.ScriptFullName
strDir  = Left(strPath, InStrRev(strPath, "\"))

exePath = strDir & "Navi Cleaner-win.exe"

' WindowStyle 0 = hidden, bWaitOnReturn = False
oShell.Run """" & exePath & """", 0, False

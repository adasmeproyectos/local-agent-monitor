' ─────────────────────────────────────────────────────────────────────────────
'  Navi Cleaner — Silent Desktop Launcher (VBScript Bridge)
'  Runs launch-navi.bat completely hidden (window mode 0) so no black terminal
'  window ever appears.
' ─────────────────────────────────────────────────────────────────────────────

Set WshShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath
WshShell.Run "cmd.exe /c """ & strPath & "\launch-navi.bat""", 0, False

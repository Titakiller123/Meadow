' Starts Meadow in the background with no window.
' Windows runs this at login (shortcut in your Startup folder). start.bat also uses it.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\background.bat""", 0, False

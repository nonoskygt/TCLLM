' Arranca TCLLM sin ventana de consola (lo usa la tarea programada "TCLLM").
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "cmd.exe /c """"" & root & "\tcllm.cmd"" start >> """ & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.tcllm\logs\stdout.log"" 2>&1""", 0, False

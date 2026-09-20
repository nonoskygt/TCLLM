' Arranca TCLLM sin ventana de consola (lo usa la tarea programada "TCLLM").
' cmd con rutas relativas (sin comillas anidadas) y salida a %USERPROFILE%\.tcllm\logs\stdout.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logs = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.tcllm\logs"
If Not fso.FolderExists(sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.tcllm") Then fso.CreateFolder(sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.tcllm")
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)
sh.CurrentDirectory = root
If fso.FileExists(root & "\runtime\node.exe") Then
  node = "runtime\node.exe"
Else
  node = "node"
End If
sh.Run "cmd.exe /c " & node & " bin\tcllm.js start 1>>""" & logs & "\stdout.log"" 2>&1", 0, False

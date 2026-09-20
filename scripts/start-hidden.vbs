' Arranca TCLLM sin ventana de consola (lo usa la tarea programada "TCLLM").
' cmd con rutas relativas (sin comillas anidadas) y salida a %USERPROFILE%\.tcllm\logs\stdout.log.
' Espera al proceso y propaga su codigo de salida para que el Programador de tareas siga al servidor real (RestartCount).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
home = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.tcllm"
logs = home & "\logs"
If Not fso.FolderExists(home) Then fso.CreateFolder(home)
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)
sh.CurrentDirectory = root
If fso.FileExists(root & "\runtime\node.exe") Then
  node = "runtime\node.exe"
Else
  node = "node"
End If
rc = sh.Run("cmd.exe /c " & node & " bin\tcllm.js start 1>>""" & logs & "\stdout.log"" 2>&1", 0, True)
WScript.Quit rc

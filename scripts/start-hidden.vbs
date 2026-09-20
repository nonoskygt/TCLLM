' Arranca TCLLM sin ventana de consola (lo usa la tarea programada "TCLLM").
' Lanza node.exe directamente (runtime incluido o el del PATH); TCLLM escribe sus logs en %USERPROFILE%\.tcllm\logs.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = root & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node.exe"
sh.CurrentDirectory = root
sh.Run """" & node & """ """ & root & "\bin\tcllm.js"" start", 0, False

@echo off
rem Lanzador de TCLLM: usa el Node incluido en runtime\ si existe; si no, el del PATH.
setlocal
set "ROOT=%~dp0"
if exist "%ROOT%runtime\node.exe" (set "NODE=%ROOT%runtime\node.exe") else (set "NODE=node")
"%NODE%" "%ROOT%bin\tcllm.js" %*
endlocal

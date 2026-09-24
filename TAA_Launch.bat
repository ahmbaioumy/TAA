@echo off
REM TAA_Launch.bat — starts a zero-dependency local static server and opens
REM TAA_Workspace.html from http://localhost instead of file://.
REM
REM Why this exists (§6.1a): the File System Access API (used for CMS
REM auto-export folder automation) is unreliable from file:// pages because
REM Chromium treats local files as an opaque/unique origin, which breaks its
REM origin-keyed permission model. Opening the tool via this launcher instead
REM gives it a stable http://localhost origin. If you skip this and just
REM double-click TAA_Workspace.html, the tool still works — it detects
REM file:// and disables only the CMS-folder-automation panel, falling back
REM to the original fully-manual 4-upload flow.
REM
REM No install, no external dependency: this is plain PowerShell's built-in
REM HttpListener, nothing downloaded or added to the machine.

setlocal
set "ROOT=%~dp0"
set "PORT=8743"

echo Starting TAA local server at http://localhost:%PORT%/ ...
start "" "http://localhost:%PORT%/TAA_Workspace.html"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = '%ROOT%'; $port = %PORT%;" ^
  "$listener = New-Object System.Net.HttpListener;" ^
  "$listener.Prefixes.Add(('http://localhost:{0}/' -f $port));" ^
  "$listener.Start();" ^
  "Write-Host ('Serving ' + $root + ' — close this window to stop.');" ^
  "try {" ^
  "  while ($listener.IsListening) {" ^
  "    $ctx = $listener.GetContext();" ^
  "    $reqPath = $ctx.Request.Url.LocalPath.TrimStart('/');" ^
  "    if ([string]::IsNullOrWhiteSpace($reqPath)) { $reqPath = 'TAA_Workspace.html' };" ^
  "    $filePath = Join-Path $root $reqPath;" ^
  "    if (Test-Path $filePath -PathType Leaf) {" ^
  "      $bytes = [System.IO.File]::ReadAllBytes($filePath);" ^
  "      $ext = [System.IO.Path]::GetExtension($filePath).ToLower();" ^
  "      $ctype = switch ($ext) { '.html' {'text/html'} '.js' {'application/javascript'} '.css' {'text/css'} '.json' {'application/json'} default {'application/octet-stream'} };" ^
  "      $ctx.Response.ContentType = $ctype;" ^
  "      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length);" ^
  "    } else {" ^
  "      $ctx.Response.StatusCode = 404;" ^
  "    }" ^
  "    $ctx.Response.OutputStream.Close();" ^
  "  }" ^
  "} finally { $listener.Stop() }"

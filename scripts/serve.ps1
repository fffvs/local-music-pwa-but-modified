# Serve the production build at http://127.0.0.1:8080 with SPA fallback.
# Windows only, nothing to install: PowerShell 5.1+ is built into Windows.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\serve.ps1
#
# Or just double-click scripts\serve.bat next to this file.
param([int]$Port = 8080)

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build'))
$rootWithSlash = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (-not (Test-Path (Join-Path $root '200.html'))) {
    throw "Missing $root\200.html - run 'pnpm run build' first."
}

$types = @{
    '.html'        = 'text/html; charset=utf-8'
    '.js'          = 'text/javascript; charset=utf-8'
    '.css'         = 'text/css; charset=utf-8'
    '.json'        = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json'
    '.svg'         = 'image/svg+xml'
    '.png'         = 'image/png'
    '.jpg'         = 'image/jpeg'
    '.avif'        = 'image/avif'
    '.woff2'       = 'font/woff2'
    '.ico'         = 'image/x-icon'
    '.txt'         = 'text/plain; charset=utf-8'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Snae Player is running at http://127.0.0.1:$Port/"
Write-Host 'Open that exact address. Close this window (or press Ctrl+C) to stop.'

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 5000
        $client.SendTimeout = 10000
        try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream)
            $requestLine = $reader.ReadLine()

            # Read (and discard) the request headers. GET requests have no body.
            while (-not [string]::IsNullOrEmpty($reader.ReadLine())) { }
            if ([string]::IsNullOrEmpty($requestLine)) { continue }

            $parts = $requestLine.Split(' ')
            $method = $parts[0]
            $rawPath = if ($parts.Length -gt 1) { $parts[1].Split('?')[0] } else { '/' }
            $relative = [System.Uri]::UnescapeDataString($rawPath).TrimStart('/')
            if ([string]::IsNullOrEmpty($relative)) { $relative = 'index.html' }

            $file = [System.IO.Path]::GetFullPath((Join-Path $rootWithSlash $relative))
            $status = '200 OK'
            if (-not $file.StartsWith($rootWithSlash, [System.StringComparison]::OrdinalIgnoreCase) -or
                -not [System.IO.File]::Exists($file)) {
                if ($relative.StartsWith('_app/', [System.StringComparison]::OrdinalIgnoreCase)) {
                    # Missing JS/CSS chunk: a real 404, never an HTML fallback.
                    $status = '404 Not Found'
                    $file = $null
                } else {
                    # Unknown path = client-side route. 200.html is the SPA shell.
                    $file = Join-Path $rootWithSlash '200.html'
                }
            }

            $ext = if ($file) { [System.IO.Path]::GetExtension($file).ToLowerInvariant() } else { '' }
            $contentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
            $body = if ($null -eq $file) { [byte[]]@() } else { [System.IO.File]::ReadAllBytes($file) }

            $headers = "HTTP/1.1 $status`r`n" +
                       "Content-Type: $contentType`r`n" +
                       "Content-Length: $($body.Length)`r`n" +
                       "Connection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -ne 'HEAD' -and $body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
            $stream.Flush()
        } catch {
            # A broken request should not take the whole server down.
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}

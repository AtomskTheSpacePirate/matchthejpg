# Local preview server for the game. Serves this folder at http://localhost:8080/
# Run:  powershell -ExecutionPolicy Bypass -File serve.ps1
# Stop: close the window (or press Ctrl+C and reload the page once).

$root = $PSScriptRoot
$port = 8080

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.jpg'  = 'image/jpeg'
  '.png'  = 'image/png'
  '.webp' = 'image/webp'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.json' = 'application/json; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.xml'  = 'application/xml; charset=utf-8'
}

# The game's photo pool is photos-web/manifest.json. It is rebuilt from the folder each time
# the game asks for it, so photos added to or removed from photos-web show up on reload.
$manifest = Join-Path $root 'photos-web\manifest.json'
function Update-PhotoManifest {
  $names = Get-ChildItem -LiteralPath (Join-Path $root 'photos-web') -File |
    Where-Object { @('.jpg', '.jpeg', '.png', '.webp') -contains $_.Extension.ToLower() } |
    Sort-Object Name | ForEach-Object { '"' + $_.Name + '"' }
  $json = '[' + ($names -join ',') + ']'
  [IO.File]::WriteAllText($manifest, $json, (New-Object Text.UTF8Encoding $false))
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root"
Write-Host "Open http://localhost:$port/ in your browser."

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($path -eq '') { $path = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))
      $inside = $file.StartsWith($root + [IO.Path]::DirectorySeparatorChar)
      if ($file -eq $manifest) { Update-PhotoManifest }

      if ($inside -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $type = $mime[[IO.Path]::GetExtension($file).ToLower()]
        if (-not $type) { $type = 'application/octet-stream' }
        $ctx.Response.ContentType = $type
        $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
      }
    } catch {
      # The browser closed the connection early; nothing to do.
    } finally {
      $ctx.Response.Close()
    }
  }
} finally {
  $listener.Stop()
}

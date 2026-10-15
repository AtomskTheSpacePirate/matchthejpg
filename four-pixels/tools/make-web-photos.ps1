# Makes web copies of the Match Pixel Colors photos: matchthepixelphotos/ (full size, kept off
# GitHub) -> pixel-photos-web/ (what the game loads). Run again after adding photos:
#   powershell -ExecutionPolicy Bypass -File four-pixels\tools\make-web-photos.ps1
# then rebuild the colours with build-palettes.ps1. Photos already converted and not changed
# since are skipped. Copies are JPEGs with a long edge of LONG_EDGE pixels, like photos-web/.

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot)
$source = Join-Path $root 'matchthepixelphotos'
$target = Join-Path $root 'pixel-photos-web'
$LONG_EDGE = 1600
$QUALITY = 85

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationCore
New-Item -ItemType Directory -Force $target | Out-Null

# Opens a photo with the classic reader, or failing that with Windows' newer image system (WIC),
# which also reads AVIF and HEIC (even when named .jpg) if their Microsoft Store extensions are
# installed. Throws when neither can.
function Read-Photo($path) {
  try { return [System.Drawing.Image]::FromFile($path) } catch {}
  $stream = [IO.File]::OpenRead($path)
  try {
    $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream, 'None', 'OnLoad')
    $png = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $png.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($decoder.Frames[0]))
    $buffer = New-Object IO.MemoryStream
    $png.Save($buffer)
    $buffer.Position = 0
    return [System.Drawing.Image]::FromStream($buffer)
  } finally {
    $stream.Close()
  }
}

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$settings = New-Object System.Drawing.Imaging.EncoderParameters 1
$settings.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$QUALITY)

$files = Get-ChildItem -LiteralPath $source -File |
  Where-Object { @('.jpg', '.jpeg', '.png') -contains $_.Extension.ToLower() } | Sort-Object Name
$made = 0
foreach ($f in $files) {
  $out = Join-Path $target ($f.BaseName + '.jpg')
  if ((Test-Path -LiteralPath $out) -and (Get-Item -LiteralPath $out).LastWriteTime -ge $f.LastWriteTime) { continue }

  try {
    $src = Read-Photo $f.FullName
  } catch {
    Write-Warning "Skipped $($f.Name): no image reader on this PC can open it"
    continue
  }
  try {
    # Turn the picture upright if the camera only marked it as rotated.
    if ($src.PropertyIdList -contains 0x0112) {
      $flip = @{ 3 = 'Rotate180FlipNone'; 6 = 'Rotate90FlipNone'; 8 = 'Rotate270FlipNone' }[[int][BitConverter]::ToUInt16($src.GetPropertyItem(0x0112).Value, 0)]
      if ($flip) { $src.RotateFlip([System.Drawing.RotateFlipType]$flip) }
    }
    # 1.0, not 1: with a whole number PowerShell picks the whole-number Min and rounds the scale to 0.
    $scale = [math]::Min(1.0, $LONG_EDGE / [math]::Max($src.Width, $src.Height))
    $w = [int][math]::Round($src.Width * $scale)
    $h = [int][math]::Round($src.Height * $scale)
    $small = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($small)
    $g.Clear([System.Drawing.Color]::White) # PNGs with see-through parts get a white background
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $w, $h)
    $g.Dispose()
    $small.Save($out, $jpeg, $settings)
    $small.Dispose()
  } finally {
    $src.Dispose()
  }
  Write-Host ("  {0} -> {1}x{2}, {3:N0} KB" -f $f.Name, $w, $h, ((Get-Item -LiteralPath $out).Length / 1KB))
  $made++
}
Write-Host "Converted $made of $($files.Count) photos into $target"

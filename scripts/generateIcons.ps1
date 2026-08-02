$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $projectRoot 'build'
$pngPath = Join-Path $buildDirectory 'icon.png'
$icoPath = Join-Path $buildDirectory 'icon.ico'
$iconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

New-Item -ItemType Directory -Force -Path $buildDirectory | Out-Null

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-NotchIconBitmap {
  param([int]$Size)

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.ScaleTransform($Size / 512.0, $Size / 512.0)

    $backgroundBrush = [System.Drawing.SolidBrush]::new(
      [System.Drawing.ColorTranslator]::FromHtml('#171513')
    )
    $foregroundBrush = [System.Drawing.SolidBrush]::new(
      [System.Drawing.ColorTranslator]::FromHtml('#F4EFE7')
    )
    $statusBrush = [System.Drawing.SolidBrush]::new(
      [System.Drawing.ColorTranslator]::FromHtml('#D97757')
    )
    $backgroundPath = New-RoundedRectanglePath -X 0 -Y 0 -Width 512 -Height 512 -Radius 112
    $notchPath = [System.Drawing.Drawing2D.GraphicsPath]::new()

    try {
      $graphics.FillPath($backgroundBrush, $backgroundPath)

      $notchPath.AddLine(56, 144, 184, 144)
      $notchPath.AddBezier(184, 144, 198, 144, 208, 154, 208, 168)
      $notchPath.AddLine(208, 168, 208, 188)
      $notchPath.AddBezier(208, 188, 208, 216, 228, 236, 256, 236)
      $notchPath.AddBezier(256, 236, 284, 236, 304, 216, 304, 188)
      $notchPath.AddLine(304, 188, 304, 168)
      $notchPath.AddBezier(304, 168, 304, 154, 314, 144, 328, 144)
      $notchPath.AddLine(328, 144, 456, 144)
      $notchPath.AddLine(456, 144, 456, 208)
      $notchPath.AddLine(456, 208, 354, 208)
      $notchPath.AddBezier(354, 208, 346, 208, 340, 214, 340, 222)
      $notchPath.AddBezier(340, 222, 340, 276, 304, 312, 256, 312)
      $notchPath.AddBezier(256, 312, 208, 312, 172, 276, 172, 222)
      $notchPath.AddBezier(172, 222, 172, 214, 166, 208, 158, 208)
      $notchPath.AddLine(158, 208, 56, 208)
      $notchPath.CloseFigure()
      $graphics.FillPath($foregroundBrush, $notchPath)

      $graphics.FillEllipse($statusBrush, 231, 153, 50, 50)
    } finally {
      $notchPath.Dispose()
      $backgroundPath.Dispose()
      $statusBrush.Dispose()
      $foregroundBrush.Dispose()
      $backgroundBrush.Dispose()
    }
  } finally {
    $graphics.Dispose()
  }

  return $bitmap
}

function Convert-BitmapToPngBytes {
  param([System.Drawing.Bitmap]$Bitmap)

  $stream = [System.IO.MemoryStream]::new()
  try {
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    # Keep the byte array as one pipeline object; PowerShell otherwise flattens
    # every byte into the surrounding ICO image table.
    return ,$stream.ToArray()
  } finally {
    $stream.Dispose()
  }
}

$pngImages = @()
foreach ($size in $iconSizes) {
  $bitmap = New-NotchIconBitmap -Size $size
  try {
    $pngImages += ,@($size, (Convert-BitmapToPngBytes -Bitmap $bitmap))
  } finally {
    $bitmap.Dispose()
  }
}

$preview = New-NotchIconBitmap -Size 512
try {
  $preview.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $preview.Dispose()
}

$stream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = [System.IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$pngImages.Count)

  $offset = 6 + (16 * $pngImages.Count)
  foreach ($image in $pngImages) {
    $size = [int]$image[0]
    $bytes = [byte[]]$image[1]
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $bytes.Length
  }

  foreach ($image in $pngImages) {
    $writer.Write([byte[]]$image[1])
  }
} finally {
  $writer.Dispose()
  $stream.Dispose()
}

Write-Host "Generated $pngPath"
Write-Host "Generated $icoPath with $($iconSizes.Count) sizes"

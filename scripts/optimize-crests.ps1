# Reduce los escudos descargados a 160 px para que la web cargue más rápido.
# Se ejecuta una sola vez tras `node scripts/download-crests.mjs`.
# Requiere Windows PowerShell (System.Drawing). Los PNG ya optimizados se
# versionan en `css/crests/`, así que Cloudflare no necesita este script.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot "..\css\crests"
$max = 160
$count = 0
$before = 0
$after = 0

foreach ($file in Get-ChildItem -LiteralPath $dir -Filter "*.png" -File) {
    if ($file.Name.StartsWith("_")) { continue }

    $image = $null
    $bitmap = $null
    $graphics = $null
    try {
        $image = [System.Drawing.Image]::FromFile($file.FullName)
        $scale = [Math]::Min(
            [double]$max / [double]$image.Width,
            [double]$max / [double]$image.Height
        )
        if ($image.Width -le $max -and $image.Height -le $max) { continue }

        $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
        $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))

        $bitmap = New-Object System.Drawing.Bitmap(
            $width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
        )
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($image, 0, 0, $width, $height)

        $temp = Join-Path $dir ("_" + $file.Name)
        $bitmap.Save($temp, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose(); $graphics = $null
        $bitmap.Dispose(); $bitmap = $null
        $image.Dispose(); $image = $null

        $before += $file.Length
        $after += (Get-Item -LiteralPath $temp).Length
        Move-Item -LiteralPath $temp -Destination $file.FullName -Force
        $count += 1
    }
    finally {
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
        if ($image) { $image.Dispose() }
    }
}

Write-Output ("AIFUT · {0} escudos optimizados: {1:N1} MB -> {2:N1} MB" -f $count, ($before / 1MB), ($after / 1MB))

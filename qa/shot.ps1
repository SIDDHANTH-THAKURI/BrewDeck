# Capture the screen and downscale by an EXACT, known factor.
#
# The viewer that reads these PNGs resizes large images to fit, and an unknown
# resize factor is fatal here: a coordinate read off the picture has to be
# multiplied by something to become a coordinate the mouse can be sent to, and
# guessing that multiplier is how clicks end up consistently off-target.
# Producing a 1536-wide image from a 1920-wide screen fixes the factor at
# exactly 1.25, so image (x,y) -> screen (x*1.25, y*1.25) with no guessing.
param([int]$Width = 1536)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ([System.Management.Automation.PSTypeName]'BrewdeckDpi').Type) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class BrewdeckDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
}
[BrewdeckDpi]::SetProcessDPIAware() | Out-Null

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()

$scale  = $b.Width / [double]$Width
$height = [int][Math]::Round($b.Height / $scale)
$small  = New-Object System.Drawing.Bitmap $Width, $height
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($full, 0, 0, $Width, $height)
$g2.Dispose()

$out = Join-Path $env:TEMP ("gym-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".png")
$small.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$full.Dispose(); $small.Dispose()

Write-Output $out
Write-Output ("screen {0}x{1} | image {2}x{3} | MULTIPLY image coords by {4:N4}" -f $b.Width, $b.Height, $Width, $height, $scale)

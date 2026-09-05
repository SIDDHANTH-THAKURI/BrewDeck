# Captures the whole virtual screen (every monitor) to a PNG. Used by the
# phone-call task tier to answer "what's on my screen" — see call.js's
# TASK_SYSTEM_PROMPT. Takes one optional arg: the output path; defaults to a
# fresh temp file so concurrent calls never collide on the same filename.
param(
  [string]$OutPath = (Join-Path $env:TEMP ("brewdeck-screen-" + [guid]::NewGuid().ToString("N") + ".png"))
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $OutPath

# Native desktop input for the phone-call task tier.
#
# Playwright drives page content only. A real call hit the wall this exists to
# fix: a native Edge "Got it" sync dialog sat on top of the page, and the call
# could see it in a screenshot but had no way to click it, because it is an OS
# window rather than a DOM node. This talks to user32 directly, so it can click
# anything on screen, including native dialogs, the taskbar and other apps.
#
# Coordinates are virtual-screen pixels, matching call-hooks/screenshot.ps1
# exactly, so "the button is at x,y in the screenshot" maps straight through.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('move', 'click', 'doubleclick', 'rightclick', 'type', 'key', 'scroll', 'where', 'focus', 'windows', 'drag', 'fit')]
  [string]$Action,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$ToX = -1,
  [int]$ToY = -1,
  [string]$Text = '',
  [int]$Amount = 3,
  [int]$Steps = 24
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Match screenshot.ps1 exactly. Without this, a scaled display gives this
# script LOGICAL coordinates while the capture is in PHYSICAL ones, so a
# control read off the screenshot at x=1200 gets clicked at a different place
# entirely. The mismatch looks like bad aim and is really two coordinate
# spaces; making both processes DPI-aware collapses them into one.
if (-not ([System.Management.Automation.PSTypeName]'BrewdeckDpi').Type) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class BrewdeckDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
}
[BrewdeckDpi]::SetProcessDPIAware() | Out-Null

if (-not ([System.Management.Automation.PSTypeName]'BrewdeckInput').Type) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class BrewdeckInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const int RESTORE = 9;
  // SetForegroundWindow is refused unless the calling thread already owns the
  // foreground window, so borrow the current foreground thread's input state
  // for the duration of the call -- the standard workaround.
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, RESTORE);
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    if (fg != me) AttachThreadInput(fg, me, true);
    bool ok = SetForegroundWindow(h);
    if (fg != me) AttachThreadInput(fg, me, false);
    return ok;
  }
}
'@
}

# Clamp to the virtual screen so a bad coordinate can't fling the pointer to a
# monitor that isn't there.
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
function Move-To([int]$px, [int]$py) {
  if ($px -lt 0 -or $py -lt 0) { throw "move/click needs -X and -Y" }
  $cx = [Math]::Min([Math]::Max($px, $vs.Left), $vs.Right - 1)
  $cy = [Math]::Min([Math]::Max($py, $vs.Top), $vs.Bottom - 1)
  [BrewdeckInput]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 60
  return @($cx, $cy)
}

switch ($Action) {
  'windows' {
    # what could be clicked, so a target can be named rather than guessed at
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
      Sort-Object ProcessName |
      ForEach-Object { "$($_.ProcessName)  |  $($_.MainWindowTitle)" }
  }
  'focus' {
    # Clicks land on whatever window is in front, not on whatever was in the
    # screenshot. A real call took a screenshot of Edge, then clicked "Got it"
    # while a different window had since come to the front, so the click went
    # to the wrong application and the caller said "you didn't click". Always
    # focus first, then re-screenshot, then click.
    if (-not $Text) { throw "focus needs -Text (a process name or part of a window title)" }
    $w = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and
      ($_.ProcessName -like "*$Text*" -or $_.MainWindowTitle -like "*$Text*")
    } | Select-Object -First 1
    if (-not $w) { throw "no window matching '$Text' -- run -Action windows to list them" }
    $ok = [BrewdeckInput]::Raise($w.MainWindowHandle)
    Start-Sleep -Milliseconds 350
    "focused $($w.ProcessName): $($w.MainWindowTitle)$(if (-not $ok) { ' (SetForegroundWindow refused; verify with a screenshot)' })"
  }
  'fit' {
    # Pin a window to exactly the coordinate space that screenshots and clicks
    # share. Without this a "maximized" window can extend past the virtual
    # screen bounds this script works in, so a control visible in the capture
    # sits at a different place than the same pixel on screen -- every click
    # then lands consistently wrong, which looks like bad aim rather than a
    # mismatched coordinate space.
    if (-not $Text) { throw "fit needs -Text (process name or window title)" }
    $w = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and
      ($_.ProcessName -like "*$Text*" -or $_.MainWindowTitle -like "*$Text*")
    } | Select-Object -First 1
    if (-not $w) { throw "no window matching '$Text'" }
    [BrewdeckInput]::Raise($w.MainWindowHandle) | Out-Null
    [BrewdeckInput]::ShowWindow($w.MainWindowHandle, 9) | Out-Null   # un-maximize first
    Start-Sleep -Milliseconds 200
    [BrewdeckInput]::MoveWindow($w.MainWindowHandle, $vs.Left, $vs.Top, $vs.Width, $vs.Height, $true) | Out-Null
    Start-Sleep -Milliseconds 400
    $r = New-Object BrewdeckInput+RECT
    [BrewdeckInput]::GetWindowRect($w.MainWindowHandle, [ref]$r) | Out-Null
    "fitted $($w.ProcessName) to $($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top) (screen $($vs.Width)x$($vs.Height))"
  }
  'where' {
    $p = [System.Windows.Forms.Cursor]::Position
    "cursor at $($p.X),$($p.Y)  screen $($vs.Width)x$($vs.Height) origin $($vs.Left),$($vs.Top)"
  }
  'move' {
    $c = Move-To $X $Y
    "moved to $($c[0]),$($c[1])"
  }
  'click' {
    $c = Move-To $X $Y
    [BrewdeckInput]::mouse_event([BrewdeckInput]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [BrewdeckInput]::mouse_event([BrewdeckInput]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    "clicked $($c[0]),$($c[1])"
  }
  'drag' {
    # Press, travel in steps, release. The intermediate moves are the point:
    # HTML5 drag-and-drop and any custom knob/slider listen for mousemove, and
    # a jump straight from press to release produces none, so nothing moves.
    if ($ToX -lt 0 -or $ToY -lt 0) { throw "drag needs -X -Y -ToX -ToY" }
    $from = Move-To $X $Y
    [BrewdeckInput]::mouse_event([BrewdeckInput]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    for ($s = 1; $s -le $Steps; $s++) {
      $px = [int]($from[0] + (($ToX - $from[0]) * $s / $Steps))
      $py = [int]($from[1] + (($ToY - $from[1]) * $s / $Steps))
      [BrewdeckInput]::SetCursorPos($px, $py) | Out-Null
      Start-Sleep -Milliseconds 16
    }
    Start-Sleep -Milliseconds 90
    [BrewdeckInput]::mouse_event([BrewdeckInput]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    "dragged $($from[0]),$($from[1]) -> $ToX,$ToY in $Steps steps"
  }
  'doubleclick' {
    $c = Move-To $X $Y
    for ($i = 0; $i -lt 2; $i++) {
      [BrewdeckInput]::mouse_event([BrewdeckInput]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 30
      [BrewdeckInput]::mouse_event([BrewdeckInput]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    "double-clicked $($c[0]),$($c[1])"
  }
  'rightclick' {
    $c = Move-To $X $Y
    [BrewdeckInput]::mouse_event([BrewdeckInput]::RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [BrewdeckInput]::mouse_event([BrewdeckInput]::RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
    "right-clicked $($c[0]),$($c[1])"
  }
  'scroll' {
    if ($X -ge 0 -and $Y -ge 0) { Move-To $X $Y | Out-Null }
    # positive Amount scrolls up, negative scrolls down; 120 units per notch.
    # mouse_event takes the delta as an unsigned dword, so a scroll-down (-120)
    # has to be handed over as its two's-complement bit pattern -- casting the
    # negative number straight to [uint32] throws instead.
    # (masking with 0xFFFFFFFF does not work here: PowerShell 5.1 parses that
    # literal as Int32 -1, so the -band is a no-op and the cast still throws)
    $delta = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int32]($Amount * 120)), 0)
    [BrewdeckInput]::mouse_event([BrewdeckInput]::WHEEL, 0, 0, $delta, [IntPtr]::Zero)
    "scrolled $Amount notch(es)"
  }
  'type' {
    # SendKeys has no public Escape helper (assuming it does throws
    # "does not contain a method named 'Escape'"), so the literal-text escaping
    # is done here: +^%~()[]{} are SendKeys syntax and have to be brace-wrapped
    # to be typed as themselves.
    if (-not $Text) { throw "type needs -Text" }
    if ($X -ge 0 -and $Y -ge 0) { Move-To $X $Y | Out-Null }
    $esc = ($Text.ToCharArray() | ForEach-Object {
      if ('+^%~(){}[]'.Contains($_)) { "{$_}" } else { [string]$_ }
    }) -join ''
    [System.Windows.Forms.SendKeys]::SendWait($esc)
    "typed $($Text.Length) char(s)"
  }
  'key' {
    # SendKeys notation: {ENTER} {TAB} {ESC} ^c (ctrl+c) %{F4} (alt+F4)
    if (-not $Text) { throw "key needs -Text, e.g. '{ENTER}' or '^c'" }
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    "sent key $Text"
  }
}

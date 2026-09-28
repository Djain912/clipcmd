# clipcmd PowerShell hook
# This file is managed by clipcmd. Do not edit manually.
#
# Works in Windows PowerShell 5.1 and PowerShell 7+ in interactive consoles
# (it needs PSReadLine, which they load by default). Sends /start when a
# command line is accepted and /end from the prompt, then prints the daemon's
# OSC 8 copy buttons. Every daemon call is silent and bounded by a short
# timeout, so a missing or dead daemon never breaks the shell.
#
# This file must stay ASCII: Windows PowerShell 5.1 reads BOM-less profiles
# in the ANSI code page.

if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage' -and
    -not (Test-Path variable:global:__ClipcmdState) -and
    (Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction Ignore)) {

  $__clipcmdDir = if ($env:CLIPCMD_CONFIG_DIR) { $env:CLIPCMD_CONFIG_DIR } else { Join-Path (Join-Path $HOME '.config') 'clipcmd' }
  $global:__ClipcmdState = @{
    PortFile         = Join-Path $__clipcmdDir 'port'
    ConfigFile       = Join-Path $__clipcmdDir 'config.json'
    StoppedFile      = Join-Path $__clipcmdDir 'stopped'
    AutoStartAt      = [datetime]::MinValue
    # `clipcmd shell` sets CLIPCMD_SESSION; it captures this session's output
    Session          = if ($env:CLIPCMD_SESSION) { $env:CLIPCMD_SESSION } else { "$PID" }
    InClipcmdShell   = [bool]$env:CLIPCMD_SESSION
    Term             = if ($env:TERM_PROGRAM -eq 'vscode') { 'vscode' } else { '' }
    Seq              = 0
    Started          = $false
    RetryAt          = [datetime]::MinValue
    CommandLine      = ''
    ExitCodeBefore   = $null
    # False until our prompt runs; checked before each command line is read
    PromptRan        = $false
    OriginalPrompt   = $null
    OriginalReadLine = $function:PSConsoleHostReadLine
    PromptWrapper    = $null
  }
  Remove-Variable __clipcmdDir

  # Starts the daemon in the background (at most every 30 seconds), e.g. in the
  # first shell after a reboot. `clipcmd start --auto` does nothing after
  # `clipcmd stop`. Returns $true if it started one.
  function global:__Clipcmd-AutoStart {
    Set-StrictMode -Off
    $state = $global:__ClipcmdState
    if ([datetime]::UtcNow -lt $state.AutoStartAt -or $env:CLIPCMD_AUTOSTART -eq '0' -or
        [System.IO.File]::Exists($state.StoppedFile)) { return $false }
    $state.AutoStartAt = [datetime]::UtcNow.AddSeconds(30)
    try {
      # The npm shim: clipcmd.cmd on Windows (hidden, so no console flashes up)
      $cli = Get-Command clipcmd -CommandType Application -ErrorAction Ignore | Select-Object -First 1
      if (-not $cli) { return $false }
      $info = New-Object System.Diagnostics.ProcessStartInfo
      $info.FileName = $cli.Source
      $info.Arguments = 'start --auto --quiet'
      $info.UseShellExecute = $false
      $info.CreateNoWindow = $true
      $info.RedirectStandardOutput = $true
      $info.RedirectStandardError = $true
      [System.Diagnostics.Process]::Start($info).Dispose()
      return $true
    } catch {
      return $false
    }
  }

  # GET http://127.0.0.1:<port><PathAndQuery>. Returns the body, or $null on
  # any failure. Never throws. A missing daemon is started; meanwhile
  # connection failures back off, so they do not delay every command.
  function global:__Clipcmd-Request([string]$PathAndQuery) {
    Set-StrictMode -Off
    $state = $global:__ClipcmdState
    if ([datetime]::UtcNow -lt $state.RetryAt) { return $null }
    try {
      $match = [regex]::Match([System.IO.File]::ReadAllText($state.PortFile), '^\s*(\d{1,5})(?::\d+)?\s*$')
    } catch {
      $null = __Clipcmd-AutoStart
      return $null
    }
    if (-not $match.Success) { return $null }
    try {
      $request = [System.Net.WebRequest]::Create("http://127.0.0.1:$($match.Groups[1].Value)$PathAndQuery")
      $request.Proxy = $null
      $request.KeepAlive = $false
      $request.Timeout = 1000
      $request.ReadWriteTimeout = 1000
      $response = $request.GetResponse()
      try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
      } finally {
        $response.Close()
      }
    } catch {
      $err = $_.Exception
      while ($err -and -not ($err -is [System.Net.WebException])) { $err = $err.InnerException }
      # No HTTP response at all: nothing (working) listens on the port. (Not
      # just ConnectFailure: PowerShell 7 reports a refused connection as
      # UnknownError.)
      if (-not ($err -and $err.Response)) {
        $null = __Clipcmd-AutoStart
        # Just started (AutoStartAt is 30s after that): try again soon
        $starting = $state.AutoStartAt -gt [datetime]::UtcNow.AddSeconds(20)
        $state.RetryAt = [datetime]::UtcNow.AddSeconds($(if ($starting) { 1 } else { 30 }))
      }
      return $null
    }
  }

  # Invisible marker telling `clipcmd shell` where a command's output starts or ends
  function global:__Clipcmd-Mark([string]$Kind) {
    $state = $global:__ClipcmdState
    if ($state.InClipcmdShell) {
      [Console]::Write("$([char]27)]9999;clipcmd;$Kind;$($state.Seq)$([char]7)")
    }
  }

  # Puts our prompt wrapper around whatever prompt function is current.
  function global:__Clipcmd-WrapPrompt {
    $global:__ClipcmdState.OriginalPrompt = $function:global:prompt
    ${function:global:prompt} = $global:__ClipcmdState.PromptWrapper
  }

  # Runs after every command, before the prompt is drawn: send /end and print the buttons.
  $global:__ClipcmdState.PromptWrapper = {
    # Must be the first statement: anything else resets $?
    $commandSucceeded = $global:?
    # Before reading anything else: under the user's strict mode, reading an
    # unset variable such as $LASTEXITCODE would throw and break the prompt
    Set-StrictMode -Off
    $nativeExitCode = $global:LASTEXITCODE
    $state = $global:__ClipcmdState
    $state.PromptRan = $true

    if ($state.Started) {
      $state.Started = $false
      try {
        # Everything printed so far is the command's output
        __Clipcmd-Mark 'end'
        # PowerShell only exposes success/failure ($?) plus the last native
        # program's exit code, which may be left over from an earlier command.
        $exitCode = 0
        if (-not $commandSucceeded) {
          $exitCode = 1
          if ($nativeExitCode -is [int] -and $nativeExitCode -ne 0) {
            if ($nativeExitCode -ne $state.ExitCodeBefore) {
              $exitCode = $nativeExitCode
            } else {
              # Unchanged code: trust it only if the command ran a native program
              $first = ($state.CommandLine.Trim() -split '\s+', 2)[0]
              $info = Get-Command $first -ErrorAction Ignore | Select-Object -First 1
              if ($info -and $info.CommandType -eq 'Application') { $exitCode = $nativeExitCode }
            }
          }
        }
        $buttons = __Clipcmd-Request ('/end?exitCode=' + $exitCode + '&sid=' + [System.Uri]::EscapeDataString($state.Session))
        if ($buttons) { [Console]::Write($buttons) }
      } catch { }
    }

    # Hand $? back to the original prompt (it may show an error indicator)
    if (-not $commandSucceeded) { Write-Error 'failure' -ErrorAction Ignore }
    if ($state.OriginalPrompt) {
      & $state.OriginalPrompt
    } else {
      "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($NestedPromptLevel + 1)) "
    }
  }

  # Runs when the user accepts a command line, before it executes: send /start.
  function global:PSConsoleHostReadLine {
    $lastRunStatus = $?
    Set-StrictMode -Off
    $state = $global:__ClipcmdState

    # A prompt framework (oh-my-posh, starship, ...) replaced our prompt
    # after we installed it: wrap the new one so /end keeps working.
    if (-not $state.PromptRan) { __Clipcmd-WrapPrompt }
    $state.PromptRan = $false

    # PSReadLine reads $? to color its error indicator; keep it accurate
    if (-not $lastRunStatus) { Write-Error 'failure' -ErrorAction Ignore }
    $line = $state.OriginalReadLine.Invoke()

    try {
      $text = -join $line
      if ($text.Trim().Length -gt 0) {
        $state.Seq++
        $state.CommandLine = $text
        $state.ExitCodeBefore = $global:LASTEXITCODE
        $location = if ($PWD.Provider.Name -eq 'FileSystem') { $PWD.ProviderPath } else { "$PWD" }
        $query = 'cmd=' + [System.Uri]::EscapeDataString($text) +
                 '&pwd=' + [System.Uri]::EscapeDataString($location) +
                 '&sid=' + [System.Uri]::EscapeDataString($state.Session) +
                 '&seq=' + $state.Seq
        if ($state.Term) { $query += '&term=' + $state.Term }
        $state.Started = $null -ne (__Clipcmd-Request "/start?$query")
        if ($state.Started) { __Clipcmd-Mark 'start' }
      }
    } catch { }

    $line
  }

  # True for a plain interactive PowerShell (as terminals start it), false when
  # it was started to run something: -Command, -File, -EncodedCommand, or a
  # bare command/script argument (e.g. "Developer PowerShell" shortcuts).
  function global:__Clipcmd-IsPlainInteractive([string[]]$StartArgs = [Environment]::GetCommandLineArgs()) {
    $withValue = '^[-/](executionpolicy|ep|ex|windowstyle|w|workingdirectory|wd|configurationname|config|psconsolefile|version|v|inputformat|if|outputformat|of|settingsfile|custompipename)$'
    $harmless = '^[-/](nologo|noexit|noprofile|noninteractive|mta|sta|login|l|interactive|i)$'
    $startArgs = $StartArgs
    for ($i = 1; $i -lt $startArgs.Count; $i++) {
      if ($startArgs[$i] -match $withValue) { $i++; continue }
      if ($startArgs[$i] -match $harmless) { continue }
      return $false
    }
    return -not [Console]::IsInputRedirected
  }

  # Output capture: a plain console cannot show us what a command printed, so
  # run this session inside `clipcmd shell`, which records it. Not in VS Code
  # (the clipcmd extension captures output there), not when PowerShell was
  # started to run a command, and not when turned off with "autoShell": false
  # in config.json or CLIPCMD_AUTOSHELL=0 (=1 forces it). If the wrapper cannot
  # start, this session simply continues without output capture.
  $__clipcmdAutoShell = -not $env:CLIPCMD_SESSION -and $env:TERM_PROGRAM -ne 'vscode' -and
                        $env:CLIPCMD_AUTOSHELL -ne '0' -and
                        ($env:CLIPCMD_AUTOSHELL -eq '1' -or (__Clipcmd-IsPlainInteractive))
  if ($__clipcmdAutoShell -and $env:CLIPCMD_AUTOSHELL -ne '1' -and (Test-Path $global:__ClipcmdState.ConfigFile)) {
    try {
      $__clipcmdConfig = [System.IO.File]::ReadAllText($global:__ClipcmdState.ConfigFile) | ConvertFrom-Json
      if ($__clipcmdConfig.autoShell -eq $false) { $__clipcmdAutoShell = $false }
    } catch { }
    Remove-Variable __clipcmdConfig -ErrorAction Ignore
  }
  if ($__clipcmdAutoShell) {
    $__clipcmdCli = Get-Command clipcmd -CommandType ExternalScript, Application -ErrorAction Ignore | Select-Object -First 1
    if ($__clipcmdCli) {
      $__clipcmdEdition = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
      & $__clipcmdCli.Source shell $__clipcmdEdition
      # 126: the wrapper could not start; carry on here without output capture
      if ($LASTEXITCODE -ne 126) { [Environment]::Exit([int]$LASTEXITCODE) }
    }
  }
  Remove-Variable __clipcmdAutoShell, __clipcmdCli, __clipcmdEdition -ErrorAction Ignore

  # Start the daemon now unless it is registered and alive (a port file left
  # over from before a reboot names a dead process), so the first command
  # already gets buttons.
  try {
    $__clipcmdMatch = [regex]::Match([System.IO.File]::ReadAllText($global:__ClipcmdState.PortFile), ':(\d+)\s*$')
    if ($__clipcmdMatch.Success -and -not (Get-Process -Id ([int]$__clipcmdMatch.Groups[1].Value) -ErrorAction Ignore)) {
      $null = __Clipcmd-AutoStart
    }
  } catch {
    $null = __Clipcmd-AutoStart
  }
  Remove-Variable __clipcmdMatch -ErrorAction Ignore

  __Clipcmd-WrapPrompt
}

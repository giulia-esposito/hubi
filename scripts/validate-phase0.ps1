#!/usr/bin/env pwsh
<#
Hubi -- Phase 0 Reasoning Engine Validation (native PowerShell, no Node.js required)

Runs the same 7 checks as scripts/validate-phase0.mjs, using only the `claude` CLI
and PowerShell's own process/JSON handling. Use this version whenever Node.js
cannot be installed on the target machine (e.g. no administrator rights).

Requires: PowerShell 7+ (pwsh), and `claude` (Claude Code CLI) installed and
logged into your account on THIS machine.

Usage:  pwsh -File scripts/validate-phase0.ps1
    or: powershell -ExecutionPolicy Bypass -File scripts/validate-phase0.ps1
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ResultPath = Join-Path $ScriptDir "phase0-result.json"

$Report = [ordered]@{
    ranAt               = (Get-Date).ToString("o")
    checks              = [ordered]@{}
    overall             = "unknown"
    reasoningEngineMode = $null
    notes               = @()
}

$IsolationArgs = @("--tools", "", "--strict-mcp-config", "--setting-sources", "")
$SystemPrompt = "You are a headless reasoning engine invoked by an internal tool called Hubi. " +
                "Follow the user's instruction exactly and output nothing else."

function Invoke-Claude {
    param(
        [string[]]$Arguments,
        [int]$TimeoutMs = 30000
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "claude"
    foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        [void]$proc.Start()
        # Read both streams fully asynchronously (not via OutputDataReceived events, which
        # can interleave/reorder lines across the stdout+stderr event threads and corrupt
        # multi-line JSON) -- ReadToEndAsync preserves exact byte/line order per stream.
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()

        $exited = $proc.WaitForExit($TimeoutMs)
        $timedOut = -not $exited
        if ($timedOut) {
            try { $proc.Kill($true) } catch {}
            [void]$proc.WaitForExit(2000)
        }
        [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 5000) | Out-Null
        $stdout = if ($stdoutTask.IsCompletedSuccessfully) { $stdoutTask.Result } else { "" }
        $stderr = if ($stderrTask.IsCompletedSuccessfully) { $stderrTask.Result } else { "" }
    }
    catch {
        $sw.Stop()
        return [pscustomobject]@{
            Code = -1; Stdout = ""; Stderr = "spawn error: $($_.Exception.Message)"
            TimedOut = $false; DurationMs = $sw.ElapsedMilliseconds
        }
    }
    $sw.Stop()

    [pscustomobject]@{
        Code       = if ($timedOut) { -1 } else { $proc.ExitCode }
        Stdout     = $stdout
        Stderr     = $stderr
        TimedOut   = $timedOut
        DurationMs = $sw.ElapsedMilliseconds
    }
}

function Try-ParseJson($text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try { return ($text | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

function Parse-Ndjson($text) {
    $lines = $text -split "`n" | Where-Object { $_.Trim() -ne "" }
    $events = @()
    foreach ($l in $lines) {
        $parsed = Try-ParseJson $l
        if ($null -ne $parsed) { $events += $parsed } else { $events += [pscustomobject]@{ unparsed = $l } }
    }
    return , $events
}

function Get-EventText($e) {
    if ($null -eq $e) { return $null }
    if ($e.PSObject.Properties.Name -contains 'message' -and $null -ne $e.message) {
        $content = $e.message.content
        if ($content -and $content.Count -gt 0) {
            $first = $content[0]
            if ($first.PSObject.Properties.Name -contains 'text') { return $first.text }
        }
    }
    # Real CLI schema nests the incremental delta one level deeper, under .event.delta.text
    # (a top-level stream_event envelope wraps the actual Anthropic streaming event) --
    # checking only a top-level .delta.text (as an earlier version of this script did)
    # silently returns null for every stream_event and produces a false "no streaming" result.
    if ($e.PSObject.Properties.Name -contains 'event' -and $null -ne $e.event) {
        $inner = $e.event
        if ($inner.PSObject.Properties.Name -contains 'delta' -and $null -ne $inner.delta) {
            if ($inner.delta.PSObject.Properties.Name -contains 'text') { return $inner.delta.text }
        }
    }
    return $null
}

function Write-Result {
    $Report | ConvertTo-Json -Depth 15 | Set-Content -Path $ResultPath -Encoding utf8
}

Write-Host "Hubi -- Phase 0 Reasoning Engine Validation (PowerShell, no Node.js)`n"

# 1/7 Auth
Write-Host "1/7 Checking Claude Code authentication..."
$authRes = Invoke-Claude -Arguments @("auth", "status") -TimeoutMs 15000
$authParsed = Try-ParseJson $authRes.Stdout
$loggedIn = $authParsed.loggedIn -eq $true
$Report.checks.auth = [ordered]@{
    loggedIn = $loggedIn
    raw      = if ($authParsed) { $authParsed } else { $authRes.Stdout.Trim() }
    stderr   = $authRes.Stderr.Trim()
}
if (-not $loggedIn) {
    $Report.overall = "BLOCKED - not authenticated"
    $Report.notes += "``claude auth status`` did not report loggedIn:true. Run ``claude auth login`` on this machine, then re-run this script."
    Write-Result
    Write-Host "`n[FAIL] Not logged in. Fix authentication and re-run. See phase0-result.json for details."
    exit 1
}
Write-Host "   OK logged in"

# 2/7 Minimal non-interactive invocation
Write-Host "2/7 Minimal non-interactive invocation..."
$minArgs = @(
    "-p", "Reply with exactly this text and nothing else: HUBI_PHASE0_OK",
    "--output-format", "json",
    "--system-prompt", $SystemPrompt
) + $IsolationArgs
$minRes = Invoke-Claude -Arguments $minArgs -TimeoutMs 45000
$minParsed = Try-ParseJson $minRes.Stdout
$minimalOk = ($minParsed.subtype -eq "success") -and ("$($minParsed.result)".Contains("HUBI_PHASE0_OK"))
$Report.checks.minimalInvocation = [ordered]@{
    pass       = $minimalOk
    durationMs = $minRes.DurationMs
    subtype    = $minParsed.subtype
    isError    = $minParsed.is_error
    resultText = $minParsed.result
    stderr     = $minRes.Stderr.Trim()
}
Write-Host $(if ($minimalOk) { "   OK pass" } else { "   FAIL -- see phase0-result.json" })

# 3/7 Streaming behavior + tool/MCP isolation
Write-Host "3/7 Streaming behavior + tool/MCP isolation..."
$streamArgs = @(
    "-p", "Count from one to five, one number per short sentence.",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--system-prompt", $SystemPrompt
) + $IsolationArgs
$streamRes = Invoke-Claude -Arguments $streamArgs -TimeoutMs 45000
$events = Parse-Ndjson $streamRes.Stdout

$init = $events | Where-Object { $_.type -eq "system" -and $_.subtype -eq "init" } | Select-Object -First 1
$toolsEmpty = $null -ne $init -and $init.tools -is [System.Array] -and $init.tools.Count -eq 0
$mcpEmpty = $null -ne $init -and $init.mcp_servers -is [System.Array] -and $init.mcp_servers.Count -eq 0

$chunkEvents = $events | Where-Object { $_.type -eq "assistant" -or $_.type -eq "stream_event" }
$textSnapshots = New-Object System.Collections.Generic.HashSet[string]
foreach ($e in $chunkEvents) {
    $t = Get-EventText $e
    if ($t) { [void]$textSnapshots.Add($t) }
}
$resultEvent = $events | Where-Object { $_.type -eq "result" } | Select-Object -First 1
$realStreamingObserved = ($chunkEvents.Count -gt 1) -and ($textSnapshots.Count -gt 1)

$Report.checks.streamingAndIsolation = [ordered]@{
    toolsEmpty             = $toolsEmpty
    mcpEmpty               = $mcpEmpty
    initToolsSeen          = $init.tools
    initMcpServersSeen     = $init.mcp_servers
    totalEvents            = $events.Count
    chunkEventCount        = $chunkEvents.Count
    distinctTextSnapshots  = $textSnapshots.Count
    realStreamingObserved  = $realStreamingObserved
    resultSuccess          = $resultEvent.subtype -eq "success"
    durationMs             = $streamRes.DurationMs
    stderr                 = $streamRes.Stderr.Trim()
}
Write-Host "   tools disabled: $(if ($toolsEmpty) {'yes'} else {'NO'}), mcp disabled: $(if ($mcpEmpty) {'yes'} else {'NO'})"
Write-Host "   real incremental streaming observed: $(if ($realStreamingObserved) {'YES'} else {'no (will need fallback)'})"

# 4/7 No file access (secondary sanity check only -- NOT proof of isolation; the init event above is the proof)
Write-Host "4/7 Secondary sanity check: does Claude report no file/tool access..."
$noAccessArgs = @(
    "-p", "Can you list files in the current directory, read any file, or use any tool right now? Answer with only YES or NO, then a 5-word reason.",
    "--output-format", "json",
    "--system-prompt", $SystemPrompt
) + $IsolationArgs
$noAccessRes = Invoke-Claude -Arguments $noAccessArgs -TimeoutMs 30000
$noAccessParsed = Try-ParseJson $noAccessRes.Stdout
$answersNo = "$($noAccessParsed.result)".Trim() -match '(?i)^no\b'
$Report.checks.noFileAccessSanityCheck = [ordered]@{
    pass       = $answersNo
    resultText = $noAccessParsed.result
    stderr     = $noAccessRes.Stderr.Trim()
    note       = "Secondary sanity check only. Isolation is actually proven by checks.streamingAndIsolation.toolsEmpty/mcpEmpty (the CLI's own init event), not by this self-report."
}
Write-Host $(if ($answersNo) { "   OK pass" } else { "   FAIL -- Claude did not clearly say it has no access, check manually" })

# 5/7 Representative latency
Write-Host "5/7 Measuring representative latency..."
$sampleKnowledge = "Sample retrieved knowledge chunk. " * 120
$prompts = @(
    "In one sentence, what is Hubi?",
    "Given this context, summarize it in one sentence:`n`n$sampleKnowledge"
)
$timings = @()
foreach ($p in $prompts) {
    $r = Invoke-Claude -Arguments (@("-p", $p, "--output-format", "json", "--system-prompt", $SystemPrompt) + $IsolationArgs) -TimeoutMs 45000
    $timings += $r.DurationMs
}
$Report.checks.latency = [ordered]@{ samples = $timings; unit = "ms" }
Write-Host "   samples (ms): $($timings -join ', ')"

# 6/7 Multi-turn continuity via explicit re-sent context
Write-Host "6/7 Multi-turn continuity via explicit re-sent context (not CLI session resume)..."
$turn1Args = @(
    "-p", "Remember this for later: the secret code is 4271. Reply with exactly: NOTED",
    "--output-format", "json",
    "--system-prompt", $SystemPrompt
) + $IsolationArgs
$turn1 = Invoke-Claude -Arguments $turn1Args -TimeoutMs 30000
$turn1Parsed = Try-ParseJson $turn1.Stdout
$turn1Result = if ($turn1Parsed.result) { $turn1Parsed.result } else { "NOTED" }

$followUpPrompt = "Conversation so far:`nUser: Remember this for later: the secret code is 4271. Reply with exactly: NOTED`n" +
                  "Assistant: $turn1Result`n`n" +
                  "User: What was the secret code I told you? Reply with only the number."
$turn2Args = @("-p", $followUpPrompt, "--output-format", "json", "--system-prompt", $SystemPrompt) + $IsolationArgs
$turn2 = Invoke-Claude -Arguments $turn2Args -TimeoutMs 30000
$turn2Parsed = Try-ParseJson $turn2.Stdout
$rememberedCorrectly = "$($turn2Parsed.result)".Contains("4271")
$Report.checks.multiTurnViaExplicitContext = [ordered]@{
    pass           = $rememberedCorrectly
    turn2ResultText = $turn2Parsed.result
}
Write-Host $(if ($rememberedCorrectly) { "   OK pass" } else { "   FAIL -- see phase0-result.json" })

# 7/7 Error and timeout handling
Write-Host "7/7 Error and timeout handling..."
$badModelArgs = @("-p", "hello", "--model", "not-a-real-model-xyz", "--output-format", "json") + $IsolationArgs
$badModel = Invoke-Claude -Arguments $badModelArgs -TimeoutMs 20000
$badModelParsed = Try-ParseJson $badModel.Stdout
$cleanErrorOnBadModel = ($badModel.Code -ne 0) -or ($badModelParsed.is_error -eq $true)

$forcedTimeoutArgs = @("-p", "Write a very long, detailed 2000 word essay about enterprise SaaS sales.", "--output-format", "json") + $IsolationArgs
$forcedTimeout = Invoke-Claude -Arguments $forcedTimeoutArgs -TimeoutMs 1500

$Report.checks.errorAndTimeoutHandling = [ordered]@{
    cleanErrorOnBadModel = $cleanErrorOnBadModel
    badModelExitCode     = $badModel.Code
    badModelIsError      = $badModelParsed.is_error
    timeoutWasCaught     = $forcedTimeout.TimedOut -eq $true
}
$errorHandlingOk = $cleanErrorOnBadModel -and ($forcedTimeout.TimedOut -eq $true)
Write-Host $(if ($errorHandlingOk) { "   OK pass" } else { "   FAIL -- see phase0-result.json" })

$allCoreChecksPassed = $minimalOk -and $toolsEmpty -and $mcpEmpty -and $answersNo -and $rememberedCorrectly -and $errorHandlingOk
$Report.overall = if ($allCoreChecksPassed) { "PASS" } else { "PASS WITH ISSUES -- review phase0-result.json" }
$Report.reasoningEngineMode = if ($realStreamingObserved) { "stream" } else { "progressive-reveal-fallback" }

Write-Result

Write-Host "`n--------------------------------------------"
Write-Host "Overall: $($Report.overall)"
Write-Host "Recommended Reasoning Engine mode: $($Report.reasoningEngineMode)"
Write-Host "Full report written to: $ResultPath"

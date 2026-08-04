[CmdletBinding()]
param(
    [ValidateSet("Console", "Markdown", "Json")]
    [string]$Format = "Console",

    [string]$OutputPath,

    [switch]$SelfTest,

    [switch]$IncludeUntracked,

    [ValidateRange(1, 1000)]
    [int]$MaxConsolePerRule = 25
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# AUDIT (deep-audit 2026-08-04): Scanner chỉ tạo ứng viên điều tra.
# Một hit không phải bug, không có severity và không được dùng làm release gate.
$script:RuleDescriptions = [ordered]@{
    "UNIT_INTEGER_ROUNDING" = "Làm tròn số nguyên nằm gần đại lượng mm hoặc PDF page box."
    "MAGIC_UNIT_CONVERSION" = "Hệ số đổi pt/mm/px được viết bằng số trực tiếp thay vì helper/hằng số chung."
    "SWALLOWED_ERROR" = "Nhánh catch/except có dấu hiệu nuốt lỗi mà không báo, ném lại hoặc ghi nhận."
    "STATIC_OR_TEST_SUPPRESSION" = "Type-check hoặc test bị bỏ qua/tắt bằng directive."
    "PDFIUM_THREAD_WITHOUT_GUARD" = "Callable cùng file được dispatch sang thread, chạm PDFium nhưng không thấy pdfium_guard."
    "RESOURCE_CAP_WITHOUT_RAM_SIGNAL" = "Cap worker/cache/queue có số cố định nhưng file không thể hiện tín hiệu RAM gate."
    "SCATTERED_FEATURE_GATE" = "So sánh Free/Pro/license trực tiếp ngoài các nguồn entitlement chuẩn."
    "RELEASE_ONLY_BRANCH" = "Nhánh chỉ chạy ở dev/production/release cần test riêng trên artifact tương ứng."
}

function Get-RepositoryRoot {
    $fallback = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $gitRoot = & git -C $fallback rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $gitRoot) {
        return ([string]$gitRoot).Trim()
    }
    return $fallback
}

function Get-LineNumber {
    param(
        [string]$Text,
        [int]$Index
    )

    if ($Index -le 0) {
        return 1
    }
    return ([regex]::Matches($Text.Substring(0, $Index), "`n").Count + 1)
}

function Get-ShortEvidence {
    param([AllowEmptyString()][string]$Text)

    $compact = ([regex]::Replace($Text.Trim(), "\s+", " "))
    if ($compact.Length -gt 180) {
        return ($compact.Substring(0, 177) + "...")
    }
    return $compact
}

function Get-FileScope {
    param([string]$Path)

    if ($Path -match '(?i)(^|/)(tests?|__tests__|fixtures|golden)(/|$)|\.(test|spec)\.') {
        return "test"
    }
    if ($Path -match '(?i)(^|/)(scripts?|src-tauri)(/|$)|(^|/)(build|release)[^/]*\.(ps1|bat|cmd)$|Cargo\.toml$') {
        return "build"
    }
    return "source"
}

function New-AuditFinding {
    param(
        [string]$RuleId,
        [string]$Path,
        [int]$Line,
        [string]$Scope,
        [string]$Evidence,
        [string]$Message
    )

    return [pscustomobject][ordered]@{
        status = "[SUSPECTED]"
        ruleId = $RuleId
        path = $Path
        line = $Line
        scope = $Scope
        message = $Message
        evidence = (Get-ShortEvidence -Text $Evidence)
    }
}

function Add-RegexMatches {
    param(
        [System.Collections.Generic.List[object]]$Findings,
        [string]$RuleId,
        [string]$Path,
        [string]$Scope,
        [string]$Text,
        [string]$Pattern,
        [string]$Message,
        [System.Text.RegularExpressions.RegexOptions]$Options = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )

    foreach ($match in [regex]::Matches($Text, $Pattern, $Options)) {
        $Findings.Add((New-AuditFinding `
            -RuleId $RuleId `
            -Path $Path `
            -Line (Get-LineNumber -Text $Text -Index $match.Index) `
            -Scope $Scope `
            -Evidence $match.Value `
            -Message $Message)) | Out-Null
    }
}

function Get-PythonFunctionBody {
    param(
        [string]$Text,
        [string]$FunctionName
    )

    $escapedName = [regex]::Escape($FunctionName)
    $definition = [regex]::Match($Text, "(?m)^(?<indent>[ \t]*)(?:async[ \t]+)?def[ \t]+$escapedName[ \t]*\([^\r\n]*\)[^\r\n]*:[ \t]*(?:#.*)?$")
    if (-not $definition.Success) {
        return $null
    }

    $lineEnd = $Text.IndexOf("`n", $definition.Index + $definition.Length)
    if ($lineEnd -lt 0) {
        return ""
    }

    $bodyStart = $lineEnd + 1
    $cursor = $bodyStart
    $definitionIndent = $definition.Groups["indent"].Value.Length
    while ($cursor -lt $Text.Length) {
        $nextLineEnd = $Text.IndexOf("`n", $cursor)
        if ($nextLineEnd -lt 0) {
            $nextLineEnd = $Text.Length
        }
        $line = $Text.Substring($cursor, $nextLineEnd - $cursor).TrimEnd("`r")
        if ($line.Trim()) {
            $leading = [regex]::Match($line, '^[ \t]*').Value.Length
            if ($leading -le $definitionIndent -and -not $line.TrimStart().StartsWith("#")) {
                break
            }
        }
        if ($nextLineEnd -ge $Text.Length) {
            $cursor = $Text.Length
            break
        }
        $cursor = $nextLineEnd + 1
    }

    return $Text.Substring($bodyStart, $cursor - $bodyStart)
}

function Invoke-ContentAudit {
    param(
        [string]$Path,
        [AllowEmptyString()][string]$Text
    )

    $pathNormalized = $Path.Replace("\", "/")
    $scope = Get-FileScope -Path $pathNormalized
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $lines = [regex]::Split($Text, "\r?\n")
    $canonicalGateFiles = @(
        "backend/app/core/feature_entitlements.py",
        "desktop/src/lib/license/features.ts",
        "desktop/src/hooks/useToolActivationGuard.ts"
    )
    $fileHasRamSignal = $Text -match '(?i)(psutil\.virtual_memory|total_memory|available_memory|ram_gb|memory_gb|system_memory|hardware_profile|memory_tier|max_active_heavy_jobs|low_memory|resource_profile)'

    for ($index = 0; $index -lt $lines.Length; $index++) {
        $line = $lines[$index]
        $trimmed = $line.Trim()
        if (-not $trimmed) {
            continue
        }

        $isPureComment = $trimmed -match '^(//|/\*|\*|<!--|#(?!\s*\[\s*cfg))'

        if ($scope -ne "test" -and -not $isPureComment) {
            $hasIntegerRounding = $line -match '(?i)(Math\.(round|floor|ceil|trunc)|\b(round|floor|ceil|int|parseInt)\s*\(|\.toFixed\s*\(\s*0\s*\)|:\.0f)'
            $hasDimensionSignal = $line -match '(?i)(\bmm\b|_mm\b|Mm\b|millimet|PT_PER_MM|MM_PER_PT|(media|crop|trim|bleed)_?box|page_?(width|height))'
            $hasRasterSignal = $line -match '(?i)(canvas|bitmap|raster|pixel|\bpx\b|mmToPx|renderScale|devicePixelRatio|\bdpr\b)'
            if ($hasIntegerRounding -and $hasDimensionSignal -and -not $hasRasterSignal) {
                $findings.Add((New-AuditFinding `
                    -RuleId "UNIT_INTEGER_ROUNDING" `
                    -Path $pathNormalized `
                    -Line ($index + 1) `
                    -Scope $scope `
                    -Evidence $line `
                    -Message "Kiểm xem phép làm tròn chỉ phục vụ hiển thị hay đã làm mất độ chính xác của hợp đồng/artifact.")) | Out-Null
            }

            $hasMagicConversion = $line -match '(?i)(72(?:\.0+)?\s*/\s*25\.4|25\.4\s*/\s*72(?:\.0+)?|96(?:\.0+)?\s*/\s*25\.4|25\.4\s*/\s*96(?:\.0+)?|2\.8346\d*|0\.3527\d*)'
            $definesNamedConversion = $line -match '(?i)\b(PT_PER_MM|MM_PER_PT|PX_PER_MM|MM_PER_PX)\b\s*(=|:)'
            if ($hasMagicConversion -and -not $definesNamedConversion) {
                $findings.Add((New-AuditFinding `
                    -RuleId "MAGIC_UNIT_CONVERSION" `
                    -Path $pathNormalized `
                    -Line ($index + 1) `
                    -Scope $scope `
                    -Evidence $line `
                    -Message "Đối chiếu helper/hằng số chung và chiều đổi đơn vị; số trực tiếp dễ gây drift giữa preview và file xuất.")) | Out-Null
            }

            $hasNumericCap = $line -match '(?i)\b(max_workers|max_concurrency|worker_count|worker_limit|Semaphore|BoundedSemaphore|cache_size|max_cache|queue_size|chunk_size)\b[^\r\n]{0,80}(=|:|\()[^\r\n]{0,40}\b[1-9]\d?\b'
            if ($hasNumericCap -and -not $fileHasRamSignal) {
                $findings.Add((New-AuditFinding `
                    -RuleId "RESOURCE_CAP_WITHOUT_RAM_SIGNAL" `
                    -Path $pathNormalized `
                    -Line ($index + 1) `
                    -Scope $scope `
                    -Evidence $line `
                    -Message "Kiểm call chain xem cap có được RAM-gate ở nơi khác hay đang hard-cap cả máy mạnh.")) | Out-Null
            }

            if ($canonicalGateFiles -notcontains $pathNormalized) {
                $directGate = $line -match '(?i)((plan|tier|license|subscription|entitlement|is_?pro|isPro)[^\r\n]{0,80}(===?|!==?|==|!=|\bin\b)[^\r\n]{0,40}["''](free|pro|trial|enterprise)["'']|localStorage[^\r\n]{0,60}(license|plan|pro))'
                if ($directGate) {
                    $findings.Add((New-AuditFinding `
                        -RuleId "SCATTERED_FEATURE_GATE" `
                        -Path $pathNormalized `
                        -Line ($index + 1) `
                        -Scope $scope `
                        -Evidence $line `
                        -Message "Xác minh đây chỉ là consumer hiển thị hay một nguồn quyết định entitlement bị rải rác.")) | Out-Null
                }
            }

            $releaseBranch = $line -match '(?i)(import\.meta\.env\.(PROD|DEV)|process\.env\.NODE_ENV|cfg!\s*\(\s*debug_assertions|#\s*\[\s*cfg\s*\(\s*(not\s*\(\s*)?debug_assertions|sys\.frozen|__compiled__|__nuitka__|if[^\r\n]{0,100}\$(Release|Production)\b)'
            if ($releaseBranch) {
                $findings.Add((New-AuditFinding `
                    -RuleId "RELEASE_ONLY_BRANCH" `
                    -Path $pathNormalized `
                    -Line ($index + 1) `
                    -Scope $scope `
                    -Evidence $line `
                    -Message "Ghi nhánh này vào ma trận dev/release; test dev không chứng minh được nhánh production và ngược lại.")) | Out-Null
            }
        }

        $hasStaticDirective = $line -match '(?i)(@ts-nocheck|@ts-ignore|@ts-expect-error|#\s*type:\s*ignore|^\s*#\s*\[\s*ignore(?:\s*=.*?)?\s*\])'
        $hasTestSuppression = -not $isPureComment -and $line -match '(?i)(\b(describe|it|test)\.(skip|skipIf|todo)\s*\(|\b(xit|xdescribe)\s*\(|\bpytest\.(skip|xfail)\s*\(|\bpytest\.mark\.(skip|skipif|xfail)\b|@unittest\.(skip|skipIf|skipUnless))'
        if ($hasStaticDirective -or $hasTestSuppression) {
            $findings.Add((New-AuditFinding `
                -RuleId "STATIC_OR_TEST_SUPPRESSION" `
                -Path $pathNormalized `
                -Line ($index + 1) `
                -Scope $scope `
                -Evidence $line `
                -Message "Xác minh lý do, phạm vi và điều kiện gỡ suppression/skip; không mặc định coi đây là bug.")) | Out-Null
        }
    }

    Add-RegexMatches `
        -Findings $findings `
        -RuleId "SWALLOWED_ERROR" `
        -Path $pathNormalized `
        -Scope $scope `
        -Text $Text `
        -Pattern '(\.catch\s*\(\s*(\([^)]*\)|\w*)?\s*=>\s*(\{\s*\}|undefined|null|false)\s*\)|catch\s*(\([^)]*\))?\s*\{\s*(//[^\r\n]*)?\s*\})' `
        -Message "Nhánh lỗi rỗng/câm có thể che lỗi runtime; đọc caller trước khi kết luận." `
        -Options ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Singleline)

    Add-RegexMatches `
        -Findings $findings `
        -RuleId "SWALLOWED_ERROR" `
        -Path $pathNormalized `
        -Scope $scope `
        -Text $Text `
        -Pattern '^[ \t]*except([^\r\n:]*)?:[ \t]*(#.*)?\r?\n[ \t]+(pass|return[ \t]+None)\b' `
        -Message "except đang bỏ qua lỗi hoặc trả None; xác minh hợp đồng lỗi của caller." `
        -Options ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Multiline)

    if ($scope -ne "test" -and $pathNormalized -match '\.py$') {
        $dispatchPattern = '(?i)(?:(?:asyncio\.to_thread|run_in_threadpool)\s*\(\s*(?<callee>[A-Za-z_][\w.]*)|anyio\.to_thread\.run_sync\s*\(\s*(?<callee>[A-Za-z_][\w.]*)|run_in_executor\s*\(\s*[^,\r\n]+,\s*(?<callee>[A-Za-z_][\w.]*))'
        foreach ($dispatch in [regex]::Matches($Text, $dispatchPattern)) {
            $callee = $dispatch.Groups["callee"].Value
            if (-not $callee) {
                continue
            }

            $windowStart = [Math]::Max(0, $dispatch.Index - 300)
            $nearDispatch = $Text.Substring($windowStart, $dispatch.Index - $windowStart + $dispatch.Length)
            if ($nearDispatch -match '(?i)(pdfium_guard|PDFIUM_PY_LOCK)') {
                continue
            }

            $directPdfiumCallee = $callee -match '(?i)(^|\.)(PdfDocument|FPDF_[A-Za-z0-9_]+)$'
            $functionName = ($callee -split '\.')[-1]
            $functionBody = if ($directPdfiumCallee) { $callee } else { Get-PythonFunctionBody -Text $Text -FunctionName $functionName }
            if ($null -eq $functionBody) {
                continue
            }

            $bodyUsesPdfium = $functionBody -match '(?i)(pypdfium2\.PdfDocument|pdfium\.PdfDocument|pdfium_c\.FPDF[A-Za-z0-9_]*|\bFPDF_[A-Za-z0-9_]+)'
            $bodyHasGuard = $functionBody -match '(?i)(pdfium_guard|PDFIUM_PY_LOCK)'
            if (($directPdfiumCallee -or $bodyUsesPdfium) -and -not $bodyHasGuard) {
                $findings.Add((New-AuditFinding `
                    -RuleId "PDFIUM_THREAD_WITHOUT_GUARD" `
                    -Path $pathNormalized `
                    -Line (Get-LineNumber -Text $Text -Index $dispatch.Index) `
                    -Scope $scope `
                    -Evidence $dispatch.Value `
                    -Message "Scanner chỉ resolve callable cùng file; trace wrapper/call chain rồi mới xác nhận và giữ vùng khóa PDFium ngắn.")) | Out-Null
            }
        }
    }

    return $findings.ToArray()
}

function Invoke-GitPathQuery {
    param(
        [string]$RepositoryRoot,
        [string[]]$Arguments
    )

    $allArguments = @("-C", $RepositoryRoot) + $Arguments
    $quotedArguments = foreach ($argument in $allArguments) {
        '"' + $argument.Replace('"', '\"') + '"'
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "git"
    $startInfo.Arguments = ($quotedArguments -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $startInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $startInfo.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "Git thất bại ($($process.ExitCode)): $stderr"
    }
    return @($stdout.Split([char]0, [System.StringSplitOptions]::RemoveEmptyEntries))
}

function Test-ExcludedAuditPath {
    param([string]$Path)

    $excludedPattern = '(?i)(^|/)(attic|node_modules|target|venv(?:-[^/]+)?|\.venv|dist|build|coverage|vendor|third_party|poppler|Ban_Phat_Hanh|uploads|results|tmp|sandbox|public|assets|artifacts?|golden|fixtures|__snapshots__|generated)(/|$)|\.bundle\.js$|\.min\.(js|css)$|\.snap$|(^|/)desktop/src/i18n/locales/|(^|/)scripts/i18n_(add|fill|apply|patch|gen)'
    return ($Path -match $excludedPattern)
}

function Get-AuditFileInventory {
    param([string]$RepositoryRoot)

    $scanPaths = @(
        "backend/app",
        "backend/tests",
        "desktop/src",
        "desktop/src-tauri/src",
        "desktop/src-tauri/Cargo.toml",
        "native/src",
        "native/Cargo.toml",
        "imposition_core/src",
        "imposition_core/Cargo.toml",
        "print_engine/src",
        "print_engine/Cargo.toml",
        ".github/workflows",
        "scripts",
        "desktop/package.json",
        "desktop/src-tauri/tauri.conf.json",
        "Cargo.toml",
        "build_production.ps1",
        "run_dev.bat",
        "release_update.ps1",
        "quanly_phathanh.ps1",
        "PRYNX.bat",
        "PHAT_HANH.bat"
    )

    $trackedPaths = @(Invoke-GitPathQuery -RepositoryRoot $RepositoryRoot -Arguments (@("ls-files", "-z", "--cached", "--") + $scanPaths))
    $gitPaths = New-Object 'System.Collections.Generic.List[string]'
    foreach ($trackedPath in $trackedPaths) {
        $gitPaths.Add($trackedPath) | Out-Null
    }
    if ($IncludeUntracked) {
        $untrackedPaths = @(Invoke-GitPathQuery -RepositoryRoot $RepositoryRoot -Arguments (@("ls-files", "-z", "--others", "--exclude-standard", "--") + $scanPaths))
        foreach ($untrackedPath in $untrackedPaths) {
            $gitPaths.Add($untrackedPath) | Out-Null
        }
    }

    $allowedExtensions = @(".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".ps1", ".psm1", ".bat", ".cmd", ".toml", ".json", ".yml", ".yaml")
    $files = New-Object 'System.Collections.Generic.List[object]'
    $excluded = 0
    $missingTracked = 0

    foreach ($candidate in ($gitPaths.ToArray() | Sort-Object -Unique)) {
        $relative = ([string]$candidate).Replace("\", "/")
        if (-not $relative -or $relative -eq "scripts/audit_contracts.ps1") {
            $excluded++
            continue
        }
        if (Test-ExcludedAuditPath -Path $relative) {
            $excluded++
            continue
        }
        $extension = [System.IO.Path]::GetExtension($relative)
        if ($allowedExtensions -notcontains $extension) {
            $excluded++
            continue
        }

        $fullPath = Join-Path $RepositoryRoot $relative
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            if ($trackedPaths -contains $candidate) {
                $missingTracked++
            }
            $excluded++
            continue
        }
        $item = Get-Item -LiteralPath $fullPath
        if ($item.Length -gt 2MB) {
            $excluded++
            continue
        }

        $firstLines = @([System.IO.File]::ReadLines($item.FullName) | Select-Object -First 5) -join "`n"
        if ($firstLines -match '(?i)(@generated|DO NOT EDIT|automatically generated)') {
            $excluded++
            continue
        }

        $files.Add([pscustomobject]@{
            path = $relative
            fullPath = $item.FullName
        }) | Out-Null
    }

    return [pscustomobject]@{
        files = $files.ToArray()
        excludedCount = $excluded
        enumeratedCount = @($gitPaths.ToArray() | Sort-Object -Unique).Count
        missingTracked = $missingTracked
        sourceMode = if ($IncludeUntracked) { "tracked-working-tree-plus-untracked" } else { "tracked-working-tree" }
    }
}

function Convert-ToMarkdownReport {
    param([pscustomobject]$Report)

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.AppendLine("# Ứng viên audit hợp đồng PrynX")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("> Tất cả kết quả dưới đây là ``[SUSPECTED]``. Chúng chưa phải bug, chưa có severity và chưa được phép tự động sửa.")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("- Thời điểm: ``$($Report.generatedAt)``")
    [void]$builder.AppendLine("- File đã quét: **$($Report.scannedFiles)**")
    [void]$builder.AppendLine("- File đã loại: **$($Report.excludedFiles)**")
    [void]$builder.AppendLine("- Tracked bị thiếu trên đĩa: **$($Report.missingTracked)**")
    [void]$builder.AppendLine("- Commit: ``$($Report.commit)``; worktree dirty: ``$($Report.worktreeDirty)``")
    [void]$builder.AppendLine("- Tổng ứng viên: **$($Report.findingCount)**")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("## Tổng hợp theo rule")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("| Rule | Số lượng | Ý nghĩa |")
    [void]$builder.AppendLine("|---|---:|---|")
    foreach ($summary in $Report.countsByRule) {
        $description = ([string]$summary.description).Replace("|", "\|")
        [void]$builder.AppendLine("| ``$($summary.ruleId)`` | $($summary.count) | $description |")
    }
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("## Danh sách ứng viên")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("| Trạng thái | Rule | Vị trí | Scope | Bằng chứng | Việc cần xác minh |")
    [void]$builder.AppendLine("|---|---|---|---|---|---|")
    foreach ($finding in $Report.findings) {
        $evidence = ([string]$finding.evidence).Replace("|", "\|")
        $message = ([string]$finding.message).Replace("|", "\|")
        [void]$builder.AppendLine("| ``$($finding.status)`` | ``$($finding.ruleId)`` | ``$($finding.path):$($finding.line)`` | $($finding.scope) | ``$evidence`` | $message |")
    }
    return $builder.ToString()
}

function Convert-ToConsoleReport {
    param(
        [pscustomobject]$Report,
        [int]$PerRuleLimit
    )

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.AppendLine("PrynX contract audit - chỉ là [SUSPECTED]")
    [void]$builder.AppendLine("Đã quét $($Report.scannedFiles) file; loại $($Report.excludedFiles); có $($Report.findingCount) ứng viên.")
    foreach ($summary in $Report.countsByRule) {
        [void]$builder.AppendLine(("  {0,-38} {1,5}" -f $summary.ruleId, $summary.count))
    }
    foreach ($summary in $Report.countsByRule) {
        $ruleFindings = @($Report.findings | Where-Object { $_.ruleId -eq $summary.ruleId } | Select-Object -First $PerRuleLimit)
        foreach ($finding in $ruleFindings) {
            [void]$builder.AppendLine()
            [void]$builder.AppendLine("$($finding.status) $($finding.ruleId) $($finding.path):$($finding.line) [$($finding.scope)]")
            [void]$builder.AppendLine("  $($finding.message)")
            [void]$builder.AppendLine("  $($finding.evidence)")
        }
        if ($summary.count -gt $ruleFindings.Count) {
            [void]$builder.AppendLine("  ... còn $($summary.count - $ruleFindings.Count) ứng viên $($summary.ruleId); dùng Markdown/Json để xem đủ.")
        }
    }
    return $builder.ToString()
}

function Invoke-ScannerSelfTest {
    $cases = @(
        @{ name = "rounding-mm"; path = "desktop/src/sample.ts"; text = "const widthMm = Math.round(inputMm);"; expected = @("UNIT_INTEGER_ROUNDING"); absent = @(); expectedLine = 1 },
        @{ name = "rounding-pixel"; path = "desktop/src/sample.ts"; text = "const px = Math.round(mmToPx(widthMm));"; expected = @(); absent = @("UNIT_INTEGER_ROUNDING") },
        @{ name = "magic-unit"; path = "backend/app/sample.py"; text = "points = width_mm * 72 / 25.4"; expected = @("MAGIC_UNIT_CONVERSION"); absent = @() },
        @{ name = "named-unit-constant"; path = "desktop/src/units.ts"; text = "const PT_PER_MM = 72 / 25.4;"; expected = @(); absent = @("MAGIC_UNIT_CONVERSION") },
        @{ name = "empty-catch"; path = "desktop/src/sample.ts"; text = "work().catch(() => {});"; expected = @("SWALLOWED_ERROR"); absent = @() },
        @{ name = "except-pass"; path = "backend/app/sample.py"; text = "try:`n    work()`nexcept Exception:`n    pass"; expected = @("SWALLOWED_ERROR"); absent = @() },
        @{ name = "test-skip"; path = "desktop/src/sample.test.ts"; text = "test.skip('later', () => {});"; expected = @("STATIC_OR_TEST_SUPPRESSION"); absent = @() },
        @{ name = "ts-nocheck"; path = "desktop/src/legacy.ts"; text = "// @ts-nocheck"; expected = @("STATIC_OR_TEST_SUPPRESSION"); absent = @() },
        @{ name = "pdfium-thread"; path = "backend/app/sample.py"; text = "import pypdfium2`n`ndef render_pdf():`n    return pypdfium2.PdfDocument('x.pdf')`n`nasync def work():`n    return await asyncio.to_thread(render_pdf)"; expected = @("PDFIUM_THREAD_WITHOUT_GUARD"); absent = @() },
        @{ name = "pdfium-guarded"; path = "backend/app/sample.py"; text = "import pypdfium2`n`ndef render_pdf():`n    with pdfium_guard():`n        return pypdfium2.PdfDocument('x.pdf')`n`nasync def work():`n    return await asyncio.to_thread(render_pdf)"; expected = @(); absent = @("PDFIUM_THREAD_WITHOUT_GUARD") },
        @{ name = "pdfium-process-pool"; path = "backend/app/sample.py"; text = "import pypdfium2`nexecutor = ProcessPoolExecutor()`nexecutor.submit(pypdfium2.PdfDocument, 'x.pdf')"; expected = @(); absent = @("PDFIUM_THREAD_WITHOUT_GUARD") },
        @{ name = "resource-cap"; path = "backend/app/sample.py"; text = "max_workers = 4"; expected = @("RESOURCE_CAP_WITHOUT_RAM_SIGNAL"); absent = @() },
        @{ name = "ram-gated-cap"; path = "backend/app/sample.py"; text = "ram_gb = total_memory()`nmax_workers = 4 if ram_gb < 8 else cpu_count()"; expected = @(); absent = @("RESOURCE_CAP_WITHOUT_RAM_SIGNAL") },
        @{ name = "feature-gate"; path = "desktop/src/sample.ts"; text = "if (licenseTier === 'pro') enableTool();"; expected = @("SCATTERED_FEATURE_GATE"); absent = @() },
        @{ name = "release-only"; path = "desktop/src/sample.ts"; text = "if (import.meta.env.PROD) startSidecar();"; expected = @("RELEASE_ONLY_BRANCH"); absent = @() },
        @{ name = "rust-iterator-skip"; path = "native/src/sample.rs"; text = "values.iter().skip(1);"; expected = @(); absent = @("STATIC_OR_TEST_SUPPRESSION") },
        @{ name = "unicode-crlf-line"; path = "desktop/src/đo-kích-thước.ts"; text = "const note = 'ok';`r`nconst widthMm = Math.round(inputMm);"; expected = @("UNIT_INTEGER_ROUNDING"); absent = @(); expectedLine = 2 }
    )

    $failures = New-Object 'System.Collections.Generic.List[string]'
    foreach ($case in $cases) {
        $findings = @(Invoke-ContentAudit -Path $case.path -Text $case.text)
        $ids = @($findings | ForEach-Object { $_.ruleId } | Sort-Object -Unique)
        foreach ($expectedRule in $case.expected) {
            if ($ids -notcontains $expectedRule) {
                $failures.Add("$($case.name): thiếu $expectedRule") | Out-Null
            }
        }
        foreach ($absentRule in $case.absent) {
            if ($ids -contains $absentRule) {
                $failures.Add("$($case.name): báo nhầm $absentRule") | Out-Null
            }
        }
        if ($case.ContainsKey("expectedLine") -and $case.expected.Count -gt 0) {
            $lineFinding = $findings | Where-Object { $_.ruleId -eq $case.expected[0] } | Select-Object -First 1
            if (-not $lineFinding -or $lineFinding.line -ne $case.expectedLine) {
                $actualLine = if ($lineFinding) { $lineFinding.line } else { "missing" }
                $failures.Add("$($case.name): line $actualLine, cần $($case.expectedLine)") | Out-Null
            }
        }
        foreach ($finding in $findings) {
            if ($finding.status -ne "[SUSPECTED]" -or $finding.PSObject.Properties.Name -contains "severity") {
                $failures.Add("$($case.name): schema finding không hợp lệ") | Out-Null
            }
        }
    }

    $fixtureFindings = @($cases | ForEach-Object { Invoke-ContentAudit -Path $_.path -Text $_.text }) | Sort-Object ruleId, path, line, evidence
    $firstPass = $fixtureFindings | ConvertTo-Json -Depth 5
    $secondPass = @($cases | ForEach-Object { Invoke-ContentAudit -Path $_.path -Text $_.text }) | Sort-Object ruleId, path, line, evidence | ConvertTo-Json -Depth 5
    if ($firstPass -ne $secondPass) {
        $failures.Add("Kết quả không deterministic") | Out-Null
    }
    try {
        $null = $firstPass | ConvertFrom-Json
    }
    catch {
        $failures.Add("JSON không parse ngược được") | Out-Null
    }

    $formatReport = [pscustomobject][ordered]@{
        generatedAt = "2026-08-04T00:00:00+07:00"
        commit = "selftest"
        worktreeDirty = $true
        scannedFiles = 1
        excludedFiles = 0
        missingTracked = 0
        findingCount = 1
        countsByRule = @([pscustomobject]@{
            ruleId = $fixtureFindings[0].ruleId
            count = 1
            description = $script:RuleDescriptions[$fixtureFindings[0].ruleId]
        })
        findings = @($fixtureFindings[0])
    }
    $markdownSample = Convert-ToMarkdownReport -Report $formatReport
    $consoleSample = Convert-ToConsoleReport -Report $formatReport -PerRuleLimit 1
    if ($markdownSample -notmatch 'Ứng viên audit hợp đồng PrynX' -or $markdownSample -notmatch '\[SUSPECTED\]') {
        $failures.Add("Renderer Markdown không giữ cảnh báo SUSPECTED") | Out-Null
    }
    if ($consoleSample -notmatch 'chỉ là \[SUSPECTED\]' -or $consoleSample -notmatch $fixtureFindings[0].ruleId) {
        $failures.Add("Renderer Console không giữ cảnh báo/rule") | Out-Null
    }
    try {
        $jsonSample = $formatReport | ConvertTo-Json -Depth 6
        $parsedSample = $jsonSample | ConvertFrom-Json
        if ($parsedSample.findings[0].status -ne "[SUSPECTED]") {
            throw "Sai status JSON"
        }
    }
    catch {
        $failures.Add("Renderer JSON không parse/status đúng") | Out-Null
    }
    if (-not (Test-ExcludedAuditPath -Path "native/src/generated/bundle.js") -or -not (Test-ExcludedAuditPath -Path "desktop/src/i18n/locales/vi.json")) {
        $failures.Add("Bộ lọc generated/i18n không hoạt động") | Out-Null
    }

    if ($failures.Count -gt 0) {
        throw ("Self-test thất bại:`n- " + ($failures -join "`n- "))
    }
    Write-Output "[OK] audit_contracts.ps1 self-test: $($cases.Count) ca."
}

if ($SelfTest) {
    try {
        Invoke-ScannerSelfTest
        return
    }
    catch {
        Write-Error $_
        exit 2
    }
}

$repoRoot = Get-RepositoryRoot
$inventory = Get-AuditFileInventory -RepositoryRoot $repoRoot
$commitOutput = @(Invoke-GitPathQuery -RepositoryRoot $repoRoot -Arguments @("rev-parse", "--short", "HEAD"))
$commit = if ($commitOutput.Count -gt 0) { ([string]$commitOutput[0]).Trim() } else { "unknown" }
$dirtyOutput = @(Invoke-GitPathQuery -RepositoryRoot $repoRoot -Arguments @("status", "--porcelain", "--untracked-files=no"))
$worktreeDirty = ($dirtyOutput.Count -gt 0 -and ([string]$dirtyOutput[0]).Trim().Length -gt 0)
$allFindings = New-Object 'System.Collections.Generic.List[object]'
$readFailures = 0

foreach ($file in $inventory.files) {
    try {
        $content = [System.IO.File]::ReadAllText($file.fullPath)
        foreach ($finding in (Invoke-ContentAudit -Path $file.path -Text $content)) {
            $allFindings.Add($finding) | Out-Null
        }
    }
    catch {
        $readFailures++
        Write-Warning "Không đọc được $($file.path): $($_.Exception.Message)"
    }
}

$sortedFindings = @($allFindings.ToArray() | Sort-Object ruleId, path, line, evidence -Unique)
$counts = foreach ($ruleId in $script:RuleDescriptions.Keys) {
    [pscustomobject][ordered]@{
        ruleId = $ruleId
        count = @($sortedFindings | Where-Object { $_.ruleId -eq $ruleId }).Count
        description = $script:RuleDescriptions[$ruleId]
    }
}

$report = [pscustomobject][ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::Now.ToString("o")
    status = "[SUSPECTED_ONLY]"
    sourceMode = $inventory.sourceMode
    repositoryRoot = $repoRoot
    commit = $commit
    worktreeDirty = $worktreeDirty
    enumeratedFiles = $inventory.enumeratedCount
    scannedFiles = @($inventory.files).Count - $readFailures
    excludedFiles = $inventory.excludedCount
    missingTracked = $inventory.missingTracked
    readFailures = $readFailures
    findingCount = $sortedFindings.Count
    countsByRule = @($counts)
    findings = @($sortedFindings)
}

switch ($Format) {
    "Markdown" { $rendered = Convert-ToMarkdownReport -Report $report }
    "Json" { $rendered = $report | ConvertTo-Json -Depth 6 }
    default { $rendered = Convert-ToConsoleReport -Report $report -PerRuleLimit $MaxConsolePerRule }
}

if ($OutputPath) {
    $targetPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $repoRoot $OutputPath }
    $parent = Split-Path -Parent $targetPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($targetPath, $rendered, $utf8NoBom)
    Write-Output "Đã ghi báo cáo: $targetPath"
}
else {
    Write-Output $rendered
}

# Có ứng viên vẫn exit 0: scanner không được biến nghi vấn thành gate chặn build.

# ============================================================
# PrynX release regression gate
# Runs every automated test suite used by the shipped desktop app.
# ASCII-only for Windows PowerShell 5 compatibility.
# ============================================================

param(
    [switch]$ReusePassedNoGs
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$PYTHON = "$ROOT\backend\venv\Scripts\python.exe"
$NPM_CACHE = Join-Path ([System.IO.Path]::GetTempPath()) "prynx-npm-cache"
$FRONTEND_QA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ("prynx-frontend-qa-" + [guid]::NewGuid().ToString("N"))
$NO_GS_CORPUS = if ($env:PRYNX_NO_GS_CORPUS) {
    $env:PRYNX_NO_GS_CORPUS
} else {
    Join-Path $ROOT "private_test_corpus\incoming"
}
$NO_GS_AUDIT_OUT = if ($env:PRYNX_NO_GS_AUDIT_OUT) {
    [System.IO.Path]::GetFullPath($env:PRYNX_NO_GS_AUDIT_OUT)
} else {
    Join-Path $ROOT "tmp\release_no_gs_audit.json"
}
$NO_GS_PASSED_CACHE = Join-Path $ROOT "tmp\release_no_gs_passed_cache.json"
$NO_GS_PASSED_ARTIFACT = Join-Path $ROOT "tmp\release_no_gs_passed_artifact.json"
$NO_GS_EXPECTED_FILES = 18
$NO_GS_EXPECTED_OPERATIONS = 16
$NO_GS_ARTIFACT_SCHEMA = 3
$NO_GS_FINGERPRINT_ALGORITHM = "sha256-content-v2"

function Add-NoGsFingerprintFile {
    param(
        [Parameter(Mandatory = $true)]$Rows,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "No-GS fingerprint input missing: $Label"
    }
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$Rows.Add("file|$Label|$hash")
}

function Get-NoGsReusableFingerprint {
    # BUILD (audit 2026-08-12 REL.NO_GS.REUSE): fingerprint logic nghiep vu thay
    # vi hash wheel moi build. Metadata commit/timestamp lam wheel doi byte du UI
    # thuan tuy khong doi engine; cac source/runtime/toolchain ben duoi van fail-closed.
    $rows = New-Object System.Collections.Generic.List[string]
    $staticFiles = @(
        @{ Path = "$ROOT\scripts\gs_dependency_audit.py"; Label = "scripts/gs_dependency_audit.py" },
        @{ Path = "$ROOT\scripts\run_release_qa.ps1"; Label = "scripts/run_release_qa.ps1" },
        @{ Path = "$ROOT\build_production.ps1"; Label = "build_production.ps1" },
        @{ Path = "$ROOT\backend\requirements.txt"; Label = "backend/requirements.txt" },
        @{ Path = "$ROOT\backend\requirements-win-gpu.txt"; Label = "backend/requirements-win-gpu.txt" },
        @{ Path = "$ROOT\native\Cargo.toml"; Label = "native/Cargo.toml" },
        @{ Path = "$ROOT\native\Cargo.lock"; Label = "native/Cargo.lock" },
        @{ Path = "$ROOT\imposition_core\Cargo.toml"; Label = "imposition_core/Cargo.toml" },
        @{ Path = "$ROOT\imposition_core\Cargo.lock"; Label = "imposition_core/Cargo.lock" },
        @{ Path = "$ROOT\print_engine\Cargo.toml"; Label = "print_engine/Cargo.toml" },
        @{ Path = "$ROOT\print_engine\Cargo.lock"; Label = "print_engine/Cargo.lock" },
        @{ Path = "$ROOT\native\pdfium.dll"; Label = "native/pdfium.dll" }
    )
    $cargoConfig = Join-Path $ROOT ".cargo\config.toml"
    if (Test-Path -LiteralPath $cargoConfig -PathType Leaf) {
        $staticFiles += @{ Path = $cargoConfig; Label = ".cargo/config.toml" }
    }
    foreach ($entry in $staticFiles) {
        Add-NoGsFingerprintFile -Rows $rows -Path $entry.Path -Label $entry.Label
    }

    foreach ($crateRoot in @("$ROOT\native", "$ROOT\imposition_core", "$ROOT\print_engine")) {
        foreach ($buildScript in @(Get-ChildItem -LiteralPath $crateRoot -Filter "build.rs" -File -ErrorAction SilentlyContinue)) {
            $label = $buildScript.FullName.Substring($ROOT.Length).TrimStart('\').Replace('\', '/')
            Add-NoGsFingerprintFile -Rows $rows -Path $buildScript.FullName -Label $label
        }
    }

    foreach ($sourceRoot in @(
        "$ROOT\backend\app",
        "$ROOT\native\src",
        "$ROOT\native\pdfium_lib",
        "$ROOT\imposition_core\src",
        "$ROOT\print_engine\src"
    )) {
        if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
            throw "No-GS source root missing: $sourceRoot"
        }
        foreach ($file in @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse |
                Where-Object {
                    $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and
                    $_.Extension -notin @('.pyc', '.pyo')
                } | Sort-Object FullName)) {
            $label = $file.FullName.Substring($ROOT.Length).TrimStart('\').Replace('\', '/')
            Add-NoGsFingerprintFile -Rows $rows -Path $file.FullName -Label $label
        }
    }

    # Python `sorted(Path.glob())` so theo ordinal code point; PowerShell mac dinh
    # dung culture/case-insensitive nen co the chon sai 18/33 file corpus.
    $corpusJson = @(& $PYTHON -c "import json,pathlib,sys; print(json.dumps([str(p.resolve()) for p in sorted(pathlib.Path(sys.argv[1]).glob('*.pdf'))[:int(sys.argv[2])]]))" $NO_GS_CORPUS $NO_GS_EXPECTED_FILES 2>$null)
    if ($LASTEXITCODE -ne 0 -or $corpusJson.Count -ne 1) {
        throw "Cannot resolve the exact Python-sorted No-GS corpus subset."
    }
    $resolvedCorpusPaths = $corpusJson[0] | ConvertFrom-Json
    $corpusFiles = @($resolvedCorpusPaths | ForEach-Object { Get-Item -LiteralPath ([string]$_) })
    if ($corpusFiles.Count -ne $NO_GS_EXPECTED_FILES) {
        throw "No-GS reusable fingerprint requires exactly $NO_GS_EXPECTED_FILES corpus files."
    }
    for ($index = 0; $index -lt $corpusFiles.Count; $index++) {
        Add-NoGsFingerprintFile -Rows $rows -Path $corpusFiles[$index].FullName `
            -Label ("corpus/{0:D2}" -f $index)
    }

    $runtimeFacts = @(& $PYTHON -c "import json,sys; sys.path.insert(0,sys.argv[1]); from scripts.gs_dependency_audit import _runtime_distribution_facts, _runtime_platform_facts; rows=[x.split(':',1)[1] for x in _runtime_distribution_facts()]; rows=sorted(set(x for x in rows if not x.startswith('pdfcompare-native=='))); print(json.dumps({'platform':_runtime_platform_facts(),'distributions':rows},sort_keys=True,separators=(',',':')))" $ROOT 2>$null)
    if ($LASTEXITCODE -ne 0 -or $runtimeFacts.Count -ne 1) {
        throw "Cannot fingerprint Python runtime distributions for No-GS reuse."
    }
    [void]$rows.Add("runtime|$($runtimeFacts[0])")

    $runtimeModulePaths = @(& $PYTHON -c "import importlib.util,json,pathlib,sys; paths={pathlib.Path(sys.executable),pathlib.Path(getattr(sys,'_base_executable',sys.executable))}; base=pathlib.Path(sys.base_prefix); paths.update(base.glob('python3*.dll')); [(paths.add(pathlib.Path(s.origin)) if s and s.origin and s.origin not in {'built-in','frozen'} else None, paths.update(p for root in (s.submodule_search_locations or ()) for p in pathlib.Path(root).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix.lower() not in {'.pyc','.pyo'})) for s in (importlib.util.find_spec(n) for n in ('pypdfium2','pypdfium2_raw'))]; print(json.dumps(sorted(str(p.resolve()) for p in paths if p.is_file())))" 2>$null)
    if ($LASTEXITCODE -ne 0 -or $runtimeModulePaths.Count -ne 1) {
        throw "Cannot inventory Python/PDFium runtime files for No-GS reuse."
    }
    $runtimeModuleIndex = 0
    $resolvedRuntimePaths = $runtimeModulePaths[0] | ConvertFrom-Json
    foreach ($runtimePath in $resolvedRuntimePaths) {
        Add-NoGsFingerprintFile -Rows $rows -Path ([string]$runtimePath) `
            -Label ("runtime/python-pdfium/{0:D4}/{1}" -f $runtimeModuleIndex, (Split-Path -Leaf ([string]$runtimePath)))
        $runtimeModuleIndex++
    }
    if ($runtimeModuleIndex -eq 0) {
        throw "Python/PDFium runtime inventory is empty."
    }

    Push-Location "$ROOT\backend"
    try {
        $configFacts = @(& $PYTHON -c "import json; from app.config import settings; names=('PRYNX_PPE_MEMORY_BUDGET_MB','ICC_PROFILE_DIR','DEFAULT_CMYK_PROFILE','IS_DESKTOP_APP','DEV_MODE'); print(json.dumps({n:str(getattr(settings,n,'')) for n in names},sort_keys=True,separators=(',',':')))" 2>$null)
        $configFactsExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($configFactsExit -ne 0 -or $configFacts.Count -ne 1) {
        throw "Cannot fingerprint resolved No-GS runtime settings."
    }
    [void]$rows.Add("config|$($configFacts[0])")
    $resolvedConfig = $configFacts[0] | ConvertFrom-Json
    $iccDir = [string]$resolvedConfig.ICC_PROFILE_DIR
    if (-not [string]::IsNullOrWhiteSpace($iccDir)) {
        if (-not (Test-Path -LiteralPath $iccDir -PathType Container)) {
            throw "Resolved ICC_PROFILE_DIR does not exist."
        }
        $iccIndex = 0
        foreach ($iccFile in @(Get-ChildItem -LiteralPath $iccDir -File -Recurse | Sort-Object FullName)) {
            Add-NoGsFingerprintFile -Rows $rows -Path $iccFile.FullName `
                -Label ("runtime/icc/{0:D4}/{1}" -f $iccIndex, $iccFile.Name)
            $iccIndex++
        }
        if ($iccIndex -eq 0) { throw "Resolved ICC_PROFILE_DIR is empty." }
    }

    foreach ($name in @(
        "PRYNX_PPE_MEMORY_BUDGET_MB",
        "PRYNX_OUTLINE_TRUST_PPE",
        "PRYNX_DETECT_RASTER_MAX",
        "PRYNX_MAX_HEAVY_JOBS",
        "PDFIUM_DLL_PATH",
        "PDFIUM_PLATFORM",
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "RAYON_NUM_THREADS",
        "LANG",
        "LC_ALL"
    )) {
        [void]$rows.Add("env|$name=$([Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process))")
    }

    $rustcFacts = @(& rustc -Vv 2>$null)
    $rustcExit = $LASTEXITCODE
    $cargoFacts = @(& cargo -V 2>$null)
    $cargoExit = $LASTEXITCODE
    if ($rustcExit -ne 0 -or $cargoExit -ne 0 -or $rustcFacts.Count -eq 0 -or $cargoFacts.Count -ne 1) {
        throw "Cannot fingerprint Rust toolchain for No-GS reuse."
    }
    [void]$rows.Add("rustc|$(($rustcFacts -join '|').Trim())")
    [void]$rows.Add("cargo|$($cargoFacts[0].Trim())")
    [void]$rows.Add("build|rustflags=-C target-cpu=x86-64-v2|lto=thin|codegen-units=1|strip=symbols")
    [void]$rows.Add("contract|files=$NO_GS_EXPECTED_FILES|operations=$NO_GS_EXPECTED_OPERATIONS|timeout=180")

    $payload = [string]::Join("`n", @($rows | Sort-Object))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-NoGsPassedArtifact {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $artifact = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ([int]$artifact.schema_version -ne $NO_GS_ARTIFACT_SCHEMA -or
            [string]$artifact.fingerprint_algorithm -ne $NO_GS_FINGERPRINT_ALGORITHM -or
            $artifact.provenance_valid -ne $true) {
            return $false
        }
        $corpus = @($artifact.corpus)
        $files = @($artifact.files.PSObject.Properties)
        $summary = @($artifact.summary.PSObject.Properties)
        if ($corpus.Count -ne $NO_GS_EXPECTED_FILES -or
            $files.Count -ne $NO_GS_EXPECTED_FILES -or
            $summary.Count -ne $NO_GS_EXPECTED_OPERATIONS) {
            return $false
        }
        $corpusSet = @{}
        foreach ($key in $corpus) { $corpusSet[[string]$key] = $true }
        $summarySet = @{}
        foreach ($operation in $summary) { $summarySet[[string]$operation.Name] = $true }
        foreach ($file in $files) {
            if (-not $corpusSet.ContainsKey([string]$file.Name)) { return $false }
            $records = @($file.Value.PSObject.Properties)
            if ($records.Count -ne $NO_GS_EXPECTED_OPERATIONS) { return $false }
            foreach ($record in $records) {
                if (-not $summarySet.ContainsKey([string]$record.Name)) { return $false }
                if ([string]$record.Value.status -notin @("OK", "REFUSED")) { return $false }
            }
        }
        foreach ($operation in $summary) {
            $accepted = 0
            foreach ($status in @("OK", "REFUSED")) {
                $count = $operation.Value.PSObject.Properties[$status]
                if ($null -ne $count) { $accepted += [int]$count.Value }
            }
            if ($accepted -ne $NO_GS_EXPECTED_FILES) { return $false }
            foreach ($blocking in @("GS", "ERROR", "TIMEOUT")) {
                $count = $operation.Value.PSObject.Properties[$blocking]
                if ($null -ne $count -and [int]$count.Value -gt 0) { return $false }
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Test-NoGsPassedCache {
    param([Parameter(Mandatory = $true)][string]$ExpectedFingerprint)

    if (-not (Test-Path -LiteralPath $NO_GS_PASSED_CACHE -PathType Leaf) -or
        -not (Test-Path -LiteralPath $NO_GS_PASSED_ARTIFACT -PathType Leaf)) {
        return $false
    }
    try {
        $cache = Get-Content -LiteralPath $NO_GS_PASSED_CACHE -Raw | ConvertFrom-Json
        if ([int]$cache.schema_version -ne 1 -or
            $cache.passed -ne $true -or
            [string]$cache.input_fingerprint -ne $ExpectedFingerprint -or
            [int]$cache.files -ne $NO_GS_EXPECTED_FILES -or
            [int]$cache.operations -ne $NO_GS_EXPECTED_OPERATIONS) {
            return $false
        }
        $artifactHash = (Get-FileHash -LiteralPath $NO_GS_PASSED_ARTIFACT -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($artifactHash -ne [string]$cache.artifact_sha256) { return $false }
        return Test-NoGsPassedArtifact -Path $NO_GS_PASSED_ARTIFACT
    } catch {
        return $false
    }
}

function Save-NoGsPassedCache {
    param(
        [Parameter(Mandatory = $true)][string]$InputFingerprint,
        [Parameter(Mandatory = $true)][string]$AuditArtifact
    )

    if (-not (Test-NoGsPassedArtifact -Path $AuditArtifact)) {
        throw "No-GS artifact is not a complete 18 x 16 passing result."
    }
    $artifactTemp = $NO_GS_PASSED_ARTIFACT + ".tmp"
    Copy-Item -LiteralPath $AuditArtifact -Destination $artifactTemp -Force
    Move-Item -LiteralPath $artifactTemp -Destination $NO_GS_PASSED_ARTIFACT -Force
    $artifactHash = (Get-FileHash -LiteralPath $NO_GS_PASSED_ARTIFACT -Algorithm SHA256).Hash.ToLowerInvariant()
    $cache = [ordered]@{
        schema_version = 1
        passed = $true
        input_fingerprint = $InputFingerprint
        files = $NO_GS_EXPECTED_FILES
        operations = $NO_GS_EXPECTED_OPERATIONS
        artifact_sha256 = $artifactHash
        verified_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $cacheTemp = $NO_GS_PASSED_CACHE + ".tmp"
    $json = $cache | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($cacheTemp, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $cacheTemp -Destination $NO_GS_PASSED_CACHE -Force
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )

    Write-Host "  [QA] $Label..." -ForegroundColor DarkGray
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

# BUILD (audit 2026-08-11 §REL.QA.UTF8): pytest fd-capture đọc theo UTF-8, còn
# ProcessPool con trên Windows có thể kế thừa code page hệ thống và ghi byte khác
# UTF-8 vào cùng handle. Ép đồng nhất encoding cho toàn bộ Python con rồi hoàn
# nguyên môi trường khi gate kết thúc hoặc thất bại.
$previousPythonIoEncoding = [Environment]::GetEnvironmentVariable(
    "PYTHONIOENCODING",
    [EnvironmentVariableTarget]::Process
)
try {
$env:PYTHONIOENCODING = "utf-8"

if (-not (Test-Path -LiteralPath $PYTHON)) {
    throw "Python venv not found: $PYTHON"
}

# BUILD (audit 2026-08-03 REL.09): when production staging is active, prove
# every Python/no-GS test imports the exact native wheel selected for Nuitka.
if (-not [string]::IsNullOrWhiteSpace($env:PRYNX_RELEASE_NATIVE_SITE)) {
    $expectedNativeSiteInput = [System.IO.Path]::GetFullPath($env:PRYNX_RELEASE_NATIVE_SITE).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $expectedNativeSiteInput -PathType Container)) {
        throw "Staged native site not found: $expectedNativeSiteInput"
    }

    # BUILD (audit 2026-08-03 REL.09): compare both paths after pathlib resolves
    # Windows 8.3 aliases (KHANHP~1) to their long form. GetFullPath alone does
    # not canonicalize that alias and previously rejected the correct staged wheel.
    $nativeOutput = @(& $PYTHON -c "import json, os, pathlib, pdfcompare_native; site=pathlib.Path(os.environ['PRYNX_RELEASE_NATIVE_SITE']).resolve(); package=pathlib.Path(pdfcompare_native.__file__).resolve().parent; print(json.dumps({'site': str(site), 'package': str(package), 'inside': package.is_relative_to(site)}))" 2>&1)
    if ($LASTEXITCODE -ne 0 -or $nativeOutput.Count -eq 0) {
        throw "Cannot import the staged pdfcompare_native package."
    }

    try {
        $nativeProbe = ([string]$nativeOutput[-1]) | ConvertFrom-Json
    } catch {
        throw "Cannot parse staged native import probe: $([string]$nativeOutput[-1])"
    }
    $expectedNativeSite = [string]$nativeProbe.site
    $actualNativePackage = [string]$nativeProbe.package
    if (-not [bool]$nativeProbe.inside) {
        throw "QA imported pdfcompare_native outside the staged wheel: $actualNativePackage"
    }
    Write-Host "  [QA] Native runtime pinned to staged wheel." -ForegroundColor Green
}

Invoke-Checked "Python dependency consistency" { & $PYTHON -m pip check }
Invoke-Checked "Preflight golden fixtures" { & "$ROOT\backend\scripts\run_preflight_qa.ps1" }
Invoke-Checked "Free-token entitlement E2E" { & "$ROOT\backend\scripts\run_free_token_e2e.ps1" }

Push-Location "$ROOT\backend"
try {
    Invoke-Checked "Backend test suite" { & $PYTHON -m pytest -q }
} finally {
    Pop-Location
}

# RELEASE QA (audit 2026-07-28): the no-GS product contract is corpus-backed.
# REFUSED is an intentional fail-closed outcome; GS and ERROR fail the release.
if (-not (Test-Path -LiteralPath $NO_GS_CORPUS)) {
    throw "No-GS corpus not found: $NO_GS_CORPUS (set PRYNX_NO_GS_CORPUS)"
}
$noGsReusableFingerprint = $null
$reuseNoGsPassed = $false
if ($ReusePassedNoGs) {
    try {
        $noGsReusableFingerprint = Get-NoGsReusableFingerprint
        $reuseNoGsPassed = Test-NoGsPassedCache -ExpectedFingerprint $noGsReusableFingerprint
    } catch {
        Write-Warning "Khong xac minh duoc cache PDF 18 x 16; tu dong chay lai day du."
    }
}
if ($reuseNoGsPassed) {
    Write-Host "  [QA] Da dung lai ket qua PDF 18 x 16 da dat; fingerprint van khop." -ForegroundColor Green
} elseif ($ReusePassedNoGs) {
    Write-Host "  [QA] Cache PDF 18 x 16 khong con khop/khong day du; tu dong chay lai." -ForegroundColor Yellow
}
$NO_GS_MAX_ATTEMPTS = 2
if (-not $reuseNoGsPassed) {
    $noGsExit = 1
    for ($noGsAttempt = 1; $noGsAttempt -le $NO_GS_MAX_ATTEMPTS; $noGsAttempt++) {
        Write-Host "  [QA] No-GS dependency gate (18 files x 16 operations), lan $noGsAttempt/$NO_GS_MAX_ATTEMPTS..." -ForegroundColor DarkGray
        & $PYTHON "$ROOT\scripts\gs_dependency_audit.py" $NO_GS_CORPUS `
            --limit 18 --gate --resume --out $NO_GS_AUDIT_OUT
        $noGsExit = $LASTEXITCODE
        if ($noGsExit -eq 0) { break }
        if ($noGsExit -ne 1 -or $noGsAttempt -eq $NO_GS_MAX_ATTEMPTS) { break }
        # BUILD (audit 2026-08-06 REL.NO_GS.RETRY): process con co the bi ngat thoang qua;
        # thu lai mot lan tren cung wheel/artifact va tiep tuc tu checkpoint operation.
        Write-Warning "No-GS gate bi ngat/that bai; thu lai mot lan tu checkpoint cung artifact."
    }
    if ($noGsExit -ne 0) {
        throw "No-GS dependency gate (18 files x 16 operations) failed with exit code $noGsExit"
    }
    try {
        if ([string]::IsNullOrWhiteSpace($noGsReusableFingerprint)) {
            $noGsReusableFingerprint = Get-NoGsReusableFingerprint
        }
        Save-NoGsPassedCache -InputFingerprint $noGsReusableFingerprint -AuditArtifact $NO_GS_AUDIT_OUT
    } catch {
        # Cache chi la toi uu cho lan sau; gate 18 x 16 vua dat van la bang chung goc.
        Write-Warning "PDF 18 x 16 da dat nhung khong luu duoc cache tai dung; lan sau se chay lai."
    }
}

# RELEASE QA (audit 2026-07-27): Windows dev servers keep native npm DLLs locked,
# so `npm ci` must not destructively replace the live desktop/node_modules tree.
# Copy the current frontend source to an isolated temp directory, install exactly
# from package-lock.json there, and run the suite against that clean install.
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$frontendQaFull = [System.IO.Path]::GetFullPath($FRONTEND_QA_DIR)
if (-not $frontendQaFull.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Frontend QA staging path escaped the temp root: $frontendQaFull"
}
New-Item -ItemType Directory -Path $frontendQaFull | Out-Null
$frontendQaDesktop = Join-Path $frontendQaFull "desktop"
$frontendQaNativeFixtures = Join-Path $frontendQaFull "native\tests\fixtures"
$frontendQaImpositionFixtures = Join-Path $frontendQaFull "imposition_core\tests\fixtures"
try {
    Write-Host "  [QA] Staging frontend source outside the live node_modules tree..." -ForegroundColor DarkGray
    & robocopy "$ROOT\desktop" $frontendQaDesktop /E /NFL /NDL /NJH /NJS /NP `
        /XD node_modules dist target binaries `
        /XF *.log
    $copyExit = $LASTEXITCODE
    if ($copyExit -gt 7) {
        throw "Frontend QA source staging failed with robocopy exit code $copyExit"
    }

    # nativeFixtureParity.test.ts resolves the native fixture through the
    # workspace sibling layout (`desktop/../native`), so preserve that contract.
    New-Item -ItemType Directory -Path $frontendQaNativeFixtures | Out-Null
    Copy-Item -LiteralPath "$ROOT\native\tests\fixtures\dieline_default_request.json" `
        -Destination $frontendQaNativeFixtures
    # NupGridSolver.parity.test.ts resolves the shared Rust oracle through the
    # same workspace-sibling contract; stage only the exact external fixture.
    New-Item -ItemType Directory -Path $frontendQaImpositionFixtures | Out-Null
    Copy-Item -LiteralPath "$ROOT\imposition_core\tests\fixtures\grid_parity_simple_auto.json" `
        -Destination $frontendQaImpositionFixtures

    Push-Location $frontendQaDesktop
    try {
        Invoke-Checked "Locked frontend dependencies (isolated)" {
            npm.cmd ci --no-audit --no-fund --cache $NPM_CACHE
        }
        Invoke-Checked "Frontend typecheck (isolated)" { npm.cmd run typecheck }
        Invoke-Checked "Frontend test suite (isolated)" { npm.cmd test }
    } finally {
        Pop-Location
    }
} finally {
    # Path was canonicalized and proven to be a direct descendant of Temp above.
    if (Test-Path -LiteralPath $frontendQaFull) {
        Remove-Item -LiteralPath $frontendQaFull -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Push-Location "$ROOT\imposition_core"
try {
    Invoke-Checked "Imposition core tests" { cargo test --locked }
    Invoke-Checked "Imposition core release compile" { cargo check --release --locked }
} finally {
    Pop-Location
}

Push-Location "$ROOT\print_engine"
try {
    Invoke-Checked "Print engine tests" { cargo test --locked }
    Invoke-Checked "Print engine release compile" { cargo check --release --locked }
} finally {
    Pop-Location
}

$previousPyo3Python = $env:PYO3_PYTHON
$previousPyo3EnvironmentSignature = $env:PYO3_ENVIRONMENT_SIGNATURE
$previousNativePath = $env:PATH
$nativePythonBase = (& $PYTHON -c "import sys; print(sys.base_prefix)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nativePythonBase)) {
    throw "Cannot resolve the base Python runtime for native tests: $nativePythonBase"
}
$nativePythonVersion = (& $PYTHON -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nativePythonVersion)) {
    throw "Cannot resolve the Python version for native tests."
}

# BUILD (audit 2026-08-03 REL.08): PyO3 test binaries load python3*.dll at
# runtime. Expose only this venv's base runtime while the native gate runs.
# pyo3-build-config intentionally tracks PYO3_ENVIRONMENT_SIGNATURE instead of
# PYO3_PYTHON, so bind the signature to this interpreter to invalidate stale
# cargo artifacts produced by another Python minor version.
$env:PYO3_PYTHON = $PYTHON
$env:PYO3_ENVIRONMENT_SIGNATURE = $PYTHON + "|" + $nativePythonVersion
$env:PATH = $nativePythonBase + [System.IO.Path]::PathSeparator + $previousNativePath
Push-Location "$ROOT\native"
try {
    Invoke-Checked "Native PDF tests" { cargo test --locked }
    Invoke-Checked "Native PDF release compile" { cargo check --release --locked }
} finally {
    Pop-Location
    $env:PATH = $previousNativePath
    if ($null -eq $previousPyo3Python) {
        Remove-Item Env:PYO3_PYTHON -ErrorAction SilentlyContinue
    } else {
        $env:PYO3_PYTHON = $previousPyo3Python
    }
    if ($null -eq $previousPyo3EnvironmentSignature) {
        Remove-Item Env:PYO3_ENVIRONMENT_SIGNATURE -ErrorAction SilentlyContinue
    } else {
        $env:PYO3_ENVIRONMENT_SIGNATURE = $previousPyo3EnvironmentSignature
    }
}

Push-Location "$ROOT\desktop\src-tauri"
try {
    Invoke-Checked "Tauri command tests" { cargo test --locked }
    Invoke-Checked "Tauri release compile" { cargo check --release --locked }
} finally {
    Pop-Location
}

Write-Host "  [QA] All release regression suites passed." -ForegroundColor Green
} finally {
    [Environment]::SetEnvironmentVariable(
        "PYTHONIOENCODING",
        $previousPythonIoEncoding,
        [EnvironmentVariableTarget]::Process
    )
}

param(
    [string]$OutputDir,
    [string]$ZoteroXpi,
    [string]$IsccPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'paths.ps1')
$source = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$workspace = Find-SoftwareWorkspace $source $manifest.version

if (-not $OutputDir) {
    $OutputDir = Join-Path $source 'dist'
    if ($workspace) {
        $software = Split-Path -Leaf (Split-Path -Parent $source)
        $OutputDir = Join-Path $workspace ('output\{0}\{1}' -f $software, $manifest.version)
    }
}
$OutputDir = [IO.Directory]::CreateDirectory($OutputDir).FullName
if (-not $ZoteroXpi) {
    $plugins = @(Get-ChildItem -LiteralPath $OutputDir -Filter 'Moye-Zotero-*.xpi' -File)
    if ($plugins.Count -ne 1) { throw 'Place one Moye-Zotero-*.xpi in the output directory or use -ZoteroXpi.' }
    $ZoteroXpi = $plugins[0].FullName
}
$ZoteroXpi = (Resolve-Path -LiteralPath $ZoteroXpi).Path
$IsccPath = Find-InnoCompiler $workspace $IsccPath
$icon = Join-Path $PSScriptRoot 'MoTex.ico'
$tempDir = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$scratch = Join-Path $tempDir ('Moye-build-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scratch)

Push-Location -LiteralPath $source
try {
    if (-not (Test-Path -LiteralPath $manifest.main -PathType Leaf)) { throw "Missing application entry: $($manifest.main)" }
    if (-not (Test-Path -LiteralPath 'renderer\ui.html' -PathType Leaf)) { throw 'Missing renderer\ui.html.' }
    $electronBin = & node -p "require('electron')"
    if ($LASTEXITCODE -ne 0) { throw 'Electron is unavailable. Run pnpm install --frozen-lockfile first.' }
    $electronDist = Split-Path -Parent ($electronBin | Select-Object -Last 1)
    $payload = Join-Path $scratch 'payload'
    Copy-Item -LiteralPath $electronDist -Destination $payload -Recurse
    Rename-Item -LiteralPath (Join-Path $payload 'electron.exe') -NewName 'Moye.exe'
    Rename-Item -LiteralPath (Join-Path $payload 'electron_wer.dll') -NewName 'Moye_wer.dll'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ChineseSimplified.LICENSE') -Destination (Join-Path $payload 'LICENSE-inno-zh.txt')
    $resources = Join-Path $payload 'resources'
    $defaultApp = Join-Path $resources 'default_app.asar'
    if (Test-Path -LiteralPath $defaultApp -PathType Leaf) { Remove-Item -LiteralPath $defaultApp }

    $appSource = Join-Path $scratch 'app'
    $stageRenderer = Join-Path $appSource 'renderer'
    $stagePackaging = Join-Path $appSource 'packaging'
    [void][IO.Directory]::CreateDirectory($stageRenderer)
    [void][IO.Directory]::CreateDirectory($stagePackaging)
    Copy-Item -LiteralPath 'package.json','desktop' -Destination $appSource -Recurse
    foreach ($notice in 'LICENSE','NOTICE','THIRD_PARTY_NOTICES') {
        if (Test-Path -LiteralPath $notice -PathType Leaf) { Copy-Item -LiteralPath $notice -Destination $appSource }
    }
    & pnpm prepare:editor
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare CodeMirror.' }
    Get-ChildItem -LiteralPath 'renderer' -Force |
        Where-Object { $_.Name -notin 'pdfjs', 'vendor' } |
        Copy-Item -Destination $stageRenderer -Recurse
    $stageVendor = Join-Path $stageRenderer 'vendor'
    [void][IO.Directory]::CreateDirectory($stageVendor)
    Copy-Item -LiteralPath 'renderer\vendor\codemirror.mjs','renderer\vendor\codemirror-LICENSES.txt' -Destination $stageVendor
    Copy-Item -LiteralPath $icon -Destination $stagePackaging
    & node (Join-Path $PSScriptRoot 'prepare-pdfjs.cjs') $stageRenderer
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare PDF.js.' }
    & pnpm exec asar pack $appSource (Join-Path $resources 'app.asar')
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the application archive.' }

    $zoteroDir = Join-Path $resources 'zotero'
    [void][IO.Directory]::CreateDirectory($zoteroDir)
    Copy-Item -LiteralPath $ZoteroXpi -Destination (Join-Path $zoteroDir 'Moye-Zotero.xpi')

    $rcedit = Join-Path $source 'node_modules\rcedit\bin\rcedit-x64.exe'
    & $rcedit (Join-Path $payload 'Moye.exe') --set-icon $icon `
        --set-file-version $manifest.version --set-product-version $manifest.version `
        --set-version-string ProductName 'MoTex' --set-version-string FileDescription 'MoTex' `
        --set-version-string InternalName 'Moye' --set-version-string OriginalFilename 'Moye.exe'
    if ($LASTEXITCODE -ne 0) { throw 'Could not set the application icon or version metadata.' }

    $outputName = "MoTex-$($manifest.version)-Setup-x64"
    & $IsccPath "/DProductVersion=$($manifest.version)" "/DPayloadDir=$payload" "/O$scratch" "/F$outputName" (Join-Path $PSScriptRoot 'Moye.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
    $installer = Join-Path $OutputDir "$outputName.exe"
    $candidate = Join-Path $OutputDir ('.' + $outputName + '-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Copy-Item -LiteralPath (Join-Path $scratch "$outputName.exe") -Destination $candidate
        if ([IO.File]::Exists($installer)) {
            [IO.File]::Replace($candidate, $installer, [NullString]::Value)
        } else {
            [IO.File]::Move($candidate, $installer)
        }
    } finally {
        if ([IO.File]::Exists($candidate)) { Remove-Item -LiteralPath $candidate }
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($installer)
    try {
        $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
        "SHA256 $hash  $installer"
    } finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
} finally {
    Pop-Location
    $resolved = (Resolve-Path -LiteralPath $scratch -ErrorAction SilentlyContinue).Path
    if ($resolved -and (Split-Path -Parent $resolved) -eq $tempDir.TrimEnd('\') -and (Split-Path -Leaf $resolved) -match '^Moye-build-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

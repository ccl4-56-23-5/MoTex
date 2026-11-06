param(
    [string]$OutputDir,
    [string]$ZoteroXpi
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
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
$output = (Resolve-Path -LiteralPath $OutputDir).Path
$installerName = "MoTex-$($manifest.version)-Setup-x64.exe"
$zipName = "MoTex-$($manifest.version)-Windows-x64.zip"
$installer = Join-Path $output $installerName
if (-not $ZoteroXpi) {
    $plugins = @(Get-ChildItem -LiteralPath $output -Filter 'Moye-Zotero-*.xpi' -File)
    if ($plugins.Count -ne 1) { throw 'Place one Moye-Zotero-*.xpi in the output directory or use -ZoteroXpi.' }
    $ZoteroXpi = $plugins[0].FullName
}
$ZoteroXpi = (Resolve-Path -LiteralPath $ZoteroXpi).Path
$pluginName = Split-Path -Leaf $ZoteroXpi
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($installer).ProductVersion.Trim() -ne $manifest.version) {
    throw 'The installer version does not match the source.'
}

function Read-Sha256([string]$file) {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($file)
        try { return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose() }
    } finally { $sha256.Dispose() }
}

function Publish-File([string]$candidate, [string]$destination) {
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($candidate, $destination, [NullString]::Value) }
    else { [IO.File]::Move($candidate, $destination) }
}

$tempRoot = [IO.Path]::GetTempPath().TrimEnd('\')
$token = [Guid]::NewGuid().ToString('N')
$scratch = Join-Path $tempRoot ("MoTex-release-$token")
$files = Join-Path $scratch 'files'
$extracted = Join-Path $scratch 'verified'
$temporaryZip = Join-Path $output (".$zipName-$token.tmp")
$temporarySums = Join-Path $output (".SHA256SUMS-$token.tmp")
[void][IO.Directory]::CreateDirectory($files)
try {
    Copy-Item -LiteralPath $installer,$ZoteroXpi,(Join-Path $PSScriptRoot 'Get-TeXLiveIso.ps1') -Destination $files
    $readme = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-readme.md') -Raw -Encoding UTF8
    $readme = $readme.Replace('{{version}}', $manifest.version).Replace('{{installer}}', $installerName).Replace('{{zotero}}', $pluginName)
    [IO.File]::WriteAllText((Join-Path $files 'README.md'), $readme, [Text.UTF8Encoding]::new($false))
    $items = @($installerName, $pluginName, 'Get-TeXLiveIso.ps1', 'README.md')
    $hashes = @{}
    foreach ($item in $items) { $hashes[$item] = Read-Sha256 (Join-Path $files $item) }
    @($items | ForEach-Object { "$($hashes[$_]) *$_" }) |
        Set-Content -LiteralPath (Join-Path $files 'SHA256SUMS.txt') -Encoding ascii
    $items += 'SHA256SUMS.txt'
    $hashes['SHA256SUMS.txt'] = Read-Sha256 (Join-Path $files 'SHA256SUMS.txt')

    [IO.Compression.ZipFile]::CreateFromDirectory($files, $temporaryZip, [IO.Compression.CompressionLevel]::Fastest, $false)
    [IO.Compression.ZipFile]::ExtractToDirectory($temporaryZip, $extracted)
    if (@(Get-ChildItem -LiteralPath $extracted -Recurse -File).Count -ne $items.Count) { throw 'Unexpected release ZIP file count.' }
    foreach ($item in $items) {
        if ((Read-Sha256 (Join-Path $extracted $item)) -ne $hashes[$item]) { throw "ZIP verification failed for $item." }
    }
    $zipHash = Read-Sha256 $temporaryZip
    @("$($hashes[$installerName]) *$installerName", "$($hashes[$pluginName]) *$pluginName", "$zipHash *$zipName") |
        Set-Content -LiteralPath $temporarySums -Encoding ascii

    $zip = Join-Path $output $zipName
    Publish-File $temporaryZip $zip
    Publish-File $temporarySums (Join-Path $output 'SHA256SUMS.txt')
    [pscustomobject]@{ archive = $zip; SHA256 = $zipHash; filesExtractedAndVerified = $items.Count }
} finally {
    foreach ($tempFile in $temporaryZip,$temporarySums) {
        if ([IO.File]::Exists($tempFile)) { Remove-Item -LiteralPath $tempFile }
    }
    $resolved = (Resolve-Path -LiteralPath $scratch -ErrorAction SilentlyContinue).Path
    if ($resolved -and (Split-Path -Parent $resolved) -eq $tempRoot -and (Split-Path -Leaf $resolved) -match '^MoTex-release-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

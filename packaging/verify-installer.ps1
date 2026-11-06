param(
    [Parameter(Mandatory = $true)][string]$SetupExe,
    [Parameter(Mandatory = $true)][string]$ZoteroXpi,
    [Parameter(Mandatory = $true)][string]$EvidenceDir,
    [string]$IsccPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'paths.ps1')
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D5640E24-B383-47DC-844A-53AD1692A194}_is1'
if (Test-Path -LiteralPath $registry) { throw 'Run the installation checks from a Windows user without Moye installed.' }

$setup = (Resolve-Path -LiteralPath $SetupExe).Path
$xpiHash = (Get-FileHash -LiteralPath $ZoteroXpi).Hash
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($setup).ProductVersion.Trim()
$evidence = [IO.Directory]::CreateDirectory($EvidenceDir).FullName
$workspace = Find-SoftwareWorkspace (Split-Path -Parent $PSScriptRoot) $version
$iscc = Find-InnoCompiler $workspace $IsccPath

$root = Join-Path ([IO.Path]::GetTempPath()) ('Moye-installer-check-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$firstDir = Join-Path $root 'First install'
$upgradeDir = Join-Path $root 'Non-default upgrade'
$fixtureFiles = Join-Path $root 'fixture'
[void][IO.Directory]::CreateDirectory($fixtureFiles)
$quiet = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-'

function Run-Process([string]$exe, [string]$arguments) {
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "$exe exited with code $($process.ExitCode)." }
}

function Check-Registration([string]$directory, [string]$expected) {
    $record = Get-ItemProperty -LiteralPath $registry
    if ($record.InstallLocation.TrimEnd('\') -ne $directory -or $record.DisplayVersion -ne $expected) {
        throw "Unexpected installation: $($record.InstallLocation), $($record.DisplayVersion)."
    }
    return $record
}

function Check-Files([string]$directory) {
    $exe = Join-Path $directory 'Moye.exe'
    $exeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion.Trim()
    if ($exeVersion -ne $version -and "$exeVersion.0" -ne $version -and $exeVersion -ne "$version.0") {
        throw "Unexpected Moye.exe version: $exeVersion."
    }
    $xpi = Join-Path $directory 'resources\zotero\Moye-Zotero.xpi'
    if ((Get-FileHash -LiteralPath $xpi).Hash -ne $xpiHash) { throw 'Installed Zotero XPI differs from the standalone XPI.' }
    if (-not (Test-Path -LiteralPath (Join-Path $directory 'resources\app.asar') -PathType Leaf)) { throw 'Missing app.asar.' }
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName.Trim() -ne 'MoTex') { throw 'Unexpected Windows product name.' }
    if (Get-ChildItem -LiteralPath $directory -Recurse -File | Where-Object Name -in 'xelatex.exe','latexmk.exe','tectonic.exe','pdflatex.exe','biber.exe') {
        throw 'Unexpected bundled TeX executable.'
    }
}

function Uninstall-QA([string]$label) {
    $current = Get-ItemProperty -LiteralPath $registry -ErrorAction SilentlyContinue
    if (-not $current) { return }
    $directory = $current.InstallLocation.TrimEnd('\')
    if ($directory -notin @($firstDir, $upgradeDir)) { throw "Refusing to uninstall outside the two QA paths: $directory" }
    $uninstaller = $current.UninstallString.Trim('"')
    $log = Join-Path $evidence "$label.log"
    Run-Process $uninstaller "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`"$log`""
    if (Test-Path -LiteralPath $registry) { throw 'Uninstall registration still exists.' }
}

try {
    $expectedVersion = $version
    $log = Join-Path $evidence 'first-install.log'
    Run-Process $setup "$quiet /DIR=`"$firstDir`" /LOG=`"$log`""
    [void](Check-Registration $firstDir $expectedVersion)
    Check-Files $firstDir
    Uninstall-QA 'first-uninstall'

    # The preceding portable baseline had no installer. Register a throwaway 0.2.0
    # fixture with the production AppId to exercise path recovery and replacement.
    Copy-Item -LiteralPath (Join-Path $env:windir 'System32\where.exe') -Destination (Join-Path $fixtureFiles 'Moye.exe')
    & $iscc /Qp '/DProductVersion=0.2.0' "/DPayloadDir=$fixtureFiles" "/O$root" '/Ffixture-0.2.0' (Join-Path $PSScriptRoot 'Moye.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the preceding-version fixture.' }
    $log = Join-Path $evidence 'previous-install.log'
    Run-Process (Join-Path $root 'fixture-0.2.0.exe') "$quiet /DIR=`"$upgradeDir`" /LOG=`"$log`""
    [void](Check-Registration $upgradeDir '0.2.0')
    $marker = Join-Path $upgradeDir 'user-preserved.txt'
    [IO.File]::WriteAllText($marker, 'User-managed file')
    $log = Join-Path $evidence 'upgrade.log'
    Run-Process $setup "$quiet /LOG=`"$log`""
    [void](Check-Registration $upgradeDir $expectedVersion)
    Check-Files $upgradeDir
    if ([IO.File]::ReadAllText($marker) -ne 'User-managed file') { throw 'The upgrade modified a user-managed file.' }
    Uninstall-QA 'upgrade-uninstall'

    [pscustomobject]@{
        version = $expectedVersion
        installerSHA256 = (Get-FileHash -LiteralPath $setup).Hash
        firstInstall = 'passed'
        overwriteFromTestFixture = 'passed'
        customDirectoryPreserved = $true
        independentFilePreserved = $true
        zoteroXpiSHA256 = $xpiHash
        bundledTexExecutables = $false
        testUninstalled = $true
    } | ConvertTo-Json | Tee-Object -FilePath (Join-Path $evidence 'installer-verification.json')
} finally {
    Uninstall-QA 'cleanup-uninstall'
    $resolved = (Resolve-Path -LiteralPath $root -ErrorAction SilentlyContinue).Path
    if ($resolved -and (Split-Path -Parent $resolved) -eq [IO.Path]::GetTempPath().TrimEnd('\') -and (Split-Path -Leaf $resolved) -match '^Moye-installer-check-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

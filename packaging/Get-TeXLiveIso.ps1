[CmdletBinding(DefaultParameterSetName = 'Download')]
param(
    [string]$Destination = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\TeXLive'),
    [Parameter(Mandatory, ParameterSetName = 'DryRun')][switch]$DryRun,
    [Parameter(Mandatory, ParameterSetName = 'CheckOnly')][switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$imageName = 'texlive2026-20260301.iso'
$imageBytes = 6784798720L
$officialSha512 = '4A9071BB567C3BDD6443378DEDC8E485AEA4A2F1203EC8ED7C17F6787093B9C37636A037032C0BE63352E3D0BF98CF5616DAB19FDCD7CB83F766B3E085B620FF'
$mirrors = @(
    'https://mirror.ctan.org/systems/texlive/Images',
    'https://tug.ctan.org/systems/texlive/Images'
)
if (-not [IO.Path]::IsPathRooted($Destination)) {
    $Destination = Join-Path (Get-Location).ProviderPath $Destination
}
$folder = [IO.Path]::GetFullPath($Destination)
$iso = Join-Path $folder $imageName

if ($DryRun) {
    [pscustomobject]@{
        Image = $iso
        Bytes = $imageBytes
        SHA512 = $officialSha512
        Mirror = "$($mirrors[0])/$imageName"
        Fallback = "$($mirrors[1])/$imageName"
    }
    return
}

$curl = (Get-Command curl.exe -CommandType Application -ErrorAction Stop).Source
# Disable curlrc and require HTTPS for the initial request and every redirect.
$curlOptions = @('-q', '--fail', '--location', '--show-error', '--proto', '=https',
    '--proto-redir', '=https', '--connect-timeout', '12', '--max-redirs', '5')

function Read-RemoteMetadata([string]$url) {
    $lines = & $curl @curlOptions --silent --max-time 25 --max-filesize 8192 $url
    if ($LASTEXITCODE -eq 0) { return ($lines -join "`n") }
    return $null
}

function Find-OfficialChecksum {
    $expectedName = [regex]::Escape($imageName)
    foreach ($mirror in $mirrors) {
        $url = "$mirror/$imageName.sha512"
        $content = Read-RemoteMetadata $url
        if ($content -match "(?im)^([0-9a-f]{128})[ `t]+\*?$expectedName\s*$" -and $Matches[1] -eq $officialSha512) {
            return $url
        }
    }
    throw 'The published TeX Live SHA-512 could not be reached or does not match the pinned release.'
}

function Test-Image([string]$path) {
    if ((Get-Item -LiteralPath $path).Length -ne $imageBytes) { return $false }
    $sha512 = [Security.Cryptography.SHA512]::Create()
    try {
        $stream = [IO.File]::OpenRead($path)
        try { $actual = [BitConverter]::ToString($sha512.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose() }
    } finally { $sha512.Dispose() }
    return $actual -eq $officialSha512
}

if ($CheckOnly) {
    $checksum = Find-OfficialChecksum
    $signature = Read-RemoteMetadata "$checksum.asc"
    foreach ($mirror in $mirrors) {
        $effective = & $curl @curlOptions --silent --max-time 25 --head --output NUL --write-out '%{url_effective}' "$mirror/$imageName"
        if ($LASTEXITCODE -eq 0) {
            [pscustomobject]@{
                Image = $effective
                Bytes = $imageBytes
                Checksum = $checksum
                SHA512 = $officialSha512
                SignaturePublished = $signature -match '-----BEGIN PGP SIGNATURE-----'
            }
            return
        }
    }
    throw 'The ISO could not be reached over HTTPS.'
}

[void][IO.Directory]::CreateDirectory($folder)
$partial = "$iso.part"
$lockPath = "$iso.lock"
$lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
try {
    if ([IO.File]::Exists($iso)) {
        if (-not (Test-Image $iso)) { throw "An existing ISO failed verification: $iso" }
        Write-Output $iso
        return
    }

    $checksum = Find-OfficialChecksum
    Write-Host "Verified official checksum from $checksum"
    $downloaded = 0L
    if ([IO.File]::Exists($partial)) { $downloaded = (Get-Item -LiteralPath $partial).Length }
    if ($downloaded -gt $imageBytes) { throw "The partial download is larger than the release image: $partial" }
    $driveRoot = [IO.Path]::GetPathRoot($folder)
    if ($driveRoot -match '^[a-zA-Z]:\\$') {
        $volume = [IO.DriveInfo]::new($driveRoot)
        if ($volume.DriveFormat -eq 'FAT32') { throw 'The ISO requires a volume that supports files larger than 4 GB.' }
        if ($volume.AvailableFreeSpace -lt ($imageBytes - $downloaded)) { throw 'The destination has insufficient free space.' }
    }

    if ($downloaded -lt $imageBytes) {
        foreach ($mirror in $mirrors) {
            $url = "$mirror/$imageName"
            Write-Host "Downloading from $url"
            $downloadOptions = @('--progress-bar', '--retry', '2', '--retry-delay', '2', '--continue-at', '-',
                '--max-filesize', $imageBytes, '--output', $partial)
            & $curl @curlOptions @downloadOptions $url
            if ([IO.File]::Exists($partial) -and (Get-Item -LiteralPath $partial).Length -eq $imageBytes) { break }
        }
    }
    if (-not [IO.File]::Exists($partial) -or (Get-Item -LiteralPath $partial).Length -ne $imageBytes) {
        throw "The download is incomplete. Run the script again to resume $partial"
    }
    Write-Host 'Verifying the complete ISO with SHA-512.'
    if (-not (Test-Image $partial)) { throw "SHA-512 verification failed. Move the invalid partial file before retrying: $partial" }
    [IO.File]::Move($partial, $iso)
    Write-Output $iso
} finally {
    $lock.Dispose()
}

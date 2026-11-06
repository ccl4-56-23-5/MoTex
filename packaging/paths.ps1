function Find-SoftwareWorkspace([string]$source, [string]$version) {
    $software = Split-Path -Parent $source
    if (-not $software -or (Split-Path -Leaf $source) -ne $version) { return $null }
    $sourceTree = Split-Path -Parent $software
    if (-not $sourceTree -or (Split-Path -Leaf $sourceTree) -ne 'source') { return $null }
    $workspace = Split-Path -Parent $sourceTree
    if ((Test-Path -LiteralPath (Join-Path $workspace 'AGENTS.md') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $workspace 'tool\Win') -PathType Container)) {
        return $workspace
    }
    return $null
}

function Find-InnoCompiler([string]$workspace, [string]$explicitPath) {
    if ($explicitPath) { return (Resolve-Path -LiteralPath $explicitPath).Path }
    $candidates = @()
    if ($workspace) { $candidates += Join-Path $workspace 'tool\Win\InnoSetup-6.7.4\ISCC.exe' }
    $installRoots = @(
        [Environment]::GetFolderPath('ProgramFilesX86')
        [Environment]::GetFolderPath('ProgramFiles')
        if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' }
    ) | Where-Object { $_ } | Select-Object -Unique
    foreach ($root in $installRoots) {
        $candidates += Join-Path $root 'Inno Setup 6\ISCC.exe'
        $candidates += Join-Path $root 'Inno Setup 7\ISCC.exe'
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command ISCC.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'Install Inno Setup or provide the ISCC.exe path with -IsccPath.'
}

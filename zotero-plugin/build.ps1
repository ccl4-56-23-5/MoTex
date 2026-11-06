[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $OutDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$files = @('manifest.json', 'bootstrap.js') + @($manifest.icons.PSObject.Properties.Value)
$output = [IO.Directory]::CreateDirectory($OutDirectory).FullName
$xpi = Join-Path $output "Moye-Zotero-$($manifest.version).xpi"
$temporaryXpi = Join-Path $output ('.moye-zotero-' + [Guid]::NewGuid().ToString('N') + '.tmp')

try {
    $archive = [IO.Compression.ZipFile]::Open($temporaryXpi, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $PSScriptRoot $file), $file)
        }
    }
    finally {
        $archive.Dispose()
    }
    Move-Item -LiteralPath $temporaryXpi -Destination $xpi -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryXpi) {
        Remove-Item -LiteralPath $temporaryXpi
    }
}

Get-Item -LiteralPath $xpi

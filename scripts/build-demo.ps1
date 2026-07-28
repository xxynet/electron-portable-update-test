$ErrorActionPreference = 'Stop'

function Invoke-PortableBuild {
    param([string[]]$Arguments)

    & npm run build:portable -- @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Portable build failed with exit code $LASTEXITCODE"
    }
}

Invoke-PortableBuild @('--version', '1.0.0', '--flavor', 'Ocean')
Invoke-PortableBuild @('--version', '1.0.1', '--flavor', 'Aurora', '--previous', '.\dist\releases\1.0.0\N.E.K.O_1.0.0_win_manifest.json')

Write-Host 'Demo releases are ready under dist\stage and dist\releases.'

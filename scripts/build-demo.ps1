$ErrorActionPreference = 'Stop'

npm run build:portable -- --version 1.0.0 --flavor Ocean
npm run build:portable -- --version 1.0.1 --flavor Aurora --previous '.\dist\releases\1.0.0\N.E.K.O_1.0.0_win_manifest.json'

Write-Host 'Demo releases are ready under dist\stage and dist\releases.'

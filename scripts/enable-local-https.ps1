$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $repository ".env.staging"
$tlsDirectory = Join-Path $repository ".localvoice-private\tls"
$pfxPath = Join-Path $tlsDirectory "localvoice.pfx"
$cerPath = Join-Path $tlsDirectory "localvoice.cer"
$pemPath = Join-Path $tlsDirectory "localvoice.pem"

if (-not (Test-Path -LiteralPath $environmentPath)) {
  throw ".env.staging is missing. Run the staging preparation first."
}

New-Item -ItemType Directory -Path $tlsDirectory -Force | Out-Null
$randomBytes = New-Object byte[] 32
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
$randomGenerator.GetBytes($randomBytes)
$randomGenerator.Dispose()
$passwordText = [Convert]::ToBase64String($randomBytes)
$password = ConvertTo-SecureString -String $passwordText -AsPlainText -Force
$certificate = New-SelfSignedCertificate `
  -Subject "CN=localhost" `
  -DnsName "localhost" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(3) `
  -FriendlyName "LocalVoice CRM localhost"

Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -Force | Out-Null
Export-Certificate -Cert $certificate -FilePath $cerPath -Type CERT -Force | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
$base64Certificate = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cerPath), [Base64FormattingOptions]::InsertLineBreaks)
[IO.File]::WriteAllText($pemPath, "-----BEGIN CERTIFICATE-----`n$base64Certificate`n-----END CERTIFICATE-----`n", [Text.Encoding]::ASCII)

$settings = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $environmentPath) {
  if ($line -match '^([^#=]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
}
$settings["APP_ORIGIN"] = '"https://localhost:3100"'
$settings["HTTPS_PORT"] = '"3443"'
$settings["HTTPS_PFX_PATH"] = '"/app/.localvoice-private/tls/localvoice.pfx"'
$settings["HTTPS_PFX_PASSWORD"] = '"' + $passwordText + '"'
$content = ($settings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join [Environment]::NewLine
[IO.File]::WriteAllText($environmentPath, $content + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

Write-Host "Trusted localhost HTTPS certificate installed for LocalVoice CRM."
Write-Host "Callback URL: https://localhost:3100/api/salesforce/callback"

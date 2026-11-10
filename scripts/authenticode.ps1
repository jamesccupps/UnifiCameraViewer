# Authenticode-sign files as James Cupps, through Azure Artifact Signing (the account and certificate
# profile Slate, NoteForge, PingerPlot and UniFi Stock Watcher sign with), with an RFC 3161 timestamp
# so the signatures stay valid after the short-lived certificate expires. Throws unless each file
# comes out validly signed.
#
# The release workflow's sign-app and sign-setup jobs run it. They need an Azure sign-in that may use
# the certificate profile (azure/login, from GitHub's OIDC token: no password or key anywhere) and the
# ArtifactSigning module at the version below, the one azure/artifact-signing-action v2.0.0 uses.
#
#   pwsh scripts/authenticode.ps1 -File <file>, <file>...
param([Parameter(Mandatory)][string[]]$File)
$ErrorActionPreference = 'Stop'

Import-Module ArtifactSigning -RequiredVersion 0.1.8
foreach ($f in $File) {
    Invoke-ArtifactSigning -Endpoint 'https://eus.codesigning.azure.net/' `
        -CodeSigningAccountName 'SlateAccount' -CertificateProfileName 'Slate' `
        -Files (Resolve-Path -LiteralPath $f).Path -FileDigest SHA256 `
        -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256
    # A signing failure must stop the release here, not surface as an unsigned file in it.
    $s = Get-AuthenticodeSignature -LiteralPath $f
    if ($s.Status -ne 'Valid') { throw "$f isn't validly signed after signing: $($s.Status) $($s.StatusMessage)" }
    "signed: $f"
}

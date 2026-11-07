param([string]$PolicyFile, [string]$Directory, [string]$Filename)
$ErrorActionPreference = 'Stop'
$actual = Get-Acl -LiteralPath $Directory
if (-not $actual.AreAccessRulesProtected) { throw 'Directory ACL is inherited' }
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$policy = Get-Content -Raw -LiteralPath $PolicyFile | ConvertFrom-Json
$expected = New-Object System.Security.AccessControl.DirectorySecurity
$expected.SetSecurityDescriptorSddlForm($policy.accessList.value.Replace('{owner}', $owner))
function Rules($Acl, [bool]$WithInheritance) {
    @($Acl.Access | ForEach-Object {
        $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        $rule = $sid + ';' + $_.FileSystemRights + ';' + $_.AccessControlType
        if ($WithInheritance) { $rule += ';' + $_.InheritanceFlags + ';' + $_.PropagationFlags }
        $rule
    } | Sort-Object)
}
if (Compare-Object (Rules $actual $true) (Rules $expected $true)) {
    throw 'Directory owner access list differs'
}
$fileAcl = Get-Acl -LiteralPath $Filename
if (Compare-Object (Rules $fileAcl $false) (Rules $expected $false)) {
    throw 'The token file did not inherit owner-only access'
}

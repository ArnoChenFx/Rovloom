# Windows 原生安装回归；所有网络调用替换为明确的合成字节写入，绝不下载真实 Release。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/install.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('rovloom-install-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$script:payload = [Text.Encoding]::UTF8.GetBytes('synthetic release bytes, never executed')
$sha = [Security.Cryptography.SHA256]::Create()
try { $script:digest = ([BitConverter]::ToString($sha.ComputeHash($script:payload))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
$script:asset = 'rovloom-0.1.0-windows-' + (Get-RovloomArchitecture ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString())) + '.exe'
$script:failure = ''
$script:requests = @()

# 覆盖仅限本测试脚本作用域；安装器依然负责真实校验和文件事务。
function Save-RovloomAsset {
    param([string]$Url, [string]$Path, [long]$MaximumBytes)
    $script:requests += $Url
    $base = 'https://github.com/ArnoChenFx/Rovloom/releases/download/v0.1.0/'
    if ($Url -ceq ($base + 'SHA256SUMS')) {
        if ($script:failure -ceq 'checksums-404') { throw 'synthetic_404' }
        $sums = "$script:digest  $script:asset`n"
        if ($script:failure -ceq 'duplicate') { $sums += $sums }
        if ($script:failure -ceq 'malformed') { $sums = "$script:digest $script:asset`n" }
        if ($script:failure -ceq 'missing') { $sums = "$script:digest  wrong-asset`n" }
        if ($script:failure -ceq 'hash') { $sums = ('a' * 64) + "  $script:asset`n" }
        [IO.File]::WriteAllText($Path, $sums, [Text.UTF8Encoding]::new($false))
    } elseif ($Url -ceq ($base + $script:asset)) {
        if ($script:failure -ceq 'binary-404') { throw 'synthetic_404' }
        [IO.File]::WriteAllBytes($Path, $script:payload)
    } else { throw 'unexpected_download_url' }
}

# 固定断言失败码不包含用户路径或凭据。
function Assert-Installer {
    param([bool]$Condition, [string]$Code)
    if (-not $Condition) { throw $Code }
}

try {
    foreach ($pair in @(@('X64', 'x64'), @('AMD64', 'x64'), @('Arm64', 'arm64'))) {
        Assert-Installer ((Get-RovloomArchitecture $pair[0]) -ceq $pair[1]) 'architecture_mapping_failed'
    }
    $rejected = $false
    try { Get-RovloomArchitecture 'X86' | Out-Null } catch { $rejected = $true }
    Assert-Installer $rejected 'unsupported_architecture_accepted'
    $directory = Join-Path $root 'user bin with spaces'
    $program = Join-Path $directory 'rovloom.exe'
    [void][IO.Directory]::CreateDirectory($directory)
    [IO.File]::WriteAllText($program, 'old program')
    Install-Rovloom '0.1.0' $directory | Out-Null
    Assert-Installer ((Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $script:digest) 'replacement_bytes_failed'
    Assert-Installer ($script:requests.Count -eq 2) 'download_count_failed'
    Assert-Installer (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'staging_cleanup_failed'
    foreach ($mode in @('checksums-404', 'binary-404', 'hash', 'duplicate', 'malformed', 'missing')) {
        $script:failure = $mode
        [IO.File]::WriteAllText($program, 'old program')
        $failed = $false
        try { Install-Rovloom '0.1.0' $directory | Out-Null } catch { $failed = $true }
        Assert-Installer $failed 'injected_failure_accepted'
        Assert-Installer ([IO.File]::ReadAllText($program) -ceq 'old program') 'old_program_changed'
        Assert-Installer (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'failure_staging_left'
    }
    $script:failure = ''
    [IO.File]::WriteAllText($program, 'locked old program')
    $locked = [IO.File]::Open($program, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $failed = $false
        try { Install-Rovloom '0.1.0' $directory | Out-Null } catch { $failed = $true }
        Assert-Installer $failed 'locked_destination_accepted'
        Assert-Installer ([IO.File]::ReadAllText($program) -ceq 'locked old program') 'locked_program_changed'
        Assert-Installer (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'locked_staging_left'
    } finally { $locked.Dispose() }
    [IO.File]::Delete($program)
    Install-Rovloom 'v0.1.0' $directory | Out-Null
    Assert-Installer ([IO.File]::Exists($program)) 'new_install_failed'
    foreach ($version in @('../main', 'latest', '01.2.3', '1.2.3+build')) {
        $count = $script:requests.Count
        $failed = $false
        try { Install-Rovloom $version $directory | Out-Null } catch { $failed = $true }
        Assert-Installer ($failed -and $script:requests.Count -eq $count) 'invalid_version_downloaded'
    }
    Write-Output 'windows_installer_fixture_pass'
} finally {
    [IO.Directory]::Delete($root, $true)
}

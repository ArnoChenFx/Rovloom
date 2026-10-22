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
$script:asset = 'rovloom-0.2.3-windows-' + (Get-RovloomArchitecture ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString())) + '.exe'
$script:failure = ''
$script:requests = @()
$script:latestRequests = 0
$script:latestUrl = 'https://github.com/ArnoChenFx/rovloom/releases/tag/v0.2.3'

# 只替换 latest 的网络响应；官方 URL 和稳定版本仍由产品真实门禁校验。
function Resolve-RovloomLatestUrl {
    $script:latestRequests++
    if ($script:failure -ceq 'latest-404') { throw 'synthetic_latest_404' }
    if ($script:latestRequests -gt 1) { return 'https://github.com/ArnoChenFx/rovloom/releases/tag/v0.9.9' }
    return $script:latestUrl
}

# 覆盖仅限本测试脚本作用域；安装器依然负责真实校验和文件事务。
function Save-RovloomAsset {
    param([string]$Url, [string]$Path, [long]$MaximumBytes)
    $script:requests += $Url
    $base = 'https://github.com/ArnoChenFx/rovloom/releases/download/v0.2.3/'
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
    # 已知向量独立核对真实流式摘要；随后独占打开文件，证明摘要函数已释放读取句柄。
    $hashVector = Join-Path $root 'hash-vector'
    [IO.File]::WriteAllBytes($hashVector, [Text.Encoding]::ASCII.GetBytes('abc'))
    Assert-Installer ((Get-RovloomSha256 $hashVector) -ceq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'sha256_known_vector_failed'
    $exclusive = [IO.File]::Open($hashVector, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $exclusive.Dispose()
    [IO.File]::Delete($hashVector)
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
    Install-Rovloom -Directory $directory | Out-Null
    Assert-Installer ([Convert]::ToBase64String([IO.File]::ReadAllBytes($program)) -ceq [Convert]::ToBase64String($script:payload)) 'replacement_bytes_failed'
    Assert-Installer ($script:requests.Count -eq 2 -and $script:latestRequests -eq 1) 'tag_binding_failed'
    Assert-Installer (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'staging_cleanup_failed'
    foreach ($mode in @('checksums-404', 'binary-404', 'hash', 'duplicate', 'malformed', 'missing')) {
        $script:failure = $mode
        $script:latestRequests = 0
        [IO.File]::WriteAllText($program, 'old program')
        $failed = $false
        try { Install-Rovloom -Directory $directory | Out-Null } catch { $failed = $true }
        Assert-Installer $failed 'injected_failure_accepted'
        Assert-Installer ([IO.File]::ReadAllText($program) -ceq 'old program') 'old_program_changed'
        Assert-Installer (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'failure_staging_left'
    }
    $script:failure = ''
    $script:latestRequests = 0
    [IO.File]::WriteAllText($program, 'locked old program')
    $locked = [IO.File]::Open($program, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $failed = $false
        try { Install-Rovloom -Directory $directory | Out-Null } catch { $failed = $true }
        Assert-Installer $failed 'locked_destination_accepted'
        Assert-Installer ([IO.File]::ReadAllText($program) -ceq 'locked old program') 'locked_program_changed'
        Assert-Installer (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'locked_staging_left'
    } finally { $locked.Dispose() }
    [IO.File]::Delete($program)
    $script:latestRequests = 0
    Install-Rovloom -Directory $directory | Out-Null
    Assert-Installer ([IO.File]::Exists($program)) 'new_install_failed'
    foreach ($url in @(
        'https://github.com/foreign/Rovloom/releases/tag/v0.2.3',
        'http://github.com/ArnoChenFx/rovloom/releases/tag/v0.2.3',
        'https://github.com/ArnoChenFx/rovloom/releases/tag/v0.2.3-rc.1',
        'https://github.com/ArnoChenFx/rovloom/releases/tag/v00.2.3',
        'https://github.com/ArnoChenFx/rovloom/releases/tag/v0.2.3?x=1',
        'https://github.com/ArnoChenFx/rovloom/releases/tag/0.2.3',
        "https://github.com/ArnoChenFx/rovloom/releases/tag/v0.2.3`n"
    )) {
        $script:latestUrl = $url
        $script:latestRequests = 0
        $count = $script:requests.Count
        [IO.File]::WriteAllText($program, 'old program')
        $failed = $false
        try { Install-Rovloom -Directory $directory | Out-Null } catch { $failed = $true }
        Assert-Installer ($failed -and $script:requests.Count -eq $count) 'invalid_latest_tag_downloaded'
        Assert-Installer ([IO.File]::ReadAllText($program) -ceq 'old program') 'invalid_latest_changed_program'
    }
    $script:latestUrl = 'https://github.com/ArnoChenFx/rovloom/releases/tag/v0.2.3'
    $script:latestRequests = 0
    $script:failure = 'latest-404'
    $failed = $false
    try { Install-Rovloom -Directory $directory | Out-Null } catch { $failed = $true }
    Assert-Installer $failed 'latest_404_accepted'
    Assert-Installer ([IO.File]::ReadAllText($program) -ceq 'old program') 'latest_404_changed_program'
    $script:failure = ''
    $script:latestRequests = 0
    $count = $script:requests.Count
    Assert-Installer ((Install-Rovloom -Directory $directory -OnlyAsset) -ceq $script:asset) 'latest_preview_asset_failed'
    Assert-Installer ($script:latestRequests -eq 1 -and $script:requests.Count -eq $count) 'latest_preview_downloaded_asset'
    Write-Output 'windows_installer_fixture_pass'
} finally {
    [IO.Directory]::Delete($root, $true)
}

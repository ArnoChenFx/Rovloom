# 仅安装官方 latest 稳定发行；单次解析 tag 后固定下载，不创建身份、服务或修改用户 PATH。
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Rovloom\bin'),
    [switch]$PrintAsset
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 使用原生 OS 架构，避免把运行在 x64 模拟环境的 ARM64 Windows 误识别为 x64。
function Get-RovloomArchitecture {
    param([string]$Architecture)
    switch ($Architecture.ToLowerInvariant()) {
        'x64' { return 'x64' }
        'amd64' { return 'x64' }
        'arm64' { return 'arm64' }
        default { throw 'Unsupported Windows architecture; expected x64 or arm64.' }
    }
}

# latest 的网络接缝只返回最终 URL；每跳只接受 HTTPS 且不携带用户凭据。
function Resolve-RovloomLatestUrl {
    $url = [Uri]'https://github.com/ArnoChenFx/Rovloom/releases/latest'
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        $request = [Net.HttpWebRequest]::Create($url)
        $request.Method = 'HEAD'
        $request.AllowAutoRedirect = $false
        $request.Timeout = 120000
        $request.ReadWriteTimeout = 120000
        $request.UserAgent = 'Rovloom-installer'
        $response = $null
        try {
            $response = $request.GetResponse()
            $status = [int]$response.StatusCode
            if ($status -ge 300 -and $status -lt 400) {
                if ($redirect -eq 5) { throw 'Too many latest release redirects.' }
                $url = [Uri]::new($url, $response.Headers['Location'])
                if ($url.Scheme -ne 'https' -or $url.UserInfo) { throw 'Invalid latest release redirect.' }
                continue
            }
            if ($status -ne 200) { throw 'Latest release is unavailable; existing program was kept.' }
            return $url.AbsoluteUri
        } finally {
            if ($null -ne $response) { $response.Dispose() }
        }
    }
}

# 网络返回值仍经真实版本门禁；只接受唯一官方仓库的规范稳定 tag。
function Get-RovloomLatestVersion {
    $url = Resolve-RovloomLatestUrl
    $match = [Regex]::Match($url, '\Ahttps://github\.com/ArnoChenFx/Rovloom/releases/tag/v((?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8}))\z')
    if (-not $match.Success) { throw 'Latest release did not resolve to a canonical official stable tag; existing program was kept.' }
    return $match.Groups[1].Value
}

# 直接使用 .NET 流式摘要，不依赖 PowerShell 模块自动加载或继承的 PSModulePath。
function Get-RovloomSha256 {
    param([string]$Path)
    $stream = $null
    $sha = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $sha = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

# 只有固定官方 Release URL 可被安装流程使用；失败不下载或执行任意备用脚本。
function Save-RovloomAsset {
    param([string]$Url, [string]$Path, [long]$MaximumBytes)
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 120000
    $request.ReadWriteTimeout = 120000
    $request.UserAgent = 'Rovloom-installer'
    # GitHub 资产使用 HTTPS CDN 重定向；只允许 HTTPS，且不携带账户凭据。
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        $response = $null
        try {
            $response = $request.GetResponse()
            $status = [int]$response.StatusCode
            if ($status -ge 300 -and $status -lt 400) {
                if ($redirect -eq 5) { throw 'Too many release download redirects.' }
                $next = [Uri]::new($request.RequestUri, $response.Headers['Location'])
                if ($next.Scheme -ne 'https' -or $next.UserInfo) { throw 'Invalid release download redirect.' }
                $request = [Net.HttpWebRequest]::Create($next)
                $request.AllowAutoRedirect = $false
                $request.Timeout = 120000
                $request.ReadWriteTimeout = 120000
                $request.UserAgent = 'Rovloom-installer'
                continue
            }
            if ($status -ne 200 -or $response.ContentLength -gt $MaximumBytes) { throw 'Release asset is unavailable or too large.' }
            $inputStream = $null
            $outputStream = $null
            try {
                $inputStream = $response.GetResponseStream()
                $outputStream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $buffer = New-Object byte[] 65536
                [long]$total = 0
                while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $read
                    if ($total -gt $MaximumBytes) { throw 'Release asset is too large.' }
                    $outputStream.Write($buffer, 0, $read)
                }
                $outputStream.Flush($true)
            } finally {
                if ($null -ne $outputStream) { $outputStream.Dispose() }
                if ($null -ne $inputStream) { $inputStream.Dispose() }
            }
            return
        } finally {
            if ($null -ne $response) { $response.Dispose() }
        }
    }
}

# 下载和摘要验证在用户目录的独占暂存区完成；最终只有一次原子替换。
function Install-Rovloom {
    param([string]$Directory, [switch]$OnlyAsset)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use install.sh on Linux or macOS.' }
    if (-not [IO.Path]::IsPathRooted($Directory) -or $Directory -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Install directory must be an absolute Windows drive path.'
    }
    $architecture = Get-RovloomArchitecture ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString())
    $SelectedVersion = Get-RovloomLatestVersion
    $asset = "rovloom-$SelectedVersion-windows-$architecture.exe"
    if ($OnlyAsset) { return $asset }
    $directoryInfo = [IO.Directory]::CreateDirectory($Directory)
    if (($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Install directory must not be a reparse point.' }
    $destination = Join-Path $directoryInfo.FullName 'rovloom.exe'
    if (Test-Path -LiteralPath $destination) {
        $existing = Get-Item -LiteralPath $destination -Force
        if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Existing program must be a regular file.'
        }
    }
    $stage = Join-Path $directoryInfo.FullName ('.rovloom-install.' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($stage)
    try {
        $base = "https://github.com/ArnoChenFx/Rovloom/releases/download/v$SelectedVersion"
        $checksums = Join-Path $stage 'SHA256SUMS'
        $candidate = Join-Path $stage 'rovloom.exe'
        Save-RovloomAsset "$base/SHA256SUMS" $checksums 65536
        $lines = [IO.File]::ReadAllLines($checksums)
        $matching = @($lines | Where-Object { $_ -match ('\s' + [Regex]::Escape($asset) + '$') })
        if ($matching.Count -ne 1 -or $matching[0] -cnotmatch ('^[a-f0-9]{64}  ' + [Regex]::Escape($asset) + '$')) {
            throw 'Missing or ambiguous asset checksum; existing program was kept.'
        }
        $expected = $matching[0].Substring(0, 64)
        Save-RovloomAsset "$base/$asset" $candidate 268435456
        if ((Get-Item -LiteralPath $candidate).Length -eq 0) { throw 'Release binary is empty; existing program was kept.' }
        $actual = Get-RovloomSha256 $candidate
        if ($actual -cne $expected) { throw 'Release checksum mismatch; existing program was kept.' }
        # File.Replace 在同一卷原子替换；目标正运行或并发改变时直接失败，不删除旧文件重试。
        if ([IO.File]::Exists($destination)) {
            # Windows PowerShell 5 对 string 参数须显式传.NET null，避免将 $null 转成空路径。
            [IO.File]::Replace($candidate, $destination, ([System.Management.Automation.Language.NullString]::Value))
        } else {
            [IO.File]::Move($candidate, $destination)
        }
        Write-Output "Installed Rovloom $SelectedVersion at $destination"
        Write-Output 'Run the full path with --help. Add its directory to PATH if desired.'
        Write-Output 'This installs the binary only; Windows Gateway/Connector runtime acceptance is separate.'
    } finally {
        if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    # 旧版 Windows PowerShell 默认 TLS 不一定包含 1.2；仅为本安装进程启用标准 HTTPS。
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Install-Rovloom -Directory $InstallDir -OnlyAsset:$PrintAsset
}

# 只供已授权的一次性CI任务诊断：以同一S4U账户捕获自有产品进程的固定错误，不改权限或用户配置。
param([string]$RequestPath)
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$request = $json.DeserializeObject([IO.File]::ReadAllText($RequestPath, [Text.UTF8Encoding]::new($false)))
if ($request.scope -cne 'disposable-native-service-start') { exit 1 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$report = @{
  account = $identity.Name
  sid = $identity.User.Value
  wrapperDirectory = [Environment]::CurrentDirectory
  executable = $request.executable
  arguments = $request.arguments
  directory = $request.directory
  executableExists = [IO.File]::Exists($request.executable)
  configExists = [IO.File]::Exists($request.config)
  directoryExists = [IO.Directory]::Exists($request.directory)
  runs = [Collections.Generic.List[object]]::new()
}
foreach ($plan in $request.plans) {
  $child = [Diagnostics.Process]::new()
  $child.StartInfo.FileName = $request.executable
  $child.StartInfo.Arguments = $plan.arguments
  $child.StartInfo.WorkingDirectory = $request.directory
  $child.StartInfo.UseShellExecute = $false
  $child.StartInfo.CreateNoWindow = $true
  $child.StartInfo.RedirectStandardInput = $false
  $child.StartInfo.RedirectStandardOutput = $true
  $child.StartInfo.RedirectStandardError = $true
  $run = @{ operation=$plan.operation; arguments=$plan.arguments; phase='starting' }
  $started = $false
  try {
    $null = $child.Start()
    $started = $true
    $run.pid = $child.Id
    $run.phase = 'running'
    $out = $child.StandardOutput.ReadToEndAsync()
    $err = $child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit([int]$plan.timeout)) {
      # 只终止本次直接创建的诊断child；原产品任务的失败不会因此成为通过。
      $run.phase = 'diagnostic_deadline'
      $child.Kill()
      if (!$child.WaitForExit(1000)) { throw 'diagnostic_child_exit_unknown' }
    } else { $run.phase = 'exited' }
    $run.exitCode = $child.ExitCode
    if ($out.Wait(500) -and $err.Wait(500)) {
      $run.stdoutLength = $out.Result.Length
      $run.stderrLength = $err.Result.Length
      $codes = [Collections.Generic.List[string]]::new()
      foreach ($line in $err.Result.Split([char]10)) {
        $code = $line.Trim()
        if ($code -cin $request.errorCodes) { $codes.Add($code) }
      }
      $run.stderrCodes = $codes.ToArray()
    } else { $run.streams = 'not_closed' }
  } catch {
    $run.errorType = $_.Exception.GetType().FullName
    $run.hresult = $_.Exception.HResult
  } finally {
    if ($started -and !$child.HasExited) {
      try {
        $child.Kill()
        $run.childExitKnown = $child.WaitForExit(1000)
      } catch { $run.childExitKnown = $false }
    }
    $child.Dispose()
  }
  $report.runs.Add($run)
  if ($run.childExitKnown -eq $false) { break }
}
# 完整关闭后再发布结果，父进程不能把部分JSON误作工具失败。
[IO.File]::WriteAllText($request.result + '.pending', $json.Serialize($report), [Text.UTF8Encoding]::new($false))
[IO.File]::Move($request.result + '.pending', $request.result)

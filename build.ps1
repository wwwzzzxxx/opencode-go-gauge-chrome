# 打包 Chrome 扩展为 zip（用于本地安装或商店上传）
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "go-usage.zip"
if (Test-Path $out) { Remove-Item $out -Force }
# 直接对根目录压缩，排除 .git 与自身
# 先创建临时目录并复制需要的文件
$tmp = Join-Path $env:TEMP ("go-usage-build-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $items = @("manifest.json","icons","popup","dashboard","src","README.md","LICENSE")
  foreach ($it in $items) {
    $src = Join-Path $root $it
    $dst = Join-Path $tmp $it
    if (Test-Path $src) {
      Copy-Item -Path $src -Destination $dst -Recurse -Force
    }
  }
  # 压缩临时目录内容（保留目录结构）
  Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $out -Force
  $zip = Get-Item $out
  Write-Host "已打包: $($zip.FullName)  ($([math]::Round($zip.Length/1024,1)) KB)"
  Write-Host "包含文件:"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z=[IO.Compression.ZipFile]::OpenRead($out)
  $z.Entries | Sort-Object FullName | ForEach-Object { Write-Host ("  " + $_.FullName + "  (" + $_.Length + " bytes)") }
  $z.Dispose()
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
}


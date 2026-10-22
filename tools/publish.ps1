param(
  [string]$Owner = 'BCABC4353',
  [string]$Repo = 'twinkly-desk',
  [string]$Message = 'Update Twinkly Desk',
  [switch]$Release,
  [switch]$SkipWorkflows,
  [string]$Bump = 'minor'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$full = "$Owner/$Repo"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { $env:Path = $env:Path + ';C:\Program Files\GitHub CLI' }

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'gh is not logged in. Run: gh auth login' }

$exists = $true
try { gh repo view $full --json name 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $exists = $false } } catch { $exists = $false }
if (-not $exists) {
  Write-Host "Creating $full"
  gh repo create $full --public --description 'Desktop controller for Twinkly light sets' --add-readme | Out-Null
  Start-Sleep -Seconds 3
}

function Get-MainSha {
  $out = gh api "repos/$full/git/ref/heads/main" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  return ($out | ConvertFrom-Json).object.sha
}

$parent = Get-MainSha
if (-not $parent) {
  Write-Host 'Repository is empty; seeding the first commit'
  $seed = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("# $Repo`n"))
  gh api "repos/$full/contents/README.md" --method PUT -f message='Initial commit' -f content=$seed -f branch=main | Out-Null
  Start-Sleep -Seconds 2
  $parent = Get-MainSha
  if (-not $parent) { throw 'could not create the first commit' }
}

$skip = '\\node_modules\\|\\dist\\|\\build-output\\|\\\.git\\|\.log$'
$files = Get-ChildItem -Path $root -Recurse -File -Force | Where-Object { $_.FullName -notmatch $skip }
if ($SkipWorkflows) { $files = $files | Where-Object { $_.FullName -notmatch '\\\.github\\' } }
Write-Host "Uploading $($files.Count) files"

$tree = New-Object System.Collections.ArrayList
$tmp = [IO.Path]::GetTempFileName()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
  $body = @{ content = $b64; encoding = 'base64' } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($tmp, $body)
  $blob = gh api "repos/$full/git/blobs" --method POST --input $tmp | ConvertFrom-Json
  [void]$tree.Add(@{ path = $rel; mode = '100644'; type = 'blob'; sha = $blob.sha })
  Write-Host "  $rel"
}

$treeBody = @{ tree = $tree.ToArray() } | ConvertTo-Json -Depth 5 -Compress
[IO.File]::WriteAllText($tmp, $treeBody)
$treeSha = (gh api "repos/$full/git/trees" --method POST --input $tmp | ConvertFrom-Json).sha

$commit = @{ message = $Message; tree = $treeSha; parents = @() }
if ($parent) { $commit.parents = @($parent) }
[IO.File]::WriteAllText($tmp, ($commit | ConvertTo-Json -Depth 5 -Compress))
$commitSha = (gh api "repos/$full/git/commits" --method POST --input $tmp | ConvertFrom-Json).sha
Remove-Item $tmp

if ($parent) {
  gh api "repos/$full/git/refs/heads/main" --method PATCH -f sha=$commitSha | Out-Null
} else {
  gh api "repos/$full/git/refs" --method POST -f ref=refs/heads/main -f sha=$commitSha | Out-Null
}
Write-Host "main is now $commitSha  https://github.com/$full"

if ($Release) {
  Start-Sleep -Seconds 5
  gh workflow run build.yml -f bump=$Bump --repo $full
  Write-Host "Build and Release started with bump=$Bump. Watch it at https://github.com/$full/actions"
}

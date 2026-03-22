$keep = 3504
$procs = Get-Process node -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    if ($p.Id -ne $keep) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Killed PID:" $p.Id
    }
}
Write-Host ""
Write-Host "Remaining node processes:"
(Get-Process node -ErrorAction SilentlyContinue).Count

$procs = Get-Process node -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    $wsMb = [math]::Round($p.WorkingSet64/1MB,2)
    Write-Host "PID:" $p.Id "- $wsMb MB"
}

$zombiePids = @(436, 1376, 2104, 2336, 3032, 4296, 4440, 6432, 6980, 7664, 8084, 8676, 8836, 9024, 9200, 9376, 9444, 10104)
foreach ($pid in $zombiePids) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    if ($?) {
        Write-Host "Killed PID: $pid"
    } else {
        Write-Host "Failed to kill PID: $pid"
    }
}
Write-Host ""
Write-Host "Remaining node processes:"
(Get-Process node -ErrorAction SilentlyContinue).Count

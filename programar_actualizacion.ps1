# AIFUT · OX V1.0 — registra una tarea de Windows para actualizar la cartelera.
#
# Uso normal (sin privilegios de administrador, para el usuario actual):
#   powershell -ExecutionPolicy Bypass -File .\programar_actualizacion.ps1
#
# Cambiar el intervalo:
#   powershell -ExecutionPolicy Bypass -File .\programar_actualizacion.ps1 -EveryMinutes 30
#   powershell -ExecutionPolicy Bypass -File .\programar_actualizacion.ps1 -EveryHours 6
#
# Quitar la tarea:
#   Unregister-ScheduledTask -TaskName "AIFUT actualizar datos" -Confirm:$false
#
# La tarea se ejecuta cada 15 minutos y llama a actualizar_programado.cmd.
# Ese script aplica la cadencia real: 15 min en día de partido y 6 h fuera
# de él para la cartelera live; el catálogo y los fixtures usan su propio
# lock y su propia cadencia. El resultado queda en actualizacion_live.log.

param(
  [string]$TaskName = "AIFUT actualizar datos",
  [ValidateRange(5, 1440)]
  [int]$EveryMinutes = 15,
  [ValidateRange(0, 168)]
  [int]$EveryHours = 0
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "actualizar_programado.cmd"

if (-not (Test-Path -LiteralPath $script)) {
  throw "No se encontró $script"
}

$minutes = if ($EveryHours -gt 0) { $EveryHours * 60 } else { $EveryMinutes }
$action = New-ScheduledTaskAction -Execute $script -WorkingDirectory $root
$start = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
  -RepetitionInterval (New-TimeSpan -Minutes $minutes)

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings `
  -Description "Actualiza la cartelera live y los fixtures de AIFUT desde ESPN."

Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
Write-Host "Tarea registrada: $TaskName"
Write-Host "Primera ejecución: $($start.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Latido: cada $minutes min (15 min en día de partido; 6 h fuera de él)."
Write-Host "Log: $(Join-Path $root 'actualizacion_live.log')"

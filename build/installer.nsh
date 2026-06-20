; ──────────────────────────────────────────────────────────────────────────
;  Custom NSIS hooks — LetsHyre Secure Interview
;
;  The app bundles a Python security agent at resources\agent.exe and runs it
;  as a child process. During an AUTO-UPDATE the new installer removes the old
;  version's files; if agent.exe is still running it locks resources\agent.exe
;  and the uninstall fails with:
;     "Failed to uninstall old application files. Please try running the
;      installer again.: 2"
;
;  customInit runs at the very start of the (new) installer — before the old
;  version is removed — so terminating the agent here guarantees the file is
;  unlocked regardless of how the previously-installed app behaved. /T also
;  kills any child processes the agent spawned.
; ──────────────────────────────────────────────────────────────────────────

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM agent.exe'
  Sleep 800
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /T /IM agent.exe'
  Sleep 500
!macroend

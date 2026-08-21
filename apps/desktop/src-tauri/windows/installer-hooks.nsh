!macro NSIS_HOOK_PREINSTALL
  StrCpy $NoShortcutMode 1
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $NoShortcutMode 0
  Call CreateOrUpdateStartMenuShortcut
  StrCpy $NoShortcutMode 1
!macroend

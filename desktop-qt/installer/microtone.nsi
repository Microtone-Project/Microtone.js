; Microtone for Windows: the installer (desktop-qt, item 336).
;
;   makensis /INPUTCHARSET UTF8 /DVERSION=<x.y.z> /DFILEVERSION=<x.y.z.0>
;            /DSTAGE=<app folder> /DLISTS=<lists dir> /DOUTFILE=<setup.exe>
;            desktop-qt\installer\microtone.nsi
;
; <app folder> is the packaged app (.github/workflows/desktop-qt.yml: the
; binary, the probes, windeployqt's Qt, the C runtime, www/, LICENSE.txt);
; <lists dir> holds what tools/installer-files.js made from it. makensis runs
; from this file's folder, so the icon and the licence are found from here.
;
; For one person, asking for no administrator rights: into
; %LOCALAPPDATA%\Programs\Microtone (or where it went before), a Start menu
; shortcut, a desktop one if asked, and an entry in Windows' list of apps
; under its own key — the Tauri build's ("Microtone") is left alone, and so is
; its data. The projects are not in the program folder (src/main.cpp): they
; stay through an uninstall unless its last-but-one page is told otherwise.
;
; The uninstaller removes the files the installer put there, by name, and
; nothing else: never RMDir /r on a folder someone chose. An install over an
; earlier one runs the earlier one's uninstaller first (/S /UPDATE: its files
; only), so a file a version stopped shipping goes too.
;
; Switches (besides NSIS's /S and /D=):
;   /P  passive: no questions, the progress only — for an update
;   /R  with /P or /S, start Microtone when done
; and the uninstaller's /UPDATE: removing the files for an install that
; replaces them (no shortcuts, no registry, never the projects).

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef VERSION | FILEVERSION | STAGE | LISTS | OUTFILE
  !error "makensis /DVERSION=x.y.z /DFILEVERSION=x.y.z.0 /DSTAGE=<app folder> /DLISTS=<lists dir> /DOUTFILE=<setup.exe>"
!endif

!define PRODUCT "Microtone"
!define PUBLISHER "CuriousTorvald"
!define HOMEPAGE "https://microtone.cc/"
!define EXE "microtone.exe"
; Windows' list of apps. Not "Microtone": that key is the Tauri build's.
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\cc.microtone.desktop"
; Held by the running app (src/main.cpp).
!define MUTEX "Local\microtone-desktop"
; What the app keeps (src/main.cpp): the browser profile with every project,
; the cache, and QSettings' key.
!define DATADIR "$LOCALAPPDATA\Microtone\Microtone"
!define SETTINGSKEY "Software\Microtone\Microtone"
!define /ifndef SYNCHRONIZE 0x00100000
!define /ifndef SLGP_RAWPATH 4

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "Win\COM.nsh"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
BrandingText "${PRODUCT} ${VERSION}"

Var Passive    ; /P
Var Relaunch   ; /R
Var Update     ; the uninstaller's /UPDATE
Var DataBox
Var DeleteData

; ── pages ──

!define MUI_ICON "..\icons\microtone.ico"
!define MUI_UNICON "..\icons\microtone.ico"
; The finish page's side panel: the icon on the dark theme's ground (#16181d),
; 164 × 314, 24-bit. Made with ImageMagick from the icon:
;   convert -size 164x314 xc:'#16181d' ( desktop/icons/icon.png -resize 96x96 )
;     -gravity north -geometry +0+56 -composite -alpha off -type truecolor
;     BMP3:desktop-qt/installer/finish.bmp
!define MUI_WELCOMEFINISHPAGE_BITMAP "finish.bmp"
!define MUI_ABORTWARNING

; The GPL is not an agreement to accept before use: Next, not "I Agree".
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"
!define MUI_LICENSEPAGE_TEXT_BOTTOM "$(licenseBottom)"
!insertmacro MUI_PAGE_LICENSE "..\..\COPYING"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunApp
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(desktopShortcut)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

UninstPage custom un.DataPage un.DataPageLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; The first is the fallback; Windows' own language picks otherwise.
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Korean"

LangString licenseBottom ${LANG_ENGLISH} "Microtone is free software under the GNU General Public License, version 3 or later. Using it asks for no agreement: the licence sets the terms for copying and changing it."
LangString licenseBottom ${LANG_KOREAN} "Microtone은 GNU 일반 공중 사용 허가서 3판 또는 그 이후 판에 따른 자유 소프트웨어입니다. 쓰는 데에는 동의가 필요 없으며, 이 허가서는 복제하고 고칠 때의 조건을 정합니다."
LangString desktopShortcut ${LANG_ENGLISH} "Create a desktop shortcut"
LangString desktopShortcut ${LANG_KOREAN} "바탕 화면에 바로 가기 만들기"
LangString appRunning ${LANG_ENGLISH} "Microtone is running. Close it, then choose Retry."
LangString appRunning ${LANG_KOREAN} "Microtone이 실행 중입니다. 종료한 뒤 [다시 시도]를 누르세요."
LangString appStillRunning ${LANG_ENGLISH} "Microtone is still running, so nothing was changed."
LangString appStillRunning ${LANG_KOREAN} "Microtone이 아직 실행 중이라 아무것도 바꾸지 않았습니다."
LangString dataTitle ${LANG_ENGLISH} "Your projects"
LangString dataTitle ${LANG_KOREAN} "프로젝트"
LangString dataSubtitle ${LANG_ENGLISH} "Keep them, or delete them too."
LangString dataSubtitle ${LANG_KOREAN} "남겨 둘지, 함께 삭제할지 고르세요."
LangString dataText ${LANG_ENGLISH} "Microtone keeps your projects, the samples in them and its settings outside its program folder. They stay after uninstalling, and installing Microtone again finds them where they were."
LangString dataText ${LANG_KOREAN} "Microtone은 프로젝트와 그 안의 샘플, 그리고 설정을 프로그램 폴더 바깥에 보관합니다. 제거한 뒤에도 남아 있으며, Microtone을 다시 설치하면 그대로 찾아 씁니다."
LangString diagShortcut ${LANG_ENGLISH} "Microtone diagnostics"
LangString diagShortcut ${LANG_KOREAN} "Microtone 진단"
LangString dataBox ${LANG_ENGLISH} "Also delete my projects and settings (this cannot be undone)"
LangString dataBox ${LANG_KOREAN} "프로젝트와 설정도 삭제 (되돌릴 수 없음)"

VIProductVersion "${FILEVERSION}"
VIFileVersion "${FILEVERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${PRODUCT} installer"
VIAddVersionKey /LANG=${LANG_ENGLISH} "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "© ${PUBLISHER} and contributors. GNU GPL version 3 or later."

; ── both ──

; The running app holds ${MUTEX}. Asked, it can be closed and the check made
; again; unattended (an update, /S), it is given ten seconds to finish
; closing, and the install or uninstall is called off if it does not.
!macro CHECK_RUNNING un
Function ${un}CheckRunning
  StrCpy $R2 0
  check:
    System::Call 'kernel32::OpenMutexW(i ${SYNCHRONIZE}, i 0, w "${MUTEX}") p .r0'
    ${If} $0 P= 0
      Return
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
    ${If} ${Silent}
    ${OrIf} $Passive = 1
      ${If} $R2 < 20
        IntOp $R2 $R2 + 1
        Sleep 500
        Goto check
      ${EndIf}
      MessageBox MB_ICONSTOP "$(appStillRunning)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appRunning)" IDRETRY check
    Abort
FunctionEnd
!macroend
!insertmacro CHECK_RUNNING ""
!insertmacro CHECK_RUNNING "un."

!macro SKIP_IF_PASSIVE un
Function ${un}SkipIfPassive
  ${If} $Passive = 1
    Abort
  ${EndIf}
FunctionEnd
!macroend
!insertmacro SKIP_IF_PASSIVE ""
!insertmacro SKIP_IF_PASSIVE "un."

; ── the installer ──

Function .onInit
  SetShellVarContext current
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    StrCpy $Passive 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/R" $R1
  ${IfNot} ${Errors}
    StrCpy $Relaunch 1
  ${EndIf}
FunctionEnd

Section "${PRODUCT}"
  SectionIn RO
  Call CheckRunning
  InitPluginsDir

  ; An earlier install in this folder (by its registry entry, so nobody
  ; else's uninstall.exe is ever run): its uninstaller removes its own files.
  ReadRegStr $R0 HKCU "${UNINSTKEY}" "InstallLocation"
  ${If} $R0 == $INSTDIR
  ${AndIf} ${FileExists} "$INSTDIR\uninstall.exe"
    CopyFiles /SILENT "$INSTDIR\uninstall.exe" "$PLUGINSDIR\previous-uninstall.exe"
    ExecWait '"$PLUGINSDIR\previous-uninstall.exe" /S /UPDATE _?=$INSTDIR'
  ${EndIf}

  !include "${LISTS}\install-files.nsh"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${EXE}"
  ; For a failure report: the probes, the log and the crash reports, gathered
  ; on the Desktop (diagnostics.cmd). Its name is kept for the uninstaller.
  ${If} ${FileExists} "$INSTDIR\diagnostics.cmd"
    CreateShortcut "$SMPROGRAMS\$(diagShortcut).lnk" "$INSTDIR\diagnostics.cmd" "" "$INSTDIR\${EXE}" 0
    WriteRegStr HKCU "${UNINSTKEY}" "DiagnosticsShortcut" "$SMPROGRAMS\$(diagShortcut).lnk"
  ${EndIf}

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
  WriteRegStr HKCU "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" ${INSTALL_SIZE_KB}

  ${If} $Passive = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RunApp
  Exec '"$INSTDIR\${EXE}"'
FunctionEnd

Function CreateDesktopShortcut
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${EXE}"
FunctionEnd

Function .onInstSuccess
  ${If} $Relaunch = 1
    ${If} $Passive = 1
    ${OrIf} ${Silent}
      Call RunApp
    ${EndIf}
  ${EndIf}
FunctionEnd

; ── the uninstaller ──

Function un.onInit
  SetShellVarContext current
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    StrCpy $Update 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    StrCpy $Passive 1
  ${EndIf}
FunctionEnd

Function un.DataPage
  ${If} $Passive = 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(dataTitle)" "$(dataSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 40u "$(dataText)"
  Pop $0
  ${NSD_CreateCheckbox} 0 48u 100% 12u "$(dataBox)"
  Pop $DataBox
  ${If} $DeleteData = ${BST_CHECKED}
    ${NSD_Check} $DataBox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $DataBox $DeleteData
FunctionEnd

; $R9 = the target of the shortcut `lnk` ("" if it cannot be read).
!macro SHORTCUT_TARGET lnk
  StrCpy $R9 ""
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${lnk}",${STGM_READ})'
      ${IShellLink::GetPath} $0 '(.R9,${NSIS_MAX_STRLEN},0,${SLGP_RAWPATH})'
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
!macroend

; A shortcut by our name is removed only if it starts this install: the
; Tauri build's, or one a later install made elsewhere, stays.
!macro REMOVE_OUR_SHORTCUT lnk
  ${If} ${FileExists} "${lnk}"
    !insertmacro SHORTCUT_TARGET "${lnk}"
    ${If} $R9 == "$INSTDIR\${EXE}"
      Delete "${lnk}"
    ${EndIf}
  ${EndIf}
!macroend

Section "Uninstall"
  ${If} $Update <> 1  ; an install replacing this one has checked already
    Call un.CheckRunning
  ${EndIf}

  !include "${LISTS}\uninstall-files.nsh"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ${If} $Update <> 1
    ReadRegStr $R8 HKCU "${UNINSTKEY}" "DiagnosticsShortcut"
    ${If} $R8 != ""
      Delete "$R8"
    ${EndIf}
    !insertmacro REMOVE_OUR_SHORTCUT "$SMPROGRAMS\${PRODUCT}.lnk"
    !insertmacro REMOVE_OUR_SHORTCUT "$DESKTOP\${PRODUCT}.lnk"
    DeleteRegKey HKCU "${UNINSTKEY}"
    ${If} $DeleteData = ${BST_CHECKED}
      RMDir /r "${DATADIR}"
      RMDir "$LOCALAPPDATA\Microtone"
      DeleteRegKey HKCU "${SETTINGSKEY}"
      DeleteRegKey /ifempty HKCU "Software\Microtone"
    ${EndIf}
  ${EndIf}

  ${If} $Passive = 1
  ${OrIf} $Update = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

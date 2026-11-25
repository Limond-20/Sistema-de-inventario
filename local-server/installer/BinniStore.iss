; Script de Inno Setup 6 para generar el instalador de Windows de BinniStore
; Compilación recomendada vía:
;   powershell -ExecutionPolicy Bypass -File local-server/installer/build-installer.ps1 -Version 1.0.0

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#ifndef AppName
  #define AppName "BinniStore"
#endif

#ifndef AppPublisher
  #define AppPublisher "BinniStore"
#endif

#ifndef AppExeName
  #define AppExeName "BinniStore.exe"
#endif

#ifndef SourceDistDir
  #define SourceDistDir "..\dist\BinniStore"
#endif

#ifndef ManualPdfPath
  #define ManualPdfPath "..\..\docs\manual-de-usuario.pdf"
#endif

#ifndef IconPath
  #define IconPath "..\..\abarrotes-app\public\favicon.ico"
#endif

[Setup]
; Identificador fijo para permitir actualizaciones limpias sobre instalaciones previas
AppId={{B7E49C21-6F8A-4D3E-9A1C-4E5F8B2D1A90}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
; Se instala en el perfil del usuario sin exigir permisos de administrador (UAC),
; garantizando escritura directa en las carpetas Respaldos y Evidencias junto al ejecutable.
DefaultDirName={localappdata}\Programs\BinniStore
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=salida-instalador
OutputBaseFilename=Instalador-BinniStore-{#AppVersion}
SetupIconFile={#IconPath}
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Limpia _internal en actualizaciones para evitar DLLs o scripts obsoletos.
; NO toca {app}\Respaldos, {app}\Evidencias ni %LOCALAPPDATA%\BinniStore (base SQLite y certificados).
Type: filesandordirs; Name: "{app}\_internal"

[Dirs]
Name: "{app}\Respaldos"
Name: "{app}\Evidencias"

[Files]
Source: "{#SourceDistDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDistDir}\*"; DestDir: "{app}"; Excludes: "{#AppExeName}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ManualPdfPath}"; DestDir: "{app}\Manual"; DestName: "Manual-de-Usuario.pdf"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autoprograms}\{#AppName}\Manual de Usuario"; Filename: "{app}\Manual\Manual-de-Usuario.pdf"
Name: "{autoprograms}\{#AppName}\Carpeta de Respaldos"; Filename: "{app}\Respaldos"
Name: "{autoprograms}\{#AppName}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

; Nota de seguridad: No se define [UninstallDelete] sobre %LOCALAPPDATA%\BinniStore,
; {app}\Respaldos ni {app}\Evidencias para proteger la base de datos SQLite y respaldos
; del comercio ante desinstalaciones o reinstalaciones accidentales.

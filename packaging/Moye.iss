#define ProductName "墨页"
#define EnglishName "MoTex"
#define ExecutableName "Moye.exe"

[Setup]
AppId={{D5640E24-B383-47DC-844A-53AD1692A194}
AppName={#ProductName}
AppVersion={#ProductVersion}
VersionInfoVersion={#ProductVersion}
VersionInfoProductName={#EnglishName}
VersionInfoDescription={#ProductName}（{#EnglishName}）安装程序
DefaultDirName={code:DefaultMoyeDir}
UsePreviousAppDir=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#ExecutableName}
SetupIconFile=MoTex.ico
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=yes
CloseApplicationsFilter=Moye.exe
RestartApplications=no

[Languages]
Name: "zh"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Dirs]
Name: "{app}\programdata"; Flags: uninsneveruninstall
Name: "{app}\工程"; Flags: uninsneveruninstall

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\template\*"; DestDir: "{app}\template"; Flags: recursesubdirs createallsubdirs onlyifdoesntexist uninsneveruninstall
Source: "{userappdata}\Moye\settings.json"; DestDir: "{app}\programdata"; Flags: external skipifsourcedoesntexist onlyifdoesntexist uninsneveruninstall
Source: "{userappdata}\Moye\draft.json"; DestDir: "{app}\programdata"; Flags: external skipifsourcedoesntexist onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{userprograms}\{#ProductName}"; Filename: "{app}\{#ExecutableName}"; WorkingDir: "{app}"; AppUserModelID: "Moye.Research"
Name: "{userdesktop}\{#ProductName}"; Filename: "{app}\{#ExecutableName}"; WorkingDir: "{app}"; AppUserModelID: "Moye.Research"; Tasks: desktopicon

[Run]
Filename: "{app}\{#ExecutableName}"; Description: "{cm:LaunchProgram,{#ProductName}}"; Flags: nowait postinstall skipifsilent

[Code]
function DefaultMoyeDir(Param: string): string;
begin
  if DirExists('D:\program') then
    Result := 'D:\program\墨页'
  else
    Result := ExpandConstant('{localappdata}\Programs\墨页');
end;
